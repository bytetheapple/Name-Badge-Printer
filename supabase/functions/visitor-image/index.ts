// Stream a visitor's selfie or driver's-licence image to the greeter portal.
//
// The images live in the organization's own Google Drive and are not public, so
// a greeter (who has no Google access) cannot open them directly. This fetches
// the file bytes with the org's Google credential and returns them, after
// checking the caller is a greeter, admin or owner of that org. The Drive file
// id is never exposed to the browser — only the entry id is — so this is the one
// path to the image.
import { corsHeaders, json } from "../_shared/cors.ts";
import { integrationFor } from "../_shared/integration.ts";
import { googleAuthFor, GoogleAuthError } from "../_shared/google.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const REST = `${SUPABASE_URL}/rest/v1`;
const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function callerOf(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return typeof user?.id === "string" ? user.id : null;
}

async function roleInOrg(userId: string, orgId: string): Promise<string | null> {
  const res = await fetch(
    `${REST}/memberships?org_id=eq.${orgId}&user_id=eq.${userId}&select=role`,
    { headers: restHeaders },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? String(rows[0].role) : null;
}

const MAY_SEE = new Set(["greeter", "staff", "admin", "owner"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const caller = await callerOf(req);
  if (!caller) return json({ ok: false, error: "Not signed in" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }
  const entryId = String(body.entry_id ?? "").trim();
  const kind = String(body.kind ?? "");
  if (!UUID_RE.test(entryId)) return json({ ok: false, error: "Invalid sign-in" }, 400);
  if (kind !== "selfie" && kind !== "license") {
    return json({ ok: false, error: "Invalid image kind" }, 400);
  }

  // The entry carries both the org (for the access check) and the file ids.
  const entryRes = await fetch(
    `${REST}/form_entries?id=eq.${entryId}&select=org_id,selfie_file_id,license_file_id`,
    { headers: restHeaders },
  );
  if (!entryRes.ok) return json({ ok: false, error: "Could not read sign-in" }, 500);
  const entry = (await entryRes.json())[0];
  if (!entry) return json({ ok: false, error: "Unknown sign-in" }, 404);
  const orgId = String(entry.org_id);

  const role = await roleInOrg(caller, orgId);
  if (!role || !MAY_SEE.has(role)) {
    return json({ ok: false, error: "You cannot view this image" }, 403);
  }

  const fileId = kind === "selfie" ? entry.selfie_file_id : entry.license_file_id;
  if (!fileId) return json({ ok: false, error: "No image" }, 404);

  const integ = await integrationFor(orgId, "google_drive");
  if (!integ || !integ.enabled) return json({ ok: false, error: "Drive not connected" }, 404);
  let token: string;
  try {
    token = (await googleAuthFor(
      orgId,
      integ.config,
      integ.secret,
      "https://www.googleapis.com/auth/drive",
    )).token;
  } catch (e) {
    const err = e instanceof GoogleAuthError ? e.message : `Google auth failed: ${e}`;
    return json({ ok: false, error: err }, 502);
  }

  const driveRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!driveRes.ok) {
    // 404 here usually means the file was deleted (retention) since the feed.
    return json({ ok: false, error: "Image is no longer available" }, driveRes.status === 404 ? 404 : 502);
  }

  // Stream the bytes straight back. Private cache only — it is a licence photo.
  return new Response(driveRes.body, {
    headers: {
      ...corsHeaders,
      "Content-Type": driveRes.headers.get("Content-Type") ?? "image/jpeg",
      "Cache-Control": "private, max-age=120",
    },
  });
});
