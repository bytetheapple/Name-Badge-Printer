// Pushes a form entry into the existing Google Form by POSTing to its public
// formResponse endpoint. The form's response URL and field ids come from secrets
// so they can change without a code edit. Updates the entry's google_sync_status.
//
// Secrets (set with `supabase secrets set ...`):
//   GOOGLE_FORM_RESPONSE_URL  https://docs.google.com/forms/d/e/<FORM_ID>/formResponse
//   GOOGLE_ENTRY_NAME         entry.<id>   (required)
//   GOOGLE_ENTRY_PHONE        entry.<id>   (optional)
//   GOOGLE_ENTRY_EMAIL        entry.<id>   (optional)
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FORM_URL = Deno.env.get("GOOGLE_FORM_RESPONSE_URL") ?? "";
const F_NAME = Deno.env.get("GOOGLE_ENTRY_NAME") ?? "";
const F_PHONE = Deno.env.get("GOOGLE_ENTRY_PHONE") ?? "";
const F_EMAIL = Deno.env.get("GOOGLE_ENTRY_EMAIL") ?? "";

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

async function setStatus(entryId: string, fields: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify(fields),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }
  const entryId = String(body.entry_id ?? "");
  if (!entryId) return json({ ok: false, error: "entry_id required" }, 400);

  if (!FORM_URL || !F_NAME) {
    // Not configured yet — leave the entry pending rather than marking it failed.
    return json({ ok: false, error: "Google sync is not configured" });
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}&select=*`,
    { headers: restHeaders },
  );
  const rows = await res.json();
  if (!rows.length) return json({ ok: false, error: "entry not found" }, 404);
  const entry = rows[0];

  const form = new URLSearchParams();
  form.set(F_NAME, entry.name ?? "");
  if (F_PHONE && entry.phone) form.set(F_PHONE, entry.phone);
  if (F_EMAIL && entry.email) form.set(F_EMAIL, entry.email);

  try {
    const gres = await fetch(FORM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (gres.ok) {
      await setStatus(entryId, {
        google_sync_status: "sent",
        google_synced_at: new Date().toISOString(),
        google_error: null,
      });
      return json({ ok: true, status: "sent" });
    }
    const err = `Google returned HTTP ${gres.status}`;
    await setStatus(entryId, { google_sync_status: "failed", google_error: err });
    return json({ ok: false, error: err });
  } catch (e) {
    const err = String(e).slice(0, 300);
    await setStatus(entryId, { google_sync_status: "failed", google_error: err });
    return json({ ok: false, error: err });
  }
});
