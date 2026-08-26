// What version a print server should be running.
//
// Called by the updater on the device — a separate, privileged script, not the
// bridge process. The bridge deliberately cannot write its own code, so it
// cannot update itself; something with more rights has to, and that something
// is small enough to read in one sitting.
//
// Authenticated by the same bridge credential the poller uses, so a device
// that has been revoked stops being told what to run, along with everything
// else.
//
// Request  (POST, header `x-bridge-key`):
//   { hostname: "GuestBadgesServer0004", running?: "abc1234", error?: "…" }
// Response:
//   { ok, ref: "abc1234" | null }
//
// A null ref means do not update — no release is set, and a device stays on
// whatever it was built with. That is the safe reading of "unset": the failure
// mode of doing nothing is a stale device, and of guessing is a fleet-wide
// deploy nobody asked for.
import { corsHeaders, json } from "../_shared/cors.ts";
import { authenticateBridge, REST, restHeaders } from "../_shared/bridge-auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const bridge = await authenticateBridge(req);
  if (!bridge) return json({ ok: false, error: "Unknown or revoked bridge key" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  const hostname = String(body.hostname ?? "").trim();
  if (!hostname) return json({ ok: false, error: "hostname required" }, 400);

  const res = await fetch(`${REST}/rpc/bridge_target_ref`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({
      p_org: bridge.org_id,
      p_hostname: hostname,
      p_running: String(body.running ?? "").trim() || null,
      p_error: String(body.error ?? "").trim() || null,
    }),
  });
  if (!res.ok) return json({ ok: false, error: "Could not read the release" }, 502);

  const out = await res.json();
  return json({ ok: true, ref: (out?.ref ?? null) as string | null });
});
