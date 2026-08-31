// Pushes a sign-in into every Google Form the entry's printer is set to feed,
// by POSTing to each form's public formResponse endpoint.
//
// No Google credential is involved: a form response is an unauthenticated POST,
// which is why this works for a congregation that has connected no Google
// account at all. Only selfies need an account.
//
// Destinations come from the entry's own organization and printer and from
// nowhere else. An org that has configured none syncs nowhere rather than
// inheriting anyone's form.
//
// Body: { entry_id, integration_id? }. With integration_id, only that
// destination is attempted — a resend from one row of the expanded pill.
import { corsHeaders, json } from "../_shared/cors.ts";
import { recordDelivery, rollUp, targetsFor } from "../_shared/integration.ts";

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
  const only = body.integration_id ? String(body.integration_id) : null;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}&select=*`,
    { headers: restHeaders },
  );
  const rows = await res.json();
  if (!rows.length) return json({ ok: false, error: "entry not found" }, 404);
  const entry = rows[0];

  const targets = await targetsFor(entryId, "google_form", only);
  if (!targets.length) {
    // Left pending rather than marked failed: nothing has gone wrong, there is
    // simply nowhere to send it, and the admin's resync relies on pending.
    return json({ ok: false, error: "No Google Form destinations for this sign-in" });
  }

  const results: Array<{ ok: boolean; error?: string }> = [];

  for (const t of targets) {
    const FORM_URL = String(t.config.response_url ?? "");
    const F_FIRST = String(t.config.entry_first ?? "");
    const F_LAST = String(t.config.entry_last ?? "");
    const F_PHONE = String(t.config.entry_phone ?? "");
    const COLLECT_EMAIL = Boolean(t.config.collect_email);
    const EXTRA_FIELDS = (t.config.extra_fields ?? {}) as Record<string, string>;

    // Half-configured is this destination's problem, not the others'. Recorded
    // against it so the pill says which one needs attention.
    if (!FORM_URL || !F_FIRST) {
      const err = "Form URL or first-name field is not set";
      await recordDelivery(entryId, t.id, "failed", err);
      results.push({ ok: false, error: `${t.name}: ${err}` });
      continue;
    }

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
        await recordDelivery(entryId, t.id, "sent");
        results.push({ ok: true });
      } else {
        const err = `Google returned HTTP ${gres.status}`;
        await recordDelivery(entryId, t.id, "failed", err);
        results.push({ ok: false, error: `${t.name}: ${err}` });
      }
    } catch (e) {
      const err = String(e).slice(0, 300);
      await recordDelivery(entryId, t.id, "failed", err);
      results.push({ ok: false, error: `${t.name}: ${err}` });
    }
  }

  // The old single column, still written until the expandable pill ships and
  // it can be dropped. Not written at all for a single-destination resend,
  // which would otherwise report the whole entry on one destination's result.
  if (!only) {
    const rolled = rollUp(results);
    await setStatus(entryId, {
      google_sync_status: rolled.status,
      google_synced_at: rolled.status === "sent" ? new Date().toISOString() : null,
      google_error: rolled.error,
    });
  }

  const failed = results.filter((r) => !r.ok);
  return json({
    ok: failed.length === 0,
    sent: results.length - failed.length,
    total: results.length,
    error: failed.length ? failed.map((f) => f.error).join("; ") : undefined,
  });
});
