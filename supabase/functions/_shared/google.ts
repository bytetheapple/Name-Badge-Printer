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
