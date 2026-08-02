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

function triggerGoogleSync(entryId: string) {
  const task = fetch(`${SUPABASE_URL}/functions/v1/google-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
    body: JSON.stringify({ entry_id: entryId }),
  }).catch(() => {});
  // Keep the function alive until the background request completes.
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
  const visitorType = String(body.visitor_type ?? "").trim();

  if (!firstName) return json({ ok: false, error: "Please enter your first name." });
  if (visitorType !== "member" && visitorType !== "visitor") {
    return json({ ok: false, error: "Please select Member or Visitor." });
  }
  if (firstName.length > 60 || lastName.length > 60) {
    return json({ ok: false, error: "That name is too long." });
  }
  if (phone.length > 40) return json({ ok: false, error: "That phone number is too long." });
  if (email && !EMAIL_RE.test(email)) {
    return json({ ok: false, error: "Please enter a valid email address." });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  // 1. Save the entry.
  const entryRes = await fetch(`${SUPABASE_URL}/rest/v1/form_entries`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({
      first_name: firstName,
      last_name: lastName || null,
      phone: phone || null,
      email: email || null,
      visitor_type: visitorType,
      // Members are recorded but never sent to Google.
      google_sync_status: visitorType === "member" ? "skipped" : "pending",
      source_ip: ip,
    }),
  });
  if (!entryRes.ok) {
    return json({ ok: false, error: "Could not save your details." }, 500);
  }
  const [entry] = await entryRes.json();

  // 2. Queue the print job.
  const jobRes = await fetch(`${SUPABASE_URL}/rest/v1/print_jobs`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ entry_id: entry.id, type: "badge", status: "queued" }),
  });
  if (!jobRes.ok) {
    return json({ ok: false, error: "Could not start the print." }, 500);
  }
  const [job] = await jobRes.json();

  // Visitors are pushed to Google in the background (never blocks printing);
  // members are intentionally skipped.
  if (visitorType === "visitor") triggerGoogleSync(entry.id);

  return json({ ok: true, job_id: job.id, entry_id: entry.id });
});
