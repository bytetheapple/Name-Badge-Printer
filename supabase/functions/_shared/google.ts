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
