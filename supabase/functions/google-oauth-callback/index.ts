// Where Google sends the owner back after they approve.
//
// The only function in this project that answers a browser rather than a
// fetch, so it redirects rather than returning JSON — a person is looking at
// this, and a page of JSON is not an answer to "did that work".
//
// Nothing here is trusted from the request except the code and the state. The
// organization comes from the pending row that state names, which only an
// authenticated owner could have created. Same rule as the kiosk and bridge
// tokens: the party the request claims to be is never the party it is treated
// as.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";
const REDIRECT_URI = Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI") ?? "";
const APP_URL = (Deno.env.get("APP_URL") ?? "https://www.guestbadges.com").replace(/\/$/, "");

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

/** Back to the console with the outcome in the query string. */
function back(params: Record<string, string>): Response {
  const url = new URL(`${APP_URL}/admin/integrations`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

/** The email on the account, read from the id_token's payload. */
function emailFromIdToken(idToken: string): string {
  try {
    const [, payload] = idToken.split(".");
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return String(JSON.parse(json)?.email ?? "");
  } catch {
    // Not fatal: the connection works without knowing whose it is, and a
    // failure here must not throw away a refresh token we already hold.
    return "";
  }
}

Deno.serve(async (req) => {
  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";

  // The owner pressed Cancel, or Google refused. Their words, not ours.
  const denied = q.get("error");
  if (denied) return back({ google_error: denied });

  const code = q.get("code") ?? "";
  if (!code || !state) return back({ google_error: "missing_code" });
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return back({ google_error: "not_configured" });
  }

  // The verifier, and with it the organization. Read rather than claimed.
  const pendingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/oauth_pending?state=eq.${encodeURIComponent(state)}` +
      `&select=code_verifier,org_id,integration_id,expires_at`,
    { headers: restHeaders },
  );
  const pending = pendingRes.ok ? (await pendingRes.json())[0] : null;
  if (!pending) return back({ google_error: "expired" });
  if (Date.parse(String(pending.expires_at)) < Date.now()) return back({ google_error: "expired" });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code_verifier: String(pending.code_verifier),
    }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    console.error("token exchange failed:", tokenRes.status, JSON.stringify(token).slice(0, 300));
    return back({ google_error: "exchange_failed" });
  }

  const refresh = String(token.refresh_token ?? "");
  if (!refresh) {
    // Google issues one only with access_type=offline and prompt=consent, and
    // silently omits it otherwise — so a connection would appear to work and
    // stop within the hour. Said plainly rather than stored half-made.
    console.error("no refresh_token in the token response");
    return back({ google_error: "no_refresh_token" });
  }

  const done = await fetch(`${SUPABASE_URL}/rest/v1/rpc/complete_google_oauth`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({
      p_state: state,
      p_refresh_token: refresh,
      p_email: emailFromIdToken(String(token.id_token ?? "")),
    }),
  });
  if (!done.ok) {
    console.error("complete_google_oauth failed:", done.status, (await done.text()).slice(0, 300));
    return back({ google_error: "store_failed" });
  }

  return back({ connected: "google" });
});
