// A greeter confirms (or un-confirms) that they checked a guest in.
//
// Greeters have no direct write to form_entries, so this records it with the
// service role after checking the caller is a greeter/admin/owner of the org the
// entry belongs to.
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
const MAY_SEE = new Set(["greeter", "staff", "admin", "owner"]);

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

async function roleInOrg(userId: string, orgId: string): Promise<string | null> {
  const res = await fetch(
    `${REST}/memberships?org_id=eq.${orgId}&user_id=eq.${userId}&select=role`,
    { headers: restHeaders },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? String(rows[0].role) : null;
}

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
  const entryId = String(body.entry_id ?? "").trim();
  if (!UUID_RE.test(entryId)) return json({ ok: false, error: "Invalid sign-in" }, 400);
  const checkedIn = body.checked_in === true;

  const entryRes = await fetch(
    `${REST}/form_entries?id=eq.${entryId}&select=org_id`,
    { headers: restHeaders },
  );
  if (!entryRes.ok) return json({ ok: false, error: "Could not read sign-in" }, 500);
  const entry = (await entryRes.json())[0];
  if (!entry) return json({ ok: false, error: "Unknown sign-in" }, 404);
  const orgId = String(entry.org_id);

  const role = await roleInOrg(caller, orgId);
  if (!role || !MAY_SEE.has(role)) {
    return json({ ok: false, error: "You cannot check in at this desk" }, 403);
  }

  const patch = await fetch(`${REST}/form_entries?id=eq.${entryId}&org_id=eq.${orgId}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({
      checked_in_at: checkedIn ? new Date().toISOString() : null,
      checked_in_by: checkedIn ? caller : null,
    }),
  });
  if (!patch.ok) return json({ ok: false, error: "Could not record the check-in" }, 500);

  return json({ ok: true, checked_in: checkedIn });
});
