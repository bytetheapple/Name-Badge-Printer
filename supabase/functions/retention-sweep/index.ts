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

  // Every org with a finite window on either kind of image.
  const setRes = await fetch(
    `${REST}/app_settings?select=org_id,photo_retention,license_retention` +
      `&or=(photo_retention.in.(24h,7d),license_retention.in.(24h,7d))`,
    { headers: restHeaders },
  );
  if (!setRes.ok) return json({ ok: false, error: "Could not read settings" }, 500);
  const orgs: Array<{ org_id: string; photo_retention: string; license_retention: string }> =
    await setRes.json();

  let deleted = 0;
  const report: Record<string, number> = {};

  for (const { org_id: orgId, photo_retention: photoPolicy, license_retention: licensePolicy } of orgs) {
    if (!orgId) continue;

    // One Drive credential for the org, fetched once and reused across both
    // kinds, and only when there is actually something to sweep.
    let token: string | null = null;
    const auth = async (): Promise<string | null> => {
      if (token) return token;
      const integ = await integrationFor(orgId, "google_drive");
      if (!integ || !integ.enabled) return null;
      try {
        token = (await googleAuthFor(
          orgId,
          integ.config,
          integ.secret,
          "https://www.googleapis.com/auth/drive",
        )).token;
        return token;
      } catch (e) {
        console.error(
          `retention-sweep: ${orgId} auth failed: ${e instanceof GoogleAuthError ? e.message : e}`,
        );
        return null;
      }
    };

    // One kind of image, with its own window and columns.
    const sweepKind = async (
      policy: string,
      fileCol: "selfie_file_id" | "license_file_id",
      linkCol: "selfie_link" | "license_link",
      statusCol: "selfie_status" | "license_status",
      errorCol: "selfie_error" | "license_error",
    ) => {
      const windowMs = WINDOW_MS[policy];
      if (!windowMs) return;
      const cutoff = new Date(Date.now() - windowMs).toISOString();
      const rowsRes = await fetch(
        `${REST}/form_entries?org_id=eq.${orgId}&created_at=lt.${encodeURIComponent(cutoff)}` +
          `&${fileCol}=not.is.null&select=id,${fileCol}&order=created_at.asc&limit=${MAX_PER_RUN}`,
        { headers: restHeaders },
      );
      if (!rowsRes.ok) return;
      const rows: Array<Record<string, string>> = await rowsRes.json();
      if (!rows.length) return;
      const t = await auth();
      if (!t) return;
      for (const row of rows) {
        if (!(await deleteDriveFile(t, row[fileCol]))) continue;
        await fetch(`${REST}/form_entries?id=eq.${row.id}&org_id=eq.${orgId}`, {
          method: "PATCH",
          headers: restHeaders,
          body: JSON.stringify({
            [fileCol]: null,
            [linkCol]: null,
            [statusCol]: "deleted",
            [errorCol]: null,
          }),
        });
        deleted++;
      }
      report[`${orgId}:${fileCol}`] = rows.length;
    };

    await sweepKind(photoPolicy, "selfie_file_id", "selfie_link", "selfie_status", "selfie_error");
    await sweepKind(licensePolicy, "license_file_id", "license_link", "license_status", "license_error");
  }

  return json({ ok: true, deleted, swept: report });
});
