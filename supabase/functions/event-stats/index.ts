// How an event is going: on the list, arrived, and walked in.
//
// Read-only, and counted from the spreadsheet rather than from anything we
// keep. The organizer pastes the guest list into that sheet and may edit it
// while the event is running, so a total we maintained ourselves would
// disagree with what they are looking at within a minute of them touching it.
//
// Signed in as a person, not as a bridge: this is a console view. An admin or
// owner of the organization may see it, and so may a platform operator —
// unlike connecting a Google account, reading a count on somebody's behalf is
// exactly what support is for.
import { corsHeaders, json } from "../_shared/cors.ts";
import { countAttendees } from "../_shared/eventsheet.ts";
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

async function callerOf(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  return (await res.json())?.id ?? null;
}

/** Whether this person may see this organization's numbers. */
async function mayRead(userId: string, orgId: string): Promise<boolean> {
  const member = await fetch(
    `${REST}/memberships?org_id=eq.${orgId}&user_id=eq.${userId}&select=role`,
    { headers: restHeaders },
  );
  if (member.ok) {
    const rows = await member.json();
    const role = rows.length ? String(rows[0].role) : "";
    if (role === "owner" || role === "admin") return true;
  }
  // An operator belongs to no organization, which is the point of the split.
  // They still support these events, and a count is the least of what they
  // can already see about a customer.
  const operator = await fetch(
    `${REST}/platform_admins?user_id=eq.${userId}&select=user_id`,
    { headers: restHeaders },
  );
  return operator.ok && (await operator.json()).length > 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const userId = await callerOf(req);
  if (!userId) return json({ ok: false, error: "Not signed in" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }
  const integrationId = String(body.integration_id ?? "");
  if (!integrationId) return json({ ok: false, error: "integration_id is required" }, 400);

  const rowRes = await fetch(
    `${REST}/integrations?id=eq.${integrationId}&kind=eq.event&select=id,org_id,config`,
    { headers: restHeaders },
  );
  const row = rowRes.ok ? (await rowRes.json())[0] : null;
  if (!row) return json({ ok: false, error: "No such event" }, 404);
  // The organization comes off the row, never out of the request. A caller who
  // knows an id must still be somebody who may read that org's numbers.
  if (!(await mayRead(userId, String(row.org_id)))) {
    return json({ ok: false, error: "Not allowed" }, 403);
  }

  const config = (row.config ?? {}) as Record<string, unknown>;
  const spreadsheetId = String(config.spreadsheet_id ?? "");
  // No list yet is not an error: it is an event nobody has used, and zeroes
  // are the honest answer rather than a failure the console has to explain.
  if (!spreadsheetId) {
    return json({ ok: true, registered: 0, signed_in: 0, onsite: 0, no_list: true });
  }

  try {
    const auth = await googleAuthFor(String(row.org_id), config, null, "");
    const counts = await countAttendees(auth.token, spreadsheetId);
    return json({ ok: true, ...counts });
  } catch (e) {
    const msg = e instanceof GoogleAuthError ? e.message : String(e);
    return json({ ok: false, error: msg });
  }
});
