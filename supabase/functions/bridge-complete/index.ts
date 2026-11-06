// Report the outcome of a claimed print job.
//
// Request (POST, header `x-bridge-key`):
//   { job_id, status: "printed" | "failed", error?: string }
//
// A failed print is not given up on immediately: while the job is less than an
// hour old it is put back to `queued` for another attempt, with a short backoff
// in next_attempt_at so a dead printer is retried about once a minute rather
// than every poll. Only once the job is older than that window is it left
// `failed`. The sign-in record already exists, so a badge that prints late is
// strictly better than one that is dropped — the point of the retry.
//
// The update is filtered by the bridge's own org_id, so a bridge cannot close
// out — or corrupt — another tenant's job even if it knows the id.
import { corsHeaders, json } from "../_shared/cors.ts";
import { authenticateBridge, REST, restHeaders } from "../_shared/bridge-auth.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// How long a failed badge keeps being retried, and the minimum gap between
// tries. Deliberately constants, not per-org settings: the behaviour is simply
// "print it late rather than not at all", which needs no tuning. Test and real
// badges share this — a test queued to a flaky printer should also eventually
// come out.
const RETRY_WINDOW_MS = 60 * 60 * 1000;
const RETRY_BACKOFF_MS = 60 * 1000;

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

  const now = new Date();
  const fields: Record<string, unknown> = {};

  if (status === "printed") {
    fields.status = "printed";
    fields.printed_at = now.toISOString();
    fields.next_attempt_at = null;
  } else {
    // Retry-or-give-up is decided from the job's age, so read created_at first
    // rather than patching blind.
    const look = await fetch(
      `${REST}/print_jobs?id=eq.${jobId}&org_id=eq.${bridge.org_id}&select=created_at`,
      { headers: restHeaders },
    );
    const existing = look.ok ? await look.json() : [];
    if (!existing.length) {
      return json({ ok: false, error: "Job not found for this bridge" }, 404);
    }
    const createdAt = Date.parse(String(existing[0].created_at ?? ""));
    const retry = Number.isFinite(createdAt) &&
      now.getTime() - createdAt < RETRY_WINDOW_MS;
    // Keep the last failure reason either way, so the console can show why a
    // badge is still trying — or why it finally gave up.
    fields.error = String(body.error ?? "").slice(0, 500);
    if (retry) {
      fields.status = "queued";
      fields.next_attempt_at = new Date(now.getTime() + RETRY_BACKOFF_MS).toISOString();
    } else {
      fields.status = "failed";
      fields.next_attempt_at = null;
    }
  }

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

  return json({ ok: true, job_id: jobId, status: fields.status });
});
