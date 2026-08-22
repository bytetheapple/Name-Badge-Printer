// Report the outcome of a claimed print job.
//
// Request (POST, header `x-bridge-key`):
//   { job_id, status: "printed" | "failed", error?: string }
//
// The update is filtered by the bridge's own org_id, so a bridge cannot close
// out — or corrupt — another tenant's job even if it knows the id.
import { corsHeaders, json } from "../_shared/cors.ts";
import { authenticateBridge, REST, restHeaders } from "../_shared/bridge-auth.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const bridge = await authenticateBridge(req);
  if (!bridge) return json({ ok: false, error: "Unknown or revoked bridge key" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  const jobId = String(body.job_id ?? "");
  const status = String(body.status ?? "");
  if (!UUID_RE.test(jobId)) return json({ ok: false, error: "Invalid job id" }, 400);
  if (status !== "printed" && status !== "failed") {
    return json({ ok: false, error: "status must be 'printed' or 'failed'" }, 400);
  }

  const fields: Record<string, unknown> = { status };
  if (status === "printed") fields.printed_at = new Date().toISOString();
  else fields.error = String(body.error ?? "").slice(0, 500);

  const res = await fetch(
    `${REST}/print_jobs?id=eq.${jobId}&org_id=eq.${bridge.org_id}`,
    {
      method: "PATCH",
      headers: { ...restHeaders, Prefer: "return=representation" },
      body: JSON.stringify(fields),
    },
  );
  if (!res.ok) return json({ ok: false, error: "Could not update the job" }, 500);

  const rows = await res.json();
  if (!rows.length) return json({ ok: false, error: "Job not found for this bridge" }, 404);

  return json({ ok: true, job_id: jobId, status });
});
