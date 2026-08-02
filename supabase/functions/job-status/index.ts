// Public endpoint the form polls to watch its print job.
// Reads a single job's status with the service_role key (anon has no table access).
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
};

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

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/print_jobs?id=eq.${jobId}&select=status,error`,
    { headers: restHeaders },
  );
  if (!res.ok) return json({ ok: false, error: "Lookup failed" }, 500);

  const rows = await res.json();
  if (!rows.length) return json({ ok: false, error: "Job not found" }, 404);

  return json({ ok: true, status: rows[0].status, error: rows[0].error });
});
