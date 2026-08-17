// Public endpoint for the QR-code badge form.
// Validates input, creates a form_entries row and a queued print_jobs row using
// the service_role key (so the anon client never needs table access).
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Fire a background sync Edge Function (google-sync / shulcloud-sync) without
// blocking the response.
function triggerSync(fn: string, entryId: string) {
  const task = fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
    body: JSON.stringify({ entry_id: entryId }),
  }).catch(() => {});
  const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(task);
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

  const firstName = String(body.first_name ?? "").trim();
  const lastName = String(body.last_name ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const email = String(body.email ?? "").trim();
  const pronouns = String(body.pronouns ?? "").trim().slice(0, 40);
  const visitorType = String(body.visitor_type ?? "").trim();

  // Additional family/party members: name-only, no contact, no selfie, no sync.
  const additional: Array<{ first_name: string; last_name: string; pronouns: string | null }> = [];
  for (const p of Array.isArray(body.additional) ? body.additional : []) {
    const f = String((p as Record<string, unknown>)?.first_name ?? "").trim();
    const l = String((p as Record<string, unknown>)?.last_name ?? "").trim();
    const pr = String((p as Record<string, unknown>)?.pronouns ?? "").trim().slice(0, 40);
    if (!f && !l) continue; // ignore blank rows
    if (!f || !l) {
      return json({ ok: false, error: "Please enter a first and last name for each person." });
    }
    if (f.length > 60 || l.length > 60) return json({ ok: false, error: "That name is too long." });
    additional.push({ first_name: f, last_name: l, pronouns: pr || null });
  }
  if (additional.length > 12) {
    return json({ ok: false, error: "Too many people in one sign-in." });
  }

  if (!firstName) return json({ ok: false, error: "Please enter your first name." });
  if (!lastName) return json({ ok: false, error: "Please enter your last name." });
  if (visitorType !== "member" && visitorType !== "visitor") {
    return json({ ok: false, error: "Please select Member or Visitor." });
  }
  // Visitors must provide contact details; members only need their name.
  if (visitorType === "visitor" && !phone) {
    return json({ ok: false, error: "Please enter your phone number." });
  }
  if (visitorType === "visitor" && !email) {
    return json({ ok: false, error: "Please enter your email address." });
  }
  if (firstName.length > 60 || lastName.length > 60) {
    return json({ ok: false, error: "That name is too long." });
  }
  if (phone.length > 40) return json({ ok: false, error: "That phone number is too long." });
  if (email && !EMAIL_RE.test(email)) {
    return json({ ok: false, error: "Please enter a valid email address." });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  // Resolve the target printer: the one named in the QR link, or the first one.
  let printerId: string | null = String(body.printer_id ?? "").trim() || null;
  {
    const q = printerId
      ? `id=eq.${printerId}&select=id`
      : `select=id&order=created_at.asc&limit=1`;
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/printers?${q}`, { headers: restHeaders });
    const rows = pr.ok ? await pr.json() : [];
    printerId = rows.length ? rows[0].id : null;
  }
  if (!printerId) return json({ ok: false, error: "No printer is configured." }, 500);

  // A party_id links a family sign-in; null for a lone person.
  const partyId = additional.length ? crypto.randomUUID() : null;

  // 1. Save the primary entry.
  const entryRes = await fetch(`${SUPABASE_URL}/rest/v1/form_entries`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({
      first_name: firstName,
      last_name: lastName || null,
      phone: phone || null,
      email: email || null,
      pronouns: pronouns || null,
      visitor_type: visitorType,
      printer_id: printerId,
      party_id: partyId,
      is_primary: true,
      // Members are recorded but never sent to Google / ShulCloud.
      google_sync_status: visitorType === "member" ? "skipped" : "pending",
      shulcloud_sync_status: visitorType === "member" ? "skipped" : "pending",
      source_ip: ip,
    }),
  });
  if (!entryRes.ok) {
    return json({ ok: false, error: "Could not save your details." }, 500);
  }
  const [entry] = await entryRes.json();

  // 2. Queue the primary print job.
  const jobRes = await fetch(`${SUPABASE_URL}/rest/v1/print_jobs`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({
      entry_id: entry.id,
      printer_id: printerId,
      type: "badge",
      status: "queued",
    }),
  });
  if (!jobRes.ok) {
    return json({ ok: false, error: "Could not start the print." }, 500);
  }
  const [job] = await jobRes.json();
  const jobIds: string[] = [job.id];

  // 3. Additional family members: name-only entries + badges, sync skipped.
  if (additional.length) {
    const memberEntries = additional.map((p) => ({
      first_name: p.first_name,
      last_name: p.last_name,
      pronouns: p.pronouns,
      phone: null,
      email: null,
      visitor_type: visitorType,
      printer_id: printerId,
      party_id: partyId,
      is_primary: false,
      google_sync_status: "skipped",
      shulcloud_sync_status: "skipped",
      source_ip: ip,
    }));
    const meRes = await fetch(`${SUPABASE_URL}/rest/v1/form_entries`, {
      method: "POST",
      headers: restHeaders,
      body: JSON.stringify(memberEntries),
    });
    if (!meRes.ok) return json({ ok: false, error: "Could not save the additional badges." }, 500);
    const memberRows = await meRes.json();
    const memberJobs = memberRows.map((e: { id: string }) => ({
      entry_id: e.id,
      printer_id: printerId,
      type: "badge",
      status: "queued",
    }));
    const mjRes = await fetch(`${SUPABASE_URL}/rest/v1/print_jobs`, {
      method: "POST",
      headers: restHeaders,
      body: JSON.stringify(memberJobs),
    });
    if (!mjRes.ok) return json({ ok: false, error: "Could not queue the additional badges." }, 500);
    for (const j of await mjRes.json()) jobIds.push(j.id);
  }

  // Only the primary (with contact info) is pushed to Google and ShulCloud in
  // the background; members and members-only sign-ins are skipped.
  if (visitorType === "visitor") {
    triggerSync("google-sync", entry.id);
    triggerSync("shulcloud-sync", entry.id);
  }

  return json({ ok: true, job_id: job.id, entry_id: entry.id, job_ids: jobIds });
});
