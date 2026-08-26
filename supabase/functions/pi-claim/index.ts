// A print server claiming its credential, once, on first boot.
//
// The only endpoint in the system a device calls before it has any identity,
// so it is deliberately tiny: one string in, one credential out, no session, no
// state, nothing it can be persuaded to do twice. Everything that decides
// anything lives in claim_pi_device().
//
// Deploy with verify_jwt = false — the caller is a Raspberry Pi on a bench with
// no account and no key.
//
// Request  (POST): { claim_code: "gbc_…" }
// Response:        { ok, serial, bridge_token } | { ok: false, error }
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Long enough to be unguessable, short enough to reject junk before hashing. */
const CODE_RE = /^gbc_[0-9a-f]{64}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  const code = String(body.claim_code ?? "").trim();
  // Shape-checked here so a malformed guess never reaches the database, and so
  // the error a human sees names the actual problem.
  if (!CODE_RE.test(code)) {
    return json({ ok: false, error: "That does not look like a claim code." }, 400);
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_pi_device`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_code: code }),
  });
  if (!res.ok) return json({ ok: false, error: "Could not reach the registry." }, 502);

  const result = await res.json();
  // A refusal is a 200 with ok:false — the request was understood, and the
  // installer script prints the reason rather than a status code.
  return json(result ?? { ok: false, error: "No answer from the registry." });
});
