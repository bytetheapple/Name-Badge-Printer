// External print API: lets another app queue a name-badge on the shared print
// service. Authenticated by a shared key (x-api-key header), so callers never
// need Supabase credentials. Deploy with verify_jwt = false (see config.toml).
//
// Actions (POST JSON):
//   { first_name, last_name?, printer? }        -> queue a badge, returns job_id
//   { action: "status", job_id }                -> { status, error }
//   { action: "printers" }                      -> list available printers
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API_KEY = Deno.env.get("PRINT_API_KEY") ?? "";

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listPrinters() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/printers?select=id,name,location&order=created_at.asc`,
    { headers: restHeaders },
  );
  return (await res.json()) as Array<{ id: string; name: string; location: string | null }>;
}

// Resolve a printer reference (id or name) to a printer_id. Defaults to the
// first printer when none is given.
async function resolvePrinter(printer: string | undefined): Promise<string | null> {
  if (printer && UUID_RE.test(printer)) return printer;
  const rows = await listPrinters();
  if (printer) {
    const match = rows.find((r) => r.name.toLowerCase() === printer.toLowerCase());
    return match?.id ?? null;
  }
  return rows[0]?.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  if (!API_KEY || req.headers.get("x-api-key") !== API_KEY) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  if (body.action === "printers") {
    return json({ ok: true, printers: await listPrinters() });
  }

  if (body.action === "status") {
    const jobId = String(body.job_id ?? "");
    if (!UUID_RE.test(jobId)) return json({ ok: false, error: "Invalid job_id" }, 400);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/print_jobs?id=eq.${jobId}&select=status,error`,
      { headers: restHeaders },
    );
    const rows = await res.json();
    if (!rows.length) return json({ ok: false, error: "Job not found" }, 404);
    return json({ ok: true, status: rows[0].status, error: rows[0].error });
  }

  // Default: queue a badge.
  const first = String(body.first_name ?? "").trim();
  const last = String(body.last_name ?? "").trim();
  const pronouns = String(body.pronouns ?? "").trim().slice(0, 40);
  if (!first) return json({ ok: false, error: "first_name is required" }, 400);

  const printerId = await resolvePrinter(body.printer ? String(body.printer) : undefined);
  if (!printerId) {
    return json({ ok: false, error: "No matching printer (check the 'printer' value)" }, 400);
  }

  const jobRes = await fetch(`${SUPABASE_URL}/rest/v1/print_jobs`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify({
      type: "badge",
      status: "queued",
      printer_id: printerId,
      first_name: first,
      last_name: last || null,
      pronouns: pronouns || null,
    }),
  });
  if (!jobRes.ok) return json({ ok: false, error: "Could not queue the print job" }, 500);
  const [job] = await jobRes.json();
  return json({ ok: true, job_id: job.id, status: "queued" });
});
