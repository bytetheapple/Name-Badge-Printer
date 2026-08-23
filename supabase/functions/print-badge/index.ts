// External print API: lets another app queue a name-badge on the shared print
// service. Authenticated by an API key (x-api-key header), so callers never
// need Supabase credentials. Deploy with verify_jwt = false (see config.toml).
//
// Keys are per organization (api_keys, hash-only) and the key alone decides
// which org a caller can see and print to. The old project-wide PRINT_API_KEY
// still works while it is the only organization — it cannot stay honest beyond
// that, so it is refused once a second org exists rather than guessing.
//
// Actions (POST JSON):
//   { first_name, last_name?, pronouns?, printer?, header_image_base64? }
//                                               -> queue a badge, returns job_id
//   { action: "status", job_id }                -> { status, error }
//   { action: "printers" }                      -> list available printers
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const API_KEY = Deno.env.get("PRINT_API_KEY") ?? "";

const HEADER_BUCKET = "badge-headers";
const MAX_HEADER_BYTES = 2_000_000;

// Decode a base64 (optionally data-URI) header image, store it in the public
// badge-headers bucket (content-addressed so re-sends dedupe), and return its
// public URL. Throws on malformed input or an over-size image.
async function storeHeaderImage(b64: string): Promise<string> {
  const raw = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bytes = Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0));
  if (bytes.length === 0) throw new Error("empty image");
  if (bytes.length > MAX_HEADER_BYTES) throw new Error("header image too large (max 2 MB)");
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPng && !isJpeg) throw new Error("header image must be PNG or JPEG");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const ext = isPng ? "png" : "jpg";
  const path = `${hash}.${ext}`;
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${HEADER_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": isPng ? "image/png" : "image/jpeg",
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!up.ok && up.status !== 409) throw new Error("could not store header image");
  return `${SUPABASE_URL}/storage/v1/object/public/${HEADER_BUCKET}/${path}`;
}

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The org this caller may act on, or null if the key is not usable. */
async function resolveApiOrg(key: string): Promise<string | null> {
  const hash = await sha256Hex(key);
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${hash}&revoked_at=is.null&select=id,org_id`,
    { headers: restHeaders },
  );
  if (res.ok) {
    const rows = await res.json();
    if (rows.length) {
      // Best-effort usage stamp; never block a print on it.
      fetch(`${SUPABASE_URL}/rest/v1/api_keys?id=eq.${rows[0].id}`, {
        method: "PATCH",
        headers: restHeaders,
        body: JSON.stringify({ last_used_at: new Date().toISOString() }),
      }).catch(() => {});
      return rows[0].org_id as string;
    }
  }

  // Legacy project-wide key: only meaningful while there is one organization.
  if (!API_KEY || key !== API_KEY) return null;
  const orgs = await fetch(`${SUPABASE_URL}/rest/v1/organizations?select=id&limit=2`, {
    headers: restHeaders,
  });
  const rows = orgs.ok ? await orgs.json() : [];
  return rows.length === 1 ? (rows[0].id as string) : null;
}

async function listPrinters(orgId: string) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/printers?org_id=eq.${orgId}&select=id,name,location&order=created_at.asc`,
    { headers: restHeaders },
  );
  return (await res.json()) as Array<{ id: string; name: string; location: string | null }>;
}

// Resolve a printer reference (id or name) within this caller's org. An id from
// another org resolves to nothing rather than printing there.
async function resolvePrinter(orgId: string, printer: string | undefined): Promise<string | null> {
  const rows = await listPrinters(orgId);
  if (printer && UUID_RE.test(printer)) {
    return rows.some((r) => r.id === printer) ? printer : null;
  }
  if (printer) {
    const match = rows.find((r) => r.name.toLowerCase() === printer.toLowerCase());
    return match?.id ?? null;
  }
  return rows[0]?.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const presented = req.headers.get("x-api-key")?.trim() ?? "";
  const orgId = presented ? await resolveApiOrg(presented) : null;
  if (!orgId) return json({ ok: false, error: "Unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  if (body.action === "printers") {
    return json({ ok: true, printers: await listPrinters(orgId) });
  }

  if (body.action === "status") {
    const jobId = String(body.job_id ?? "");
    if (!UUID_RE.test(jobId)) return json({ ok: false, error: "Invalid job_id" }, 400);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/print_jobs?id=eq.${jobId}&org_id=eq.${orgId}&select=status,error`,
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

  const printerId = await resolvePrinter(orgId, body.printer ? String(body.printer) : undefined);
  if (!printerId) {
    return json({ ok: false, error: "No matching printer (check the 'printer' value)" }, 400);
  }

  // Optional per-job custom header graphic (base64). Overrides the printer's
  // configured header; omit to use the printer default / bundled logo.
  let headerImageUrl: string | null = null;
  const headerB64 = String(body.header_image_base64 ?? "");
  if (headerB64) {
    try {
      headerImageUrl = await storeHeaderImage(headerB64);
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, 400);
    }
  }

  const jobRes = await fetch(`${SUPABASE_URL}/rest/v1/print_jobs`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify({
      org_id: orgId,
      type: "badge",
      status: "queued",
      printer_id: printerId,
      first_name: first,
      last_name: last || null,
      pronouns: pronouns || null,
      header_image_url: headerImageUrl,
    }),
  });
  if (!jobRes.ok) return json({ ok: false, error: "Could not queue the print job" }, 500);
  const [job] = await jobRes.json();
  return json({ ok: true, job_id: job.id, status: "queued" });
});
