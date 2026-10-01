// Uploads a visitor's driver's-license photo to Google Drive.
//
// A sibling of upload-selfie: same organization, same connected Google account,
// but its own folder (app_settings.license_drive_folder_id) so licences and
// selfies never land together. The outcome is recorded on the entry only
// (license_status / license_link / license_error) — NOT via record_delivery,
// which is keyed on (entry, integration) and would collide with the selfie's
// delivery to the same google_drive destination — and the link is deliberately
// not pushed to the Google Sheet. A licence image is sensitive.
import { corsHeaders, json } from "../_shared/cors.ts";
import { targetsFor } from "../_shared/integration.ts";
import { type GoogleAuth, googleAuthFor, GoogleAuthError } from "../_shared/google.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

async function noteLicense(entryId: string, status: string, error?: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({
      license_status: status,
      license_error: error ? String(error).slice(0, 500) : null,
    }),
  });
}

/** The folder this application owns for one organization's licence images. */
async function createLicenseFolder(
  token: string,
  orgId: string,
  integrationId: string,
  config: Record<string, unknown>,
): Promise<string> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Guest Badges — visitor driver's licenses",
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  const body = await res.json().catch(() => ({}));
  const id = String(body?.id ?? "");
  if (!res.ok || !id) {
    throw new Error(String(body?.error?.message ?? `HTTP ${res.status}`));
  }
  await fetch(`${SUPABASE_URL}/rest/v1/app_settings?org_id=eq.${orgId}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({ license_drive_folder_id: id }),
  });
  // A separate "ours" flag from the selfie folder's, so one being remade never
  // makes the other look adopted-not-ours.
  await fetch(`${SUPABASE_URL}/rest/v1/integrations?id=eq.${integrationId}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({
      config: { ...config, license_folder_is_ours: true },
    }),
  });
  return id;
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
  if (!UUID_RE.test(entryId)) return json({ ok: false, error: "Invalid sign-in" }, 400);
  if (!image) return json({ ok: false, error: "No image" }, 400);

  const entryRes = await fetch(
    `${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}&select=org_id`,
    { headers: restHeaders },
  );
  const orgId = entryRes.ok ? (await entryRes.json())[0]?.org_id : null;
  if (!orgId) return json({ ok: false, error: "Unknown sign-in" }, 404);

  const driveTargets = await targetsFor(entryId, "google_drive");
  const target = driveTargets[0] ?? null;
  if (!target) {
    const why = "No Google Drive destination for this sign-in";
    await noteLicense(entryId, "skipped", why);
    return json({ ok: false, error: why });
  }

  let auth: GoogleAuth;
  try {
    auth = await googleAuthFor(
      orgId,
      target.config,
      target.secret,
      "https://www.googleapis.com/auth/drive",
    );
  } catch (e) {
    const err = e instanceof GoogleAuthError
      ? e.message
      : `Could not authenticate to Google: ${e}`;
    await noteLicense(entryId, "failed", err);
    return json({ ok: false, error: err });
  }

  const cfgRes = await fetch(
    `${SUPABASE_URL}/rest/v1/app_settings?org_id=eq.${orgId}&select=license_drive_folder_id`,
    { headers: restHeaders },
  );
  let folderId = (await cfgRes.json())[0]?.license_drive_folder_id;

  const folderIsOurs = target.config.license_folder_is_ours === true;
  if (auth.kind === "oauth" && (!folderId || !folderIsOurs)) {
    try {
      folderId = await createLicenseFolder(auth.token, orgId, target.id, target.config);
    } catch (e) {
      const err = `Could not create a Drive folder: ${e}`;
      await noteLicense(entryId, "failed", err);
      return json({ ok: false, error: err });
    }
  }

  if (!folderId) {
    const err = "No Drive folder configured";
    await noteLicense(entryId, "failed", err);
    return json({ ok: false, error: err });
  }

  const base64 = image.includes(",") ? image.split(",")[1] : image;
  const binStr = atob(base64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

  const filename = `${slug(first)}_${slug(last)}_license_${stamp(new Date())}.jpg`;

  try {
    const token = auth.token;
    const metadata = { name: filename, parents: [folderId] };
    const boundary = `lfb-${crypto.randomUUID()}`;
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
      console.error("upload-license: Drive upload failed:", JSON.stringify(upData));
      await noteLicense(entryId, "failed", `Drive upload failed: ${JSON.stringify(upData)}`);
      return json({ ok: false, error: `Drive upload failed` }, 500);
    }

    if (entryId && upData.webViewLink) {
      await fetch(`${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}&org_id=eq.${orgId}`, {
        method: "PATCH",
        headers: restHeaders,
        body: JSON.stringify({
          license_link: upData.webViewLink,
          license_status: "sent",
          license_error: null,
        }),
      });
    }
    return json({ ok: true, file_id: upData.id, link: upData.webViewLink ?? null });
  } catch (e) {
    console.error("upload-license error:", e);
    await noteLicense(entryId, "failed", String(e));
    return json({ ok: false, error: String(e).slice(0, 300) }, 500);
  }
});
