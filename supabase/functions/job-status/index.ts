// Public endpoint the form polls to watch its print job.
//
// The job id is an unguessable uuid, but when the caller also presents the
// kiosk token it was created under, the lookup is additionally scoped to that
// org — so a job id alone can never be used to probe another tenant.
import { corsHeaders, json } from "../_shared/cors.ts";
import { REST, resolveKiosk, restHeaders } from "../_shared/kiosk.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  const jobId = String(body.job_id ?? "");
  if (!UUID_RE.test(jobId)) return json({ ok: false, error: "Invalid job id" }, 400);

  let scope = "";
  if (body.kiosk_token || body.printer_id) {
    const { kiosk } = await resolveKiosk(body);
    if (kiosk) scope = `&org_id=eq.${kiosk.org_id}`;
  }

  const res = await fetch(
    `${REST}/print_jobs?id=eq.${jobId}${scope}&select=status,error`,
    { headers: restHeaders },
  );
  if (!res.ok) return json({ ok: false, error: "Lookup failed" }, 500);

  const rows = await res.json();
  if (!rows.length) return json({ ok: false, error: "Job not found" }, 404);

  return json({ ok: true, status: rows[0].status, error: rows[0].error });
});
