// One call per bridge tick: heartbeat, printer status report, and the next job.
//
// Everything is scoped to the org the bridge token resolves to. The bridge
// never names an org, and a printer id it sends is only ever used as a filter
// against its own org's printers — never as authority.
//
// Request  (POST, header `x-bridge-key`):
//   { printers?:   [{ id, reachable, media_type, media_width, error_state }],
//     discovered?: [{ ip, mac, model, node_name }] }
// Response:
//   { ok, config: {...}, printers: [...], job: {...} | null, scan: boolean }
//
// `scan` asks the bridge to look for printers on its LAN and report them in
// `discovered` on a later poll. It is only ever true just after an admin asks,
// because a subnet sweep every two seconds would be absurd — and the bridge is
// the only thing that can see those printers at all, since they are on the
// customer's network.
// The returned job is already claimed (status -> printing); report the outcome
// to bridge-complete.
import { corsHeaders, json } from "../_shared/cors.ts";
import {
  authenticateBridge,
  bridgeAllowsPrinter,
  printerFilter,
  REST,
  restHeaders,
} from "../_shared/bridge-auth.ts";

const nowIso = () => new Date().toISOString();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const bridge = await authenticateBridge(req);
  if (!bridge) return json({ ok: false, error: "Unknown or revoked bridge key" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // A bare poll with no body is fine.
  }

  const now = nowIso();

  // ---- heartbeat -----------------------------------------------------------
  await fetch(`${REST}/bridge_tokens?id=eq.${bridge.id}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({ last_seen: now }),
  });

  // The org-wide heartbeat the admin Status panel reads. A freshly provisioned
  // org may not have its row yet, so create it if the update touched nothing.
  const beat = await fetch(`${REST}/printer_status?org_id=eq.${bridge.org_id}`, {
    method: "PATCH",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify({ bridge_last_seen: now }),
  });
  if (beat.ok && (await beat.json()).length === 0) {
    await fetch(`${REST}/printer_status`, {
      method: "POST",
      headers: restHeaders,
      body: JSON.stringify({ org_id: bridge.org_id, bridge_last_seen: now }),
    });
  }

  // ---- printer status reported by the bridge -------------------------------
  const reported = Array.isArray(body.printers) ? body.printers : [];
  for (const p of reported) {
    const row = p as Record<string, unknown>;
    const id = String(row.id ?? "");
    if (!id || !bridgeAllowsPrinter(bridge, id)) continue;
    // org_id in the filter is what stops a bridge writing to another tenant's
    // printer even if it somehow learned the id.
    await fetch(`${REST}/printers?id=eq.${id}&org_id=eq.${bridge.org_id}`, {
      method: "PATCH",
      headers: restHeaders,
      body: JSON.stringify({
        reachable: Boolean(row.reachable),
        media_type: row.media_type ?? null,
        media_width: row.media_width ?? null,
        error_state: row.error_state ?? null,
        last_checked: now,
      }),
    });
  }

  // ---- scan results the bridge is reporting back ---------------------------
  const discovered = Array.isArray(body.discovered) ? body.discovered : [];
  if (discovered.length) {
    const rows = discovered
      .map((d) => d as Record<string, unknown>)
      .filter((d) => typeof d.ip === "string" && d.ip)
      .map((d) => ({
        org_id: bridge.org_id,
        ip: String(d.ip),
        mac: d.mac ? String(d.mac) : null,
        model: d.model ? String(d.model) : null,
        node_name: d.node_name ? String(d.node_name) : null,
        last_seen: now,
      }));
    if (rows.length) {
      // on_conflict keeps first_seen from the original row, so an address that
      // keeps turning up reads as "seen since", not "found again just now".
      await fetch(`${REST}/discovered_printers?on_conflict=org_id,ip`, {
        method: "POST",
        headers: { ...restHeaders, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(rows),
      });
    }
  }

  // ---- has an admin asked for a scan? --------------------------------------
  // Clearing the request as we hand it over means one ask produces one scan,
  // even if several bridges poll for the same org.
  let scan = false;
  const askRes = await fetch(
    `${REST}/printer_status?org_id=eq.${bridge.org_id}&scan_requested_at=not.is.null` +
      `&select=scan_requested_at`,
    { headers: restHeaders },
  );
  if (askRes.ok) {
    const rows = await askRes.json();
    if (rows.length) {
      // Ignore a stale request: a bridge that was offline for an hour should
      // not start sweeping the moment it reappears.
      const asked = new Date(rows[0].scan_requested_at).getTime();
      scan = Date.now() - asked < 5 * 60 * 1000;
      await fetch(`${REST}/printer_status?org_id=eq.${bridge.org_id}`, {
        method: "PATCH",
        headers: restHeaders,
        body: JSON.stringify({ scan_requested_at: null }),
      });
    }
  }

  // ---- what the bridge needs to render -------------------------------------
  const cfgRes = await fetch(
    `${REST}/printer_config?org_id=eq.${bridge.org_id}&select=label_media,dpi,badge_template`,
    { headers: restHeaders },
  );
  const cfgRows = cfgRes.ok ? await cfgRes.json() : [];
  const config = cfgRows[0] ?? {};

  const printersRes = await fetch(
    `${REST}/printers?org_id=eq.${bridge.org_id}${printerFilter(bridge)}` +
      `&select=id,name,printer_ip,port,header_image_url&order=created_at.asc`,
    { headers: restHeaders },
  );
  const printers = printersRes.ok ? await printersRes.json() : [];

  // ---- claim the next job --------------------------------------------------
  const allowed = printers.map((p: { id: string }) => p.id);
  let job: Record<string, unknown> | null = null;

  if (allowed.length) {
    const queued = await fetch(
      `${REST}/print_jobs?org_id=eq.${bridge.org_id}&status=eq.queued` +
        `&printer_id=in.(${allowed.join(",")})&order=created_at.asc&limit=1&select=*`,
      { headers: restHeaders },
    );
    const candidates = queued.ok ? await queued.json() : [];
    if (candidates.length) {
      const c = candidates[0];
      // status=eq.queued in the filter is the atomic guard: if another bridge
      // took it first, zero rows match and we simply poll again.
      const claim = await fetch(
        `${REST}/print_jobs?id=eq.${c.id}&status=eq.queued&org_id=eq.${bridge.org_id}`,
        {
          method: "PATCH",
          headers: { ...restHeaders, Prefer: "return=representation" },
          body: JSON.stringify({
            status: "printing",
            claimed_at: now,
            attempts: (c.attempts ?? 0) + 1,
          }),
        },
      );
      const claimed = claim.ok ? await claim.json() : [];
      if (claimed.length) job = claimed[0];
    }
  }

  // Resolve the name here so the bridge needs no access to form_entries.
  if (job && job.type !== "test" && !job.first_name && job.entry_id) {
    const entryRes = await fetch(
      `${REST}/form_entries?id=eq.${job.entry_id}&org_id=eq.${bridge.org_id}` +
        `&select=first_name,last_name,pronouns`,
      { headers: restHeaders },
    );
    const entry = entryRes.ok ? (await entryRes.json())[0] : null;
    if (entry) {
      job = {
        ...job,
        first_name: entry.first_name,
        last_name: entry.last_name,
        pronouns: job.pronouns ?? entry.pronouns,
      };
    }
  }

  return json({ ok: true, config, printers, job, scan });
});
