// One call per bridge tick: heartbeat, printer status report, and the next job.
//
// Everything is scoped to the org the bridge token resolves to. The bridge
// never names an org, and a printer id it sends is only ever used as a filter
// against its own org's printers — never as authority.
//
// Request  (POST, header `x-bridge-key`):
//   { printers?:   [{ id, reachable, media_type, media_width, error_state,
//                     unreachable_reason, printer_ip?, mac?, wired_mac? }],
//     network?:    { interfaces: [{name, kind, state, ip, ssid?, signal?}],
//                    wifi_radio },   // which networks this server is on
//     provision_result?: { session_id, task, ok, next_state, data, log, error },
//     network_result?: { id, ok, error, log },   // a wireless change was tried
//     rotation_error?: "…" }   // could not store the replacement credential
// Response:
//   { ok, suspended?: true, config: {...}, printers: [...], job: {...} | null,
//     provision: {...} | null, network_request: {...} | null,
//     bridge_token?: "nbk_…" }
//
// `network_request` is {id, ssid, passphrase} — a wireless network an admin
// asked this server to join. The passphrase is read out of Vault here and
// destroyed as it is handed over: it exists in the response and nowhere else.
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
import { rpc } from "../_shared/rpc.ts";

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
  //
  // The network description rides along with the heartbeat: it is the server
  // describing itself, and it goes stale the same way the timestamp does.
  // Written only when the bridge sent one, so an older bridge that knows
  // nothing about this leaves the column alone rather than blanking it.
  const netState = body.network;
  const describesNetwork =
    netState !== null && typeof netState === "object" && !Array.isArray(netState);
  const heartbeat: Record<string, unknown> = { bridge_last_seen: now };
  if (describesNetwork) heartbeat.network = netState;

  const beat = await fetch(`${REST}/printer_status?org_id=eq.${bridge.org_id}`, {
    method: "PATCH",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify(heartbeat),
  });
  if (beat.ok && (await beat.json()).length === 0) {
    await fetch(`${REST}/printer_status`, {
      method: "POST",
      headers: restHeaders,
      body: JSON.stringify({ org_id: bridge.org_id, ...heartbeat }),
    });
  }

  // The version the device says it is running, from the device itself.
  //
  // The updater reports one too, but only when it runs, so a fleet whose
  // updater was broken reported nothing and that was indistinguishable from a
  // device that had simply not checked in yet. A bridge that is polling is by
  // definition running, so this is the one report that cannot be stale.
  //
  // Deliberately not bridge_target_ref(), which is what the updater calls:
  // that clears update_error unconditionally, and a poll arriving seconds
  // later would wipe a failure before anyone read it. Matched on hostname for
  // the same reason as that function — the bridge token is replaced on every
  // rotation, so a link through it would break on the first renewal.
  const version = String(body.version ?? "").trim();
  const host = String(body.hostname ?? "").trim();
  if (version && host) {
    await fetch(
      `${REST}/pi_devices?serial=eq.${encodeURIComponent(host)}` +
        `&org_id=eq.${bridge.org_id}`,
      {
        method: "PATCH",
        headers: restHeaders,
        body: JSON.stringify({ running_ref: version, last_seen: now }),
      },
    );
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
        // Why, not just whether. Defaulted to null like the fields above
        // rather than spread in conditionally: this must clear the moment a
        // printer answers, or a card keeps explaining a fault that is over.
        // Truncated because it reaches a UI, and the bridge composes it.
        unreachable_reason:
          typeof row.unreachable_reason === "string" && row.unreachable_reason
            ? row.unreachable_reason.slice(0, 500)
            : null,
        last_checked: now,
        // Only when the bridge actually says so. These are spread in rather
        // than defaulted to null like the fields above, because a null here
        // means "not reported this tick", not "this printer has no MAC" —
        // writing the null would erase the identifier on the very next poll.
        ...(typeof row.printer_ip === "string" && row.printer_ip
          ? { printer_ip: row.printer_ip }
          : {}),
        ...(typeof row.mac === "string" && row.mac ? { mac: row.mac } : {}),
        ...(typeof row.wired_mac === "string" && row.wired_mac
          ? { wired_mac: row.wired_mac }
          : {}),
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
      network_request: null,
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

  // ---- a wireless change the bridge has tried -------------------------------
  if (body.network_result && typeof body.network_result === "object") {
    const r = body.network_result as Record<string, unknown>;
    const id = String(r.id ?? "");
    if (id) {
      // org_id in the filter is what stops one bridge closing another
      // tenant's request, the same guard the printer report uses.
      await fetch(
        `${REST}/server_network_requests?id=eq.${id}&org_id=eq.${bridge.org_id}`,
        {
          method: "PATCH",
          headers: restHeaders,
          body: JSON.stringify({
            state: r.ok ? "applied" : "failed",
            error: r.ok ? null : String(r.error ?? "That change did not finish.").slice(0, 1000),
            updated_at: now,
          }),
        },
      );
      // Spent either way. A passphrase that failed is no less the customer's,
      // and a retry collects it again from the person who knows it.
      await rpc("clear_server_network_secret", { p_id: id });
    }
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
      `&select=id,name,printer_ip,port,mac,wired_mac,header_image_url,badge_header,` +
      `badge_subtitle,badge_header_mode` +
      `&order=created_at.asc`,
    { headers: restHeaders },
  );
  const printers = printersRes.ok ? await printersRes.json() : [];

  // ---- a wireless network this server has been asked to join ---------------
  // Handed over before jobs are claimed: the bridge blocks while it applies
  // one, and claiming a job it will not get to for two minutes is worse than
  // leaving it queued.
  //
  // `sent` rather than deleting on handover, so a bridge that dies mid-change
  // does not silently lose the request — but a `sent` older than the lease is
  // offered again, because the alternative is an operator watching a spinner
  // for ever after a power cut.
  let networkRequest: Record<string, unknown> | null = null;
  const NETWORK_LEASE_MS = 5 * 60 * 1000;
  const pendingRes = await fetch(
    `${REST}/server_network_requests?org_id=eq.${bridge.org_id}` +
      `&state=in.(pending,sent)&order=created_at.asc&limit=1&select=id,ssid,state,sent_at`,
    { headers: restHeaders },
  );
  const pending = pendingRes.ok ? await pendingRes.json() : [];
  if (pending.length) {
    const req = pending[0];
    const sentAt = req.sent_at ? Date.parse(String(req.sent_at)) : 0;
    const stale = req.state === "sent" && Date.now() - sentAt > NETWORK_LEASE_MS;
    if (req.state === "pending" || stale) {
      // state=in.(...) in the filter is the atomic guard, the same one the job
      // claim uses: if another poll took it first, zero rows match.
      const claim = await fetch(
        `${REST}/server_network_requests?id=eq.${req.id}&org_id=eq.${bridge.org_id}` +
          `&state=in.(pending,sent)`,
        {
          method: "PATCH",
          headers: { ...restHeaders, Prefer: "return=representation" },
          body: JSON.stringify({ state: "sent", sent_at: now, updated_at: now }),
        },
      );
      if (claim.ok && (await claim.json()).length) {
        // Read out of Vault and handed over in this response only. An empty
        // passphrase is a real answer: an open network has none.
        const passphrase = await rpc("take_server_network_secret", { p_id: req.id });
        networkRequest = {
          id: req.id,
          ssid: req.ssid,
          passphrase: typeof passphrase === "string" ? passphrase : "",
        };
      }
    }
  }

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

  return json({
    ok: true,
    config,
    printers,
    job,
    provision,
    network_request: networkRequest,
    bridge_token: bridgeToken,
  });
});
