// Uploads a visitor selfie to Google Drive using a service account.
// Filename: First_Last_YYYY-MM-DD_HHMMSS.jpg, in the configured Drive folder.
//
// Secrets:
//   GOOGLE_SA_CLIENT_EMAIL   service account email
//   GOOGLE_SA_PRIVATE_KEY    service account private key (PEM; \n-escaped is fine)
// Folder id comes from app_settings.selfie_drive_folder_id (set in the admin).
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SA_EMAIL = Deno.env.get("GOOGLE_SA_CLIENT_EMAIL") ?? "";
const SA_KEY = (Deno.env.get("GOOGLE_SA_PRIVATE_KEY") ?? "").replace(/\\n/g, "\n");

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}
function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: SA_EMAIL,
    scope: "https://www.googleapis.com/auth/drive",
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

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  const entryId = String(body.entry_id ?? "");
  const first = String(body.first_name ?? "").trim();
  const last = String(body.last_name ?? "").trim();
  const image = String(body.image ?? "");
  if (!image) return json({ ok: false, error: "No image" }, 400);
  if (!SA_EMAIL || !SA_KEY) return json({ ok: false, error: "Google service account not configured" });

  const cfgRes = await fetch(
    `${SUPABASE_URL}/rest/v1/app_settings?id=eq.1&select=selfie_drive_folder_id`,
    { headers: restHeaders },
  );
  const folderId = (await cfgRes.json())[0]?.selfie_drive_folder_id;
  if (!folderId) return json({ ok: false, error: "No Drive folder configured" });

  // Decode the data URL / base64 into bytes.
  const base64 = image.includes(",") ? image.split(",")[1] : image;
  const binStr = atob(base64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

  const filename = `${slug(first)}_${slug(last)}_${stamp(new Date())}.jpg`;

  try {
    const token = await getAccessToken();
    const metadata = { name: filename, parents: [folderId] };
    const boundary = `sfb-${crypto.randomUUID()}`;
    const enc = new TextEncoder();
    const pre = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,
    );
    const post = enc.encode(`\r\n--${boundary}--`);
    const bodyBytes = new Uint8Array(pre.length + bytes.length + post.length);
    bodyBytes.set(pre, 0);
    bodyBytes.set(bytes, pre.length);
    bodyBytes.set(post, pre.length + bytes.length);

    const up = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body: bodyBytes,
      },
    );
    const upData = await up.json();
    if (!up.ok) {
      console.error("upload-selfie: Drive upload failed:", JSON.stringify(upData));
      return json({ ok: false, error: `Drive upload failed: ${JSON.stringify(upData)}` }, 500);
    }

    if (entryId && upData.webViewLink) {
      await fetch(`${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}`, {
        method: "PATCH",
        headers: restHeaders,
        body: JSON.stringify({ selfie_link: upData.webViewLink }),
      });
    }
    return json({ ok: true, file_id: upData.id, link: upData.webViewLink ?? null });
  } catch (e) {
    console.error("upload-selfie error:", e);
    return json({ ok: false, error: String(e).slice(0, 300) }, 500);
  }
});
