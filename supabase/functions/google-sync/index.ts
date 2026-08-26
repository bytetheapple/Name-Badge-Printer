// Pushes a form entry into a Google Form by POSTing to its public formResponse
// endpoint, and updates the entry's google_sync_status.
//
// The form URL and field ids come from the entry's own organization
// (integrations, kind 'google_form'), and from nowhere else. An org that has
// not configured it syncs nowhere rather than inheriting anyone's form.
import { corsHeaders, json } from "../_shared/cors.ts";
import { orgOfEntry, resolveSettings } from "../_shared/integration.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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

  const orgId = await orgOfEntry(entryId);
  const settings = await resolveSettings(orgId, "google_form");

  const FORM_URL = String(settings?.config.response_url ?? "");
  const F_FIRST = String(settings?.config.entry_first ?? "");
  const F_LAST = String(settings?.config.entry_last ?? "");
  const F_PHONE = String(settings?.config.entry_phone ?? "");
  const COLLECT_EMAIL = Boolean(settings?.config.collect_email);
  const EXTRA_FIELDS = (settings?.config.extra_fields ?? {}) as Record<string, string>;

  if (!FORM_URL || !F_FIRST) {
    // Not configured for this org — leave the entry pending rather than marking
    // it failed, which is what the admin's "resync" button relies on.
    return json({ ok: false, error: "Google sync is not configured for this organization" });
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}&select=*`,
    { headers: restHeaders },
  );
  const rows = await res.json();
  if (!rows.length) return json({ ok: false, error: "entry not found" }, 404);
  const entry = rows[0];

  const form = new URLSearchParams();
  form.set(F_FIRST, entry.first_name ?? "");
  if (F_LAST && entry.last_name) form.set(F_LAST, entry.last_name);
  if (F_PHONE && entry.phone) form.set(F_PHONE, entry.phone);
  if (COLLECT_EMAIL && entry.email) form.set("emailAddress", entry.email);
  for (const [key, value] of Object.entries(EXTRA_FIELDS)) form.set(key, String(value));

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
