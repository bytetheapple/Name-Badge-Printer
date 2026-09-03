// Does this Google connection still work?
//
// The database cannot answer that. A refresh token Google has stopped
// honouring — because the owner revoked access, changed password, or the app's
// grant expired — looks exactly like a good one: a row with a secret_id. The
// only proof is spending it.
//
// So this exchanges the refresh token for an access token and reports what
// came back. The token itself is never returned; the point is the verdict and
// the scopes, not the credential.
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

async function callerOf(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  return (await res.json())?.id ?? null;
}

async function isOwner(userId: string, orgId: string): Promise<boolean> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/memberships?org_id=eq.${orgId}&user_id=eq.${userId}&select=role`,
    { headers: restHeaders },
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return rows.length > 0 && rows[0].role === "owner";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return json({ ok: false, error: "Google sign-in is not configured on this deployment." }, 500);
  }

  const userId = await callerOf(req);
  if (!userId) return json({ ok: false, error: "Not signed in" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }
  const orgId = String(body.org_id ?? "");
  const integrationId = String(body.integration_id ?? "");
  if (!orgId || !integrationId) {
    return json({ ok: false, error: "org_id and integration_id are required" }, 400);
  }
  if (!(await isOwner(userId, orgId))) {
    return json({ ok: false, error: "Only an owner can test this connection" }, 403);
  }

  // The org filter is what stops an owner of one organization testing — and so
  // learning the state of — another's connection by guessing an id.
  const rowRes = await fetch(
    `${SUPABASE_URL}/rest/v1/integrations?id=eq.${integrationId}&org_id=eq.${orgId}` +
      `&kind=eq.google_oauth&select=id,config`,
    { headers: restHeaders },
  );
  const row = rowRes.ok ? (await rowRes.json())[0] : null;
  if (!row) return json({ ok: false, error: "No such Google connection" }, 404);

  const secretRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/integration_secret`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ p_integration: integrationId }),
  });
  const refresh = secretRes.ok ? String((await secretRes.json()) ?? "") : "";
  if (!refresh) {
    return json({
      ok: false,
      error: "This connection has no stored credential. Press Connect Google.",
    });
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const out = await res.json().catch(() => ({}));

  if (!res.ok) {
    const reason = String(out?.error ?? `HTTP ${res.status}`);
    // invalid_grant is Google saying the token is dead — revoked, or the
    // account's password changed. Recorded, because a connection that cannot
    // be refreshed is not enabled in any useful sense, and leaving it looking
    // healthy is how a customer discovers it by missing sign-ins.
    if (reason === "invalid_grant") {
      await fetch(
        `${SUPABASE_URL}/rest/v1/integrations?id=eq.${integrationId}&org_id=eq.${orgId}`,
        {
          method: "PATCH",
          headers: restHeaders,
          body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }),
        },
      );
      return json({
        ok: false,
        revoked: true,
        error: "Google no longer accepts this connection — access was revoked, or the " +
          "account's password changed. Press Reconnect Google.",
      });
    }
    return json({ ok: false, error: `Google refused the connection: ${reason}` });
  }

  const scopes = String(out?.scope ?? "").split(" ").filter(Boolean);
  return json({
    ok: true,
    connected_email: row.config?.connected_email ?? null,
    expires_in: Number(out?.expires_in ?? 0),
    scopes,
    // Said explicitly: the one scope everything downstream depends on.
    can_write_files: scopes.includes("https://www.googleapis.com/auth/drive.file"),
  });
});
