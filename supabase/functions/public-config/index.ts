// Public read of the settings the visitor form needs (just the selfie mode).
// Reads with service_role and returns only the safe field.
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/app_settings?id=eq.1&select=selfie_mode`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    const rows = await res.json();
    return json({ ok: true, selfie_mode: rows[0]?.selfie_mode ?? "off" });
  } catch {
    return json({ ok: true, selfie_mode: "off" });
  }
});
