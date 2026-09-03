// Minting a Google access token from a service account.
//
// Lifted out of upload-selfie unchanged except for the scope, which was baked
// in there. Sheets needs `spreadsheets` and Drive needs `drive`; asking for
// the wider one because it happened to be hardcoded would hand a sheet sync
// the run of a congregation's Drive.

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}
/**
 * The base64 body of a PEM key, however it was pasted.
 *
 * A service-account key is copied out of a JSON file, where the newlines are
 * written as the two characters backslash-n. Those survive a whitespace strip,
 * land in the base64 and surface as InvalidCharacterError — which names no
 * cause and sends nobody anywhere useful.
 *
 * upload-selfie learned this and normalised the key at its own call site. The
 * sheet sync then did not, because the knowledge lived in one function rather
 * than in the code that needs it. So it lives here now: the armour is
 * optional, real newlines and literal ones both work, and so does a key with
 * no line breaks at all.
 */
export function pemBody(pem: string): string {
  return (pem ?? "")
    .replace(/\\n/g, "\n")
    .replace(/-----[A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pemBody(pem);
  if (!body) throw new Error("the service account private key is empty");
  let bin: string;
  try {
    bin = atob(body);
  } catch {
    // Said in words. This is a paste that went wrong, and the operator can fix
    // it in ten seconds if told what to look at.
    throw new Error(
      "the service account private key is not valid base64 — paste the " +
        "private_key value from the service account JSON file, including its " +
        "BEGIN and END lines",
    );
  }
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(
  SA_EMAIL: string,
  SA_KEY: string,
  scope: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: SA_EMAIL,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(SA_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)),
  );
  const jwt = `${unsigned}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

export { getAccessToken };

/**
 * What a Google API refusal actually means, in words an office can act on.
 *
 * A 403 has more than one cause and they need opposite actions. The first
 * version of this assumed every one was an unshared file and said "press Share
 * and give this address Editor access" — which, told to someone whose project
 * simply had not enabled the API, sends them to do something that cannot
 * possibly help. Google says which it is, in `details[].reason`; not reading
 * it was the same mistake as guessing at a dropped printer session.
 */
export function explainGoogleError(
  status: number,
  body: Record<string, unknown>,
  saEmail: string,
  api = "sheets.googleapis.com",
): string {
  const err = (body?.error ?? {}) as {
    message?: string;
    status?: string;
    details?: Array<{ reason?: string; metadata?: Record<string, string> }>;
  };
  const msg = String(err.message ?? "");
  const reasons = (err.details ?? []).map((d) => String(d.reason ?? ""));

  // The API is switched off in the Cloud project. Nothing to do with the file,
  // and enabling one Google API does not enable another — a project set up for
  // Drive selfies has Sheets disabled.
  if (reasons.includes("SERVICE_DISABLED") || /has not been used in project|is disabled/i.test(msg)) {
    const project = (err.details ?? [])
      .map((d) => d.metadata?.consumer ?? "")
      .find((c) => c.includes("projects/"))
      ?.replace("projects/", "");
    return `The ${api} API is not switched on in that Google Cloud project` +
      (project ? ` (${project})` : "") +
      `. Enable it at https://console.developers.google.com/apis/api/${api}/overview` +
      (project ? `?project=${project}` : "") +
      ", wait a minute, then try again. Enabling Drive does not enable Sheets.";
  }

  if (reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
    return "The service account's token does not carry the Sheets scope. This is " +
      "a fault in this application rather than in your setup — please report it.";
  }

  if (status === 403) {
    return `The service account cannot open that file. In Google Sheets, press ` +
      `Share and give ${saEmail} Editor access.` + (msg ? ` (${msg})` : "");
  }
  if (status === 404) {
    return "No sheet with that address. Check the link, and that it has not been " +
      "moved to the bin." + (msg ? ` (${msg})` : "");
  }
  if (status === 401) {
    return `Google would not accept the service account ${saEmail}. Check the ` +
      "email and the private key are from the same service account JSON." +
      (msg ? ` (${msg})` : "");
  }
  return msg || `Google answered HTTP ${status}.`;
}

// ---------------------------------------------------------------------------
// Authenticating as the organization, however they set that up.
//
// Two ways exist and one is on its way out. A service account was the original
// path: the customer creates one in Google Cloud, downloads a JSON key, pastes
// a PEM, and shares a folder with it. It works, and it asks a synagogue office
// to do something no synagogue office should have to do.
//
// The OAuth connection replaces it. The catch worth knowing is that the two
// cannot address the same files: `drive.file` reaches only what this
// application created, so a folder the customer made and shared with a service
// account is invisible to an OAuth token. Migrating is therefore not a
// credential swap — the new path makes new destinations. See
// docs/PHASE_A5B_GOOGLE_OAUTH.md.
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OAUTH_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") ?? "";
const OAUTH_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? "";

const gRest = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

/** How an organization's Google calls are authenticated. */
export type GoogleAuth =
  | { kind: "oauth"; token: string; connectionId: string; email: string }
  | { kind: "service_account"; token: string; email: string };

export class GoogleAuthError extends Error {
  /** True when reconnecting is the remedy, so callers can say so. */
  readonly reconnect: boolean;
  constructor(message: string, reconnect = false) {
    super(message);
    this.reconnect = reconnect;
  }
}

/** This organization's live Google connection, if it has one. */
async function oauthConnection(
  orgId: string,
): Promise<{ id: string; email: string; refresh: string } | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/integrations?org_id=eq.${orgId}&kind=eq.google_oauth` +
      `&enabled=is.true&select=id,config&order=created_at.asc&limit=1`,
    { headers: gRest },
  );
  const row = res.ok ? (await res.json())[0] : null;
  if (!row) return null;

  const sres = await fetch(`${SUPABASE_URL}/rest/v1/rpc/integration_secret`, {
    method: "POST",
    headers: gRest,
    body: JSON.stringify({ p_integration: row.id }),
  });
  const refresh = sres.ok ? String((await sres.json()) ?? "") : "";
  if (!refresh) return null;
  return { id: String(row.id), email: String(row.config?.connected_email ?? ""), refresh };
}

/**
 * Spend a refresh token.
 *
 * A dead grant disables the connection on the spot. Google saying invalid_grant
 * means the customer revoked access or changed their password, and there is no
 * retry that helps — leaving the row enabled would make every later sign-in
 * fail the same way while the console still said "Connected".
 */
async function accessFromRefresh(conn: { id: string; refresh: string }): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: conn.refresh,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (res.ok && out?.access_token) return String(out.access_token);

  const reason = String(out?.error ?? `HTTP ${res.status}`);
  if (reason === "invalid_grant") {
    await fetch(`${SUPABASE_URL}/rest/v1/integrations?id=eq.${conn.id}`, {
      method: "PATCH",
      headers: gRest,
      body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }),
    });
    throw new GoogleAuthError(
      "The connected Google account no longer accepts this application — access was " +
        "revoked, or the account's password changed. Reconnect Google in Integrations.",
      true,
    );
  }
  throw new GoogleAuthError(`Google refused the connection: ${reason}`);
}

/**
 * A token for one destination, and which credential produced it.
 *
 * The rule, in order:
 *   1. `use_oauth` on the destination — the deliberate switch, so migrating an
 *      organization that already works is something somebody does, not
 *      something that happens to them mid-service.
 *   2. Its own service-account key, if it has one.
 *   3. The organization's Google connection — so a destination configured
 *      after OAuth exists needs no credential of its own at all.
 */
export async function googleAuthFor(
  orgId: string,
  config: Record<string, unknown>,
  secret: string | null,
  scope: string,
): Promise<GoogleAuth> {
  const wantsOAuth = config.use_oauth === true;
  const saEmail = String(config.sa_client_email ?? "").trim();
  const hasSA = Boolean(saEmail && secret);

  if (!wantsOAuth && hasSA) {
    return {
      kind: "service_account",
      token: await getAccessToken(saEmail, secret as string, scope),
      email: saEmail,
    };
  }

  const conn = await oauthConnection(orgId);
  if (conn) {
    return {
      kind: "oauth",
      token: await accessFromRefresh(conn),
      connectionId: conn.id,
      email: conn.email,
    };
  }

  if (wantsOAuth) {
    throw new GoogleAuthError(
      "This destination is set to use the connected Google account, but this " +
        "organization has no working connection. Connect Google in Integrations.",
      true,
    );
  }
  throw new GoogleAuthError("No Google credentials are configured for this organization.");
}
