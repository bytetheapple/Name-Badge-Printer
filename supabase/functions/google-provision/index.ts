// Make whatever a destination needs, now, rather than on the first visitor.
//
// Two jobs, both owner-only:
//
//   sheet   create the spreadsheet for a Google Sheet destination, so the
//           operator gets a link while they are still looking at the page
//           instead of after somebody signs in.
//
//   drive   make sure the photographs destination exists at all. It carries no
//           settings — it is the row per-printer routing and delivery records
//           attach to — so it is created here rather than asked for.
import { corsHeaders, json } from "../_shared/cors.ts";
import { createSpreadsheet } from "../_shared/gsheets.ts";
import { googleAuthFor, GoogleAuthError } from "../_shared/google.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

async function callerOf(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  return (await res.json())?.id ?? null;
}

async function roleIn(userId: string, orgId: string): Promise<string | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/memberships?org_id=eq.${orgId}&user_id=eq.${userId}&select=role`,
    { headers: restHeaders },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? String(rows[0].role) : null;
}

/** The photographs destination, made if this organization has none. */
async function ensureDrive(orgId: string): Promise<string | null> {
  const found = await fetch(
    `${SUPABASE_URL}/rest/v1/integrations?org_id=eq.${orgId}&kind=eq.google_drive` +
      `&select=id&order=created_at.asc&limit=1`,
    { headers: restHeaders },
  );
  const rows = found.ok ? await found.json() : [];
  if (rows.length) return String(rows[0].id);

  const made = await fetch(`${SUPABASE_URL}/rest/v1/integrations`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify({
      org_id: orgId,
      kind: "google_drive",
      name: "Visitor photographs",
      // Enabled, because nothing follows from it until an admin switches
      // photographs on in Settings, which is off until they do.
      enabled: true,
      default_enabled: true,
      config: {},
    }),
  });
  if (!made.ok) return null;
  const created = await made.json();
  return created.length ? String(created[0].id) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const userId = await callerOf(req);
  if (!userId) return json({ ok: false, error: "Not signed in" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }
  const orgId = String(body.org_id ?? "");
  const what = String(body.what ?? "");
  if (!orgId) return json({ ok: false, error: "org_id is required" }, 400);

  // Owner, matching the RLS on integrations and the rule that connecting an
  // account is the owner's job. An admin gets told which it is rather than a
  // bare refusal — they are trying to switch on a feature, not break in.
  const role = await roleIn(userId, orgId);
  if (role !== "owner") {
    return json({
      ok: false,
      needs_owner: true,
      error: "Connecting a Google account is an owner's job. Ask an owner of this " +
        "organization to do it, and photographs can be switched on afterwards.",
    }, 403);
  }

  if (what === "drive") {
    const id = await ensureDrive(orgId);
    if (!id) return json({ ok: false, error: "Could not prepare the photographs destination" }, 500);
    return json({ ok: true, integration_id: id });
  }

  if (what === "sheet") {
    const integrationId = String(body.integration_id ?? "");
    if (!integrationId) return json({ ok: false, error: "integration_id is required" }, 400);
    const rowRes = await fetch(
      `${SUPABASE_URL}/rest/v1/integrations?id=eq.${integrationId}&org_id=eq.${orgId}` +
        `&kind=eq.google_sheet&select=id,config`,
      { headers: restHeaders },
    );
    const row = rowRes.ok ? (await rowRes.json())[0] : null;
    if (!row) return json({ ok: false, error: "No such Google Sheet destination" }, 404);

    const config = (row.config ?? {}) as Record<string, unknown>;
    if (config.sheet_is_ours === true && config.spreadsheet_id) {
      return json({ ok: true, already: true, url: config.spreadsheet_url ?? null });
    }

    try {
      const auth = await googleAuthFor(orgId, config, null, "");
      if (auth.kind !== "oauth") {
        return json({ ok: false, error: "This needs a connected Google account." }, 400);
      }
      const made = await createSpreadsheet(auth.token, integrationId, config);
      return json({ ok: true, url: made.url, spreadsheet_id: made.id });
    } catch (e) {
      const msg = e instanceof GoogleAuthError ? e.message : String(e);
      return json({ ok: false, needs_connect: e instanceof GoogleAuthError, error: msg });
    }
  }

  return json({ ok: false, error: "Nothing to do" }, 400);
});
