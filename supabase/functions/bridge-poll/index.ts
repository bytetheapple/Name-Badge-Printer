// One call per bridge tick: heartbeat, printer status report, and the next job.
//
// Everything is scoped to the org the bridge token resolves to. The bridge
// never names an org, and a printer id it sends is only ever used as a filter
// against its own org's printers — never as authority.
//
// Request  (POST, header `x-bridge-key`):
//   { printers?:   [{ id, reachable, media_type, media_width, error_state }],
//     provision_result?: { session_id, task, ok, next_state, data, log, error },
//     rotation_error?: "…" }   // could not store the replacement credential
// Response:
//   { ok, suspended?: true, config: {...}, printers: [...], job: {...} | null,
//     provision: {...} | null, bridge_token?: "nbk_…" }
//
// `bridge_token`, when present, is a replacement credential the device must
// store and use from its next poll. Credentials renew themselves because a
// print server has no operator — see _shared/rotation.ts. It is a secret and
// must never be logged.
//
// `provision` is one step of a guided printer setup, already claimed for this
// bridge. The other half of that setup happens in the browser — the steps that
// need someone standing at the printer — and the session row is where the two
// take turns. See _shared/provisioning.ts.
//
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
import { applyResult, claimStep } from "../_shared/provisioning.ts";
import { noteFailure, noteUsed, rotate, rotationDue, sweep, tokenRow } from "../_shared/rotation.ts";
import { orgIsActive } from "../_shared/org.ts";

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

  // ---- is this organization still being served? -----------------------------
  // A suspended org keeps a valid credential — this is not a revocation, and
  // saying "unknown key" would send an operator hunting the wrong problem. The
  // bridge simply gets no work and is told why, and resumes the moment the
  // status goes back.
  if (!(await orgIsActive(bridge.org_id))) {
    return json({
      ok: true,
      suspended: true,
      config: {},
      printers: [],
      job: null,
      provision: null,
    });
  }

  // ---- credential rotation --------------------------------------------------
  // Before anything else: the token that just authenticated is recorded as
  // used, which is what retires whatever it replaced. Revoking on confirmed
  // use rather than on issue is the whole safety of the scheme.
  const token = await tokenRow(bridge.id);
  let bridgeToken: string | undefined;
  if (token) {
    await noteUsed(token, now);

    if (typeof body.rotation_error === "string" && body.rotation_error) {
      // It could not keep the last replacement. Back off rather than mint a
      // fresh one on every poll for ever.
      await noteFailure(token, body.rotation_error, now);
    } else if (rotationDue(token, Date.now())) {
      bridgeToken = (await rotate(token, now)) ?? undefined;
    }
    await sweep();
  }

  // ---- a provisioning step the bridge has finished --------------------------
  // Reported on the poll after it ran rather than through a call of its own:
  // the bridge has one channel to us, and a step that finished is no more
  // urgent than the next tick.
  if (body.provision_result && typeof body.provision_result === "object") {
    await applyResult(bridge.org_id, body.provision_result as Record<string, unknown>, now);
  }

  // ---- what the bridge needs to render -------------------------------------
  const cfgRes = await fetch(
    `${REST}/printer_config?org_id=eq.${bridge.org_id}&select=label_media,dpi,badge_template`,
    { headers: restHeaders },
  );
  const cfgRows = cfgRes.ok ? await cfgRes.json() : [];
  const config = cfgRows[0] ?? {};

  // The organization's name mark, for any printer whose header mode is 'logo'.
  // It travels with the config rather than per printer because it belongs to
  // the org — every printer choosing the logo prints the same one. Null when
  // none is uploaded, and the bridge then prints text instead.
  const logoRes = await fetch(
    `${REST}/app_settings?org_id=eq.${bridge.org_id}&select=logo_url`,
    { headers: restHeaders },
  );
  config.logo_url = logoRes.ok ? ((await logoRes.json())[0]?.logo_url ?? null) : null;

  const printersRes = await fetch(
    `${REST}/printers?org_id=eq.${bridge.org_id}${printerFilter(bridge)}` +
      `&select=id,name,printer_ip,port,header_image_url,badge_header,badge_subtitle,badge_header_mode` +
      `&order=created_at.asc`,
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
        `&select=first_name,last_name,pronouns,visitor_type`,
      { headers: restHeaders },
    );
    const entry = entryRes.ok ? (await entryRes.json())[0] : null;
    if (entry) {
      job = {
        ...job,
        first_name: entry.first_name,
        last_name: entry.last_name,
        pronouns: job.pronouns ?? entry.pronouns,
        // Decides whether the badge prints its header inverted. A reprint
        // carries only entry_id, so it comes through here too and gets the
        // same badge the visitor was handed the first time.
        visitor_type: entry.visitor_type,
      };
    }
  }

  // ---- and the next provisioning step, if a setup is waiting on us ---------
  // Claimed last, so a step's own log lines are never written after the result
  // that closed the previous one.
  const provision = await claimStep(bridge.org_id, now);

  return json({ ok: true, config, printers, job, provision, bridge_token: bridgeToken });
});
