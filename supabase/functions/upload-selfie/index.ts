// Uploads a visitor selfie to Google Drive using a service account.
// Filename: First_Last_YYYY-MM-DD_HHMMSS.jpg, in the configured Drive folder.
//
// The service account comes from the entry's own organization (integrations,
// kind 'google_drive': client email in config, private key in Vault), and from
// nowhere else. An org with none configured uploads nowhere rather than using
// anyone else's credentials.
// Folder id comes from app_settings.selfie_drive_folder_id (set in the admin),
// which is already per-organization — it is a setting, not a credential.
import { corsHeaders, json } from "../_shared/cors.ts";
import { orgOfEntry, recordDelivery, targetsFor } from "../_shared/integration.ts";
import {
  type GoogleAuth,
  googleAuthFor,
  GoogleAuthError,
} from "../_shared/google.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Record the outcome on the entry, the way the other two syncs do.
 *
 * Without this a failure is invisible everywhere: the kiosk calls this
 * fire-and-forget so a photo can never hold up a badge, which is right, but it
 * meant the only trace was a log line — and three of the failure paths below
 * do not even reach one.
 */
async function noteSelfie(entryId: string, status: string, error?: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({
      selfie_status: status,
      selfie_error: error ? String(error).slice(0, 500) : null,
    }),
  });
}

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

/** The folder this application owns for one organization's selfies. */
async function createSelfieFolder(token: string, orgId: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Guest Badges — visitor photographs",
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  const body = await res.json().catch(() => ({}));
  const id = String(body?.id ?? "");
  if (!res.ok || !id) {
    throw new Error(String(body?.error?.message ?? `HTTP ${res.status}`));
  }
  // Recorded so the next photograph joins this folder instead of making
  // another one per visitor.
  await fetch(`${SUPABASE_URL}/rest/v1/app_settings?org_id=eq.${orgId}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({ selfie_drive_folder_id: id }),
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

  // The Drive folder is per organization, so the entry decides which settings
  // row applies. Reading it off the entry (rather than the request) also means
  // a selfie can only ever be attached to the org that entry belongs to.
  const entryRes = await fetch(
    `${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}&select=org_id`,
    { headers: restHeaders },
  );
  const orgId = entryRes.ok ? (await entryRes.json())[0]?.org_id : null;
  if (!orgId) return json({ ok: false, error: "Unknown sign-in" }, 404);

  // One destination today — a congregation has one Drive account — but routed
  // the same way as the others, so selfies appear in the same delivery history
  // and a printer can be excluded from uploading them like anything else.
  // Choosing between several Drive accounts is a later change; the first is
  // taken until the selfie setting can name one.
  const driveTargets = await targetsFor(entryId, "google_drive");
  const target = driveTargets[0] ?? null;
  if (!target) {
    // Skipped, not failed. Nothing is broken: this organization has no Drive
    // account connected, or has switched it off for this printer, and a red
    // failure for a deliberate choice is a false alarm someone has to chase.
    const why = "No Google Drive destination for this sign-in";
    await noteSelfie(entryId, "skipped", why);
    return json({ ok: false, error: why });
  }

  // Either credential, chosen by how this destination is configured — the
  // service account it was set up with, or the organization's Google
  // connection. See googleAuthFor.
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
    await noteSelfie(entryId, "failed", err);
    await recordDelivery(entryId, target.id, "failed", err);
    return json({ ok: false, error: err });
  }

  const cfgRes = await fetch(
    `${SUPABASE_URL}/rest/v1/app_settings?org_id=eq.${orgId}&select=selfie_drive_folder_id`,
    { headers: restHeaders },
  );
  let folderId = (await cfgRes.json())[0]?.selfie_drive_folder_id;

  // On a connection, make the folder rather than asking for one. `drive.file`
  // reaches only what this application created, so a folder the customer made
  // and shared — which is how the service-account path works — is invisible to
  // an OAuth token. That is why migrating produces a new folder rather than
  // adopting the old one; the photographs already uploaded keep their links.
  if (!folderId && auth.kind === "oauth") {
    try {
      folderId = await createSelfieFolder(auth.token, orgId);
    } catch (e) {
      const err = `Could not create a Drive folder: ${e}`;
      await noteSelfie(entryId, "failed", err);
      await recordDelivery(entryId, target.id, "failed", err);
      return json({ ok: false, error: err });
    }
  }

  if (!folderId) {
    const err = "No Drive folder configured";
    await noteSelfie(entryId, "failed", err);
    await recordDelivery(entryId, target.id, "failed", err);
    return json({ ok: false, error: err });
  }

  // Decode the data URL / base64 into bytes.
  const base64 = image.includes(",") ? image.split(",")[1] : image;
  const binStr = atob(base64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

  const filename = `${slug(first)}_${slug(last)}_${stamp(new Date())}.jpg`;

  try {
    const token = auth.token;
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
      await noteSelfie(entryId, "failed", `Drive upload failed: ${JSON.stringify(upData)}`);
      await recordDelivery(entryId, target.id, "failed", `Drive upload failed`);
      return json({ ok: false, error: `Drive upload failed: ${JSON.stringify(upData)}` }, 500);
    }

    if (entryId && upData.webViewLink) {
      await fetch(`${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}&org_id=eq.${orgId}`, {
        method: "PATCH",
        headers: restHeaders,
        body: JSON.stringify({
          selfie_link: upData.webViewLink,
          selfie_status: "sent",
          selfie_error: null,
        }),
      });
      await recordDelivery(entryId, target.id, "sent");

      // Fill the selfie in on any sheet row this sign-in already wrote.
      //
      // The photo is uploaded in the background, after the sign-in has been
      // submitted and the row appended, so at append time this link did not
      // exist. Without this the Selfie column would be empty on precisely the
      // visitors who had their picture taken — a column that looks like a
      // feature and is always blank.
      //
      // The sync updates the row it recorded rather than adding another.
      // Fire-and-forget, exactly like the sync triggers in submit-badge: a
      // sheet must never hold up a photo, and the photo is already stored.
      fetch(`${SUPABASE_URL}/functions/v1/google-sheet-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SERVICE_ROLE}`,
        },
        body: JSON.stringify({ entry_id: entryId }),
      }).catch((e) => console.error("google-sheet-sync trigger failed:", e));
    }
    return json({ ok: true, file_id: upData.id, link: upData.webViewLink ?? null });
  } catch (e) {
    console.error("upload-selfie error:", e);
    // The one that mattered in practice: InvalidCharacterError out of
    // pemToPkcs8, which is a service-account key with a stray character —
    // usually the quotes it was copied with out of the JSON file.
    await noteSelfie(entryId, "failed", String(e));
    await recordDelivery(entryId, target.id, "failed", String(e).slice(0, 300));
    return json({ ok: false, error: String(e).slice(0, 300) }, 500);
  }
});
