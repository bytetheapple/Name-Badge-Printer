// Delete visitor images (selfies, driver's licenses) past their organization's
// retention window. Called hourly by pg_cron via pg_net; see the migration
// 20261104120000_mt_photo_retention.sql.
//
// Only ever deletes what is already past the cutoff for an org that has chosen a
// finite policy, and clears the record so the admin sees "Deleted" rather than a
// dangling link. An org on 'never' is never touched. Idempotent: a file Drive
// has already lost (404) is treated as gone and the record cleared anyway.
import { corsHeaders, json } from "../_shared/cors.ts";
import { integrationFor } from "../_shared/integration.ts";
import { googleAuthFor, GoogleAuthError } from "../_shared/google.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = `${SUPABASE_URL}/rest/v1`;
const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

const WINDOW_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

// A ceiling per run, so one sweep cannot run unbounded against the Drive API.
// The next hourly run picks up whatever is left.
const MAX_PER_RUN = 200;

/** Delete one Drive file. A file already gone (404) counts as deleted. */
async function deleteDriveFile(token: string, fileId: string): Promise<boolean> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.ok || res.status === 404) return true;
  console.error(`retention-sweep: delete ${fileId} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  // The caller must present the service-role key — this does destructive work on
  // a schedule and takes no instruction from whoever calls it, so it must not be
  // a route the public can trigger.
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${SERVICE_ROLE}`) {
    return json({ ok: false, error: "Not authorized" }, 401);
  }

  // Every org on a finite retention policy.
  const setRes = await fetch(
    `${REST}/app_settings?select=org_id,photo_retention&photo_retention=in.(24h,7d)`,
    { headers: restHeaders },
  );
  if (!setRes.ok) return json({ ok: false, error: "Could not read settings" }, 500);
  const orgs: Array<{ org_id: string; photo_retention: string }> = await setRes.json();

  let deleted = 0;
  const report: Record<string, number> = {};

  for (const { org_id: orgId, photo_retention: policy } of orgs) {
    const windowMs = WINDOW_MS[policy];
    if (!windowMs || !orgId) continue;
    const cutoff = new Date(Date.now() - windowMs).toISOString();

    // Rows for this org that still hold a file and are past the cutoff.
    const rowsRes = await fetch(
      `${REST}/form_entries?org_id=eq.${orgId}&created_at=lt.${encodeURIComponent(cutoff)}` +
        `&or=(selfie_file_id.not.is.null,license_file_id.not.is.null)` +
        `&select=id,selfie_file_id,license_file_id&order=created_at.asc&limit=${MAX_PER_RUN}`,
      { headers: restHeaders },
    );
    if (!rowsRes.ok) continue;
    const rows: Array<{ id: string; selfie_file_id: string | null; license_file_id: string | null }> =
      await rowsRes.json();
    if (!rows.length) continue;

    // One Drive credential for the org, reused across its rows.
    const integ = await integrationFor(orgId, "google_drive");
    if (!integ || !integ.enabled) continue;
    let token: string;
    try {
      const ga = await googleAuthFor(
        orgId,
        integ.config,
        integ.secret,
        "https://www.googleapis.com/auth/drive",
      );
      token = ga.token;
    } catch (e) {
      console.error(
        `retention-sweep: ${orgId} auth failed: ${e instanceof GoogleAuthError ? e.message : e}`,
      );
      continue;
    }

    for (const row of rows) {
      const patch: Record<string, unknown> = {};
      if (row.selfie_file_id && (await deleteDriveFile(token, row.selfie_file_id))) {
        patch.selfie_file_id = null;
        patch.selfie_link = null;
        patch.selfie_status = "deleted";
        patch.selfie_error = null;
      }
      if (row.license_file_id && (await deleteDriveFile(token, row.license_file_id))) {
        patch.license_file_id = null;
        patch.license_link = null;
        patch.license_status = "deleted";
        patch.license_error = null;
      }
      if (!Object.keys(patch).length) continue;
      await fetch(`${REST}/form_entries?id=eq.${row.id}&org_id=eq.${orgId}`, {
        method: "PATCH",
        headers: restHeaders,
        body: JSON.stringify(patch),
      });
      deleted++;
    }
    report[orgId] = rows.length;
  }

  return json({ ok: true, deleted, orgs: report });
});
