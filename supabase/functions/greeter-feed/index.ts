// Recent visitor sign-ins for the greeter portal.
//
// A greeter cannot read form_entries directly (the role is excluded from
// auth_org_ids), so this is their only way in. It returns just what the desk
// needs — name, when, and whether a photo/licence is available to view — and
// checks the caller is a greeter, admin or owner of the org it is asked about.
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const REST = `${SUPABASE_URL}/rest/v1`;
const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in caller, from their JWT — never from the request body. */
async function callerOf(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return typeof user?.id === "string" ? user.id : null;
}

/** The caller's role in one org, from the database. */
async function roleInOrg(userId: string, orgId: string): Promise<string | null> {
  const res = await fetch(
    `${REST}/memberships?org_id=eq.${orgId}&user_id=eq.${userId}&select=role`,
    { headers: restHeaders },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? String(rows[0].role) : null;
}

const MAY_SEE = new Set(["greeter", "staff", "admin", "owner"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const caller = await callerOf(req);
  if (!caller) return json({ ok: false, error: "Not signed in" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }
  const orgId = String(body.org_id ?? "").trim();
  if (!UUID_RE.test(orgId)) return json({ ok: false, error: "Invalid organization" }, 400);

  const role = await roleInOrg(caller, orgId);
  if (!role || !MAY_SEE.has(role)) {
    return json({ ok: false, error: "You cannot view this desk" }, 403);
  }

  // The org's name, for the portal header.
  const orgRes = await fetch(`${REST}/organizations?id=eq.${orgId}&select=name`, {
    headers: restHeaders,
  });
  const orgName = orgRes.ok ? (await orgRes.json())[0]?.name ?? null : null;

  // The most recent visitor sign-ins. Visitors only — a member does not get
  // checked in at the desk — and a bounded, recent window, which is also all
  // the retention policy keeps images for.
  const res = await fetch(
    `${REST}/form_entries?org_id=eq.${orgId}&visitor_type=eq.visitor` +
      `&order=created_at.desc&limit=60` +
      `&select=id,first_name,last_name,created_at,selfie_file_id,license_file_id,` +
      `selfie_status,license_status,checked_in_at`,
    { headers: restHeaders },
  );
  if (!res.ok) return json({ ok: false, error: "Could not read sign-ins" }, 500);
  const rows = await res.json() as Array<Record<string, unknown>>;

  const visitors = rows.map((r) => ({
    id: String(r.id),
    first_name: String(r.first_name ?? ""),
    last_name: String(r.last_name ?? ""),
    created_at: String(r.created_at ?? ""),
    // A file id present means the image is still in Drive (retention nulls it
    // on deletion). The status tells a pending/failed upload from a real one.
    has_selfie: r.selfie_file_id != null,
    has_license: r.license_file_id != null,
    selfie_status: String(r.selfie_status ?? "skipped"),
    license_status: String(r.license_status ?? "skipped"),
    checked_in: r.checked_in_at != null,
  }));

  return json({ ok: true, org_name: orgName, visitors });
});
