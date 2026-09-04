// Start a "Connect Google" for one organization.
//
// Returns the URL to send the owner to. It does not redirect: the caller is a
// fetch from the admin console, and a 302 answered to fetch() is followed by
// the browser without ever showing anybody Google's consent screen.
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "";
const REDIRECT_URI = Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI") ?? "";

// openid + email so the connection can say whose account it is, and
// drive.file — access to files this application created, and nothing else.
// Non-sensitive, which is what keeps this clear of Google's restricted-scope
// security assessment. Widening it later is not a config change; it is a
// re-review.
const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

async function callerOf(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  return (await res.json())?.id ?? null;
}

/** Integrations are the owner's job — this mirrors the RLS on that table. */
async function isOwner(userId: string, orgId: string): Promise<boolean> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/memberships?org_id=eq.${orgId}&user_id=eq.${userId}&select=role`,
    { headers: restHeaders },
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return rows.length > 0 && rows[0].role === "owner";
}

/**
 * The instance being connected: the one asked for, or this org's existing
 * Google connection, or a new one.
 *
 * Reconnecting must land on the row that already exists — a second instance
 * would leave the first enabled with a refresh token Google has stopped
 * honouring, and the sync would go on failing against it.
 */
async function integrationFor(orgId: string, wanted: string | null): Promise<string | null> {
  if (wanted) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/integrations?id=eq.${wanted}&org_id=eq.${orgId}` +
        `&kind=eq.google_oauth&select=id`,
      { headers: restHeaders },
    );
    const rows = res.ok ? await res.json() : [];
    return rows.length ? String(rows[0].id) : null;
  }

  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/integrations?org_id=eq.${orgId}&kind=eq.google_oauth` +
      `&select=id&order=created_at.asc&limit=1`,
    { headers: restHeaders },
  );
  const rows = existing.ok ? await existing.json() : [];
  if (rows.length) return String(rows[0].id);

  // Names are unique per organization, so a second Google connection needs a
  // distinct one. Rare, but a collision here would fail the insert rather than
  // do something surprising.
  const made = await fetch(`${SUPABASE_URL}/rest/v1/integrations`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify({
      org_id: orgId,
      kind: "google_oauth",
      name: `Google account ${new Date().toISOString().slice(0, 10)}`,
      enabled: false,           // not connected until the callback says so
      default_enabled: true,
      config: {},
    }),
  });
  if (!made.ok) return null;
  const created = await made.json();
  return created.length ? String(created[0].id) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!CLIENT_ID || !REDIRECT_URI) {
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
  if (!orgId) return json({ ok: false, error: "org_id is required" }, 400);
  if (!(await isOwner(userId, orgId))) {
    return json({ ok: false, error: "Only an owner can connect a Google account" }, 403);
  }

  const integrationId = await integrationFor(orgId, String(body.integration_id ?? "") || null);
  if (!integrationId) {
    return json({ ok: false, error: "Could not prepare the connection" }, 500);
  }

  await fetch(`${SUPABASE_URL}/rest/v1/rpc/purge_oauth_pending`, {
    method: "POST",
    headers: restHeaders,
    body: "{}",
  });

  // Where to land afterwards. Only a path inside the console: anything else —
  // an absolute URL, a protocol-relative //evil.example, a path escaping
  // upwards — makes this an open redirect, and it is stored rather than passed
  // through Google precisely so it cannot be tampered with in transit.
  const askedFor = String(body.return_to ?? "").trim();
  const returnTo = /^\/admin\/[A-Za-z0-9\-/_]*$/.test(askedFor) && !askedFor.includes("//")
    ? askedFor
    : "/admin/integrations";

  const state = rand();
  const verifier = rand(48);
  const stored = await fetch(`${SUPABASE_URL}/rest/v1/oauth_pending`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({
      state,
      org_id: orgId,
      integration_id: integrationId,
      code_verifier: verifier,
      return_to: returnTo,
    }),
  });
  if (!stored.ok) return json({ ok: false, error: "Could not start the connection" }, 500);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  // Both are needed to be handed a refresh token: offline asks for one, and
  // consent forces the prompt even for an account that has approved before —
  // without it a reconnect returns an access token only, and the connection
  // works until it silently stops an hour later.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("code_challenge", await challengeFor(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return json({ ok: true, url: url.toString(), integration_id: integrationId });
});
