// Invite someone into an organization, or change/remove an existing member.
//
// The caller is a signed-in admin, identified by their own JWT — never by an
// org_id sent from the browser. The function resolves the caller's membership
// with the service_role key and enforces the §5 rules before touching anything:
//
//   admin -> may invite, change and remove *staff* only
//   owner -> may do the same for any role
//
// Membership rows themselves are also protected by RLS (A2 migration), so this
// is defence in depth rather than the only gate. What genuinely needs the
// service_role key is creating the auth user and sending the invitation email,
// which the anon client cannot do.
//
// Actions (POST JSON):
//   { org_id, email, role }        -> invite (or add an existing user)
//   { action: "set_role", org_id, user_id, role }
//   { action: "remove",   org_id, user_id }
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
// Where an invited user lands to choose a password. The admin app already
// serves this route.
const SITE_URL = Deno.env.get("INVITE_REDIRECT_URL") ?? "";

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLES = ["owner", "admin", "staff"] as const;
type Role = (typeof ROLES)[number];

/** The signed-in user behind this request, or null if the JWT is missing/bad. */
async function callerId(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return typeof user?.id === "string" ? user.id : null;
}

/** The caller's role in one org, from the database — never from the request. */
async function roleInOrg(userId: string, orgId: string): Promise<Role | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/memberships?org_id=eq.${orgId}&user_id=eq.${userId}&select=role`,
    { headers: restHeaders },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? (rows[0].role as Role) : null;
}

/**
 * May `actor` act on a membership whose role is (or would become) `target`?
 * Owners may touch any role; admins only staff. Mirrors the RLS policies.
 */
function mayManage(actor: Role | null, ...targets: (Role | null)[]): boolean {
  if (actor === "owner") return true;
  if (actor !== "admin") return false;
  return targets.every((t) => t === null || t === "staff");
}

/** Look up an auth user by email; null when they have no account yet. */
async function findUserByEmail(email: string): Promise<string | null> {
  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
    { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
  );
  if (!res.ok) return null;
  const body = await res.json();
  const users: Array<{ id: string; email?: string }> = body?.users ?? [];
  const hit = users.find((u) => (u.email ?? "").toLowerCase() === email);
  return hit?.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const caller = await callerId(req);
  if (!caller) return json({ ok: false, error: "Not signed in" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  const orgId = String(body.org_id ?? "").trim();
  if (!UUID_RE.test(orgId)) return json({ ok: false, error: "Invalid organization" }, 400);

  const actor = await roleInOrg(caller, orgId);
  if (actor !== "owner" && actor !== "admin") {
    // Same answer whether they are staff or a stranger: never confirm that an
    // org exists to someone who has no business there.
    return json({ ok: false, error: "You cannot manage members of this organization" }, 403);
  }

  const action = String(body.action ?? "invite");

  // ---------------------------------------------------------------- remove
  if (action === "remove" || action === "set_role") {
    const userId = String(body.user_id ?? "").trim();
    if (!UUID_RE.test(userId)) return json({ ok: false, error: "Invalid user" }, 400);

    const current = await roleInOrg(userId, orgId);
    if (!current) return json({ ok: false, error: "That person is not a member" }, 404);

    if (action === "remove") {
      if (!mayManage(actor, current)) {
        return json({ ok: false, error: `Only an owner can remove an ${current}` }, 403);
      }
      // The last-owner trigger is the real guard; this is the friendly message.
      const del = await fetch(
        `${SUPABASE_URL}/rest/v1/memberships?org_id=eq.${orgId}&user_id=eq.${userId}`,
        { method: "DELETE", headers: restHeaders },
      );
      if (!del.ok) {
        const text = await del.text();
        if (text.includes("last owner")) {
          return json({ ok: false, error: "This is the organization's last owner." }, 409);
        }
        return json({ ok: false, error: "Could not remove that member." }, 500);
      }
      return json({ ok: true, removed: userId });
    }

    const nextRole = String(body.role ?? "") as Role;
    if (!ROLES.includes(nextRole)) return json({ ok: false, error: "Invalid role" }, 400);
    if (!mayManage(actor, current, nextRole)) {
      return json({ ok: false, error: "Only an owner can change owner and admin roles" }, 403);
    }
    const upd = await fetch(
      `${SUPABASE_URL}/rest/v1/memberships?org_id=eq.${orgId}&user_id=eq.${userId}`,
      { method: "PATCH", headers: restHeaders, body: JSON.stringify({ role: nextRole }) },
    );
    if (!upd.ok) {
      const text = await upd.text();
      if (text.includes("last owner")) {
        return json({ ok: false, error: "This is the organization's last owner." }, 409);
      }
      return json({ ok: false, error: "Could not change that role." }, 500);
    }
    return json({ ok: true, user_id: userId, role: nextRole });
  }

  // ---------------------------------------------------------------- invite
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = (String(body.role ?? "staff") || "staff") as Role;
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: "Enter a valid email address." }, 400);
  if (!ROLES.includes(role)) return json({ ok: false, error: "Invalid role" }, 400);
  if (!mayManage(actor, role)) {
    return json({ ok: false, error: "Only an owner can invite an admin or owner." }, 403);
  }

  // Someone with an account already (e.g. a member of another org) is simply
  // added; only a genuinely new person gets an invitation email.
  let userId = await findUserByEmail(email);
  let invited = false;

  if (!userId) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/invite`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        SITE_URL ? { email, redirect_to: SITE_URL } : { email },
      ),
    });
    if (!res.ok) {
      const text = await res.text();
      // Also to the log: the body reaches the browser, but a bare 502 in the
      // dashboard's function log is a dead end.
      console.error(`invite failed for ${email}: ${res.status} ${text.slice(0, 300)}`);
      return json({
        ok: false,
        error: "Could not send the invitation email. Check the project's SMTP settings.",
        detail: text.slice(0, 300),
      }, 502);
    }
    userId = (await res.json())?.id ?? null;
    invited = true;
    if (!userId) return json({ ok: false, error: "The invitation went out but no account came back." }, 500);
  }

  if (await roleInOrg(userId, orgId)) {
    return json({ ok: false, error: "That person is already a member of this organization." }, 409);
  }

  const ins = await fetch(`${SUPABASE_URL}/rest/v1/memberships`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ org_id: orgId, user_id: userId, role }),
  });
  if (!ins.ok) return json({ ok: false, error: "Could not add that member." }, 500);

  return json({ ok: true, user_id: userId, email, role, invited });
});
