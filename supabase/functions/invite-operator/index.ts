// Invite a Guest Badges operator.
//
// This exists for one reason: an operator may have no account yet, and
// creating an auth user plus sending the invitation email needs the
// service_role key, which the browser does not have. Everything else about
// operators — listing, re-roling, removing — is a SECURITY DEFINER function in
// the database, so the last-owner guard holds no matter which path is taken.
//
// invite-member cannot be reused. That function invites someone *into an
// organization* and writes a membership, which is precisely what an operator
// must not have: operator access comes from being an operator, so that they
// are absent from a customer's Members tab as a fact rather than as a filter.
//
// The caller is a signed-in operator identified by their own JWT, and must be
// an owner. Never trust a role sent from the browser.
//
//   POST { email, role }   role is "owner" | "support", default "support"
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
// Where an invited operator lands to choose a password. The admin app already
// serves this route.
const SITE_URL = Deno.env.get("INVITE_REDIRECT_URL") ?? "";

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLES = ["owner", "support"] as const;
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

/** The caller's operator role, from the database — never from the request. */
async function operatorRole(userId: string): Promise<Role | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/platform_admins?user_id=eq.${userId}&select=role`,
    { headers: restHeaders },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? (rows[0].role as Role) : null;
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

  // Same answer to a support operator and to a stranger: neither has any
  // business here, and the difference is not worth confirming.
  if ((await operatorRole(caller)) !== "owner") {
    return json({ ok: false, error: "Only an owner can add an operator" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const role = (String(body.role ?? "support") || "support") as Role;
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: "Enter a valid email address." }, 400);
  if (!ROLES.includes(role)) return json({ ok: false, error: "Invalid role" }, 400);

  // Someone with an account already — a congregation member, or your own
  // customer-side login — is simply added. Only a genuinely new person gets an
  // invitation email.
  let userId = await findUserByEmail(email);
  let invited = false;

  if (!userId) {
    // POST /auth/v1/invite — NOT /auth/v1/admin/invite, which does not exist
    // and answers 404. Only some admin operations live under /admin (the user
    // lookup above is one); invite is not among them, and the 404 surfaces as
    // a mail failure because that is the branch it lands in.
    //
    // redirect_to is a query parameter here. In the body it is accepted and
    // ignored, and the invitation link then points at the project's default
    // site URL instead of the page that sets a password.
    const inviteUrl = new URL(`${SUPABASE_URL}/auth/v1/invite`);
    if (SITE_URL) inviteUrl.searchParams.set("redirect_to", SITE_URL);
    const res = await fetch(inviteUrl.toString(), {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const text = await res.text();
      // Also to the log: the body reaches the browser, but a 502 in the
      // dashboard's function log is otherwise a dead end, and this is the
      // failure most likely to be looked at from there.
      console.error(`invite failed for ${email}: ${res.status} ${text.slice(0, 300)}`);
      // The status, not a guess at the cause. Naming SMTP here when the real
      // answer was a 404 from a wrong URL sent two rounds of debugging at a
      // mail server that was working perfectly.
      return json({
        ok: false,
        error: `The invitation could not be sent (HTTP ${res.status}).` +
          (res.status >= 500 ? " The mail server rejected it — check the project's SMTP settings." : ""),
        detail: text.slice(0, 300),
      }, 502);
    }
    userId = (await res.json())?.id ?? null;
    invited = true;
    if (!userId) {
      return json({ ok: false, error: "The invitation went out but no account came back." }, 500);
    }
  }

  if (await operatorRole(userId)) {
    return json({ ok: false, error: "That person is already an operator." }, 409);
  }

  const ins = await fetch(`${SUPABASE_URL}/rest/v1/platform_admins`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ user_id: userId, role, added_by: caller }),
  });
  if (!ins.ok) return json({ ok: false, error: "Could not add that operator." }, 500);

  // Which path this took, in the log as well as the response. "No email was
  // sent because the account already existed" and "an email was sent and did
  // not arrive" are indistinguishable from the recipient's inbox, and only one
  // of them is a mail problem.
  console.log(
    invited
      ? `invited ${email} (new account ${userId})`
      : `added existing account ${email} (${userId}) — no email sent`,
  );
  return json({ ok: true, user_id: userId, email, role, invited });
});
