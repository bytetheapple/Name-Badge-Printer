// Print a badge for every guest on an event's pre-registration list.
//
// An owner or admin presses this to run off all the badges ahead of the doors
// opening, instead of each guest scanning at the desk. It reads the event's
// pre-registration tab and queues one badge per guest, routed to a printer the
// operator chooses. The badges are identical to the ones the desk prints — a
// real sign-in entry (visitor, linked to the event, so the event's header
// graphic applies) with a badge job behind it.
//
// Deliberately NOT a check-in: pre-printing happens before anyone arrives, so
// it does not stamp the sheet or tell any destination the guest has attended.
// Attendance is still recorded when they actually arrive and scan.
import { corsHeaders, json } from "../_shared/cors.ts";
import { googleAuthFor, googleFailure } from "../_shared/google.ts";
import { readPreregistered } from "../_shared/eventsheet.ts";

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
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
// A guard against a runaway: a pre-registration list this long is a mistake
// (a wrong sheet, a pasted database) rather than an event, and queuing that
// many jobs ties up the printer for an afternoon.
const MAX_BADGES = 1000;
// Only an owner or admin may run off a whole event's badges.
const MAY_MANAGE = new Set(["owner", "admin"]);

/** The signed-in caller, from their JWT — never from the request body. */
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

/** The caller's role in one org, from the database. */
async function roleInOrg(userId: string, orgId: string): Promise<string | null> {
  const res = await fetch(
    `${REST}/memberships?org_id=eq.${orgId}&user_id=eq.${userId}&select=role`,
    { headers: restHeaders },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? String(rows[0].role) : null;
}

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
  const orgId = String(body.org_id ?? "").trim();
  const integrationId = String(body.integration_id ?? "").trim();
  const printerId = String(body.printer_id ?? "").trim();
  if (!UUID_RE.test(orgId)) return json({ ok: false, error: "Invalid organization" }, 400);
  if (!UUID_RE.test(integrationId)) return json({ ok: false, error: "Invalid event" }, 400);
  if (!UUID_RE.test(printerId)) return json({ ok: false, error: "Choose a printer first." }, 400);

  const role = await roleInOrg(caller, orgId);
  if (!role || !MAY_MANAGE.has(role)) {
    return json({ ok: false, error: "Only an owner or admin can print a whole event." }, 403);
  }

  // The event, and its attendee list.
  const evRes = await fetch(
    `${REST}/integrations?id=eq.${integrationId}&org_id=eq.${orgId}&kind=eq.event` +
      `&select=config`,
    { headers: restHeaders },
  );
  const event = evRes.ok ? (await evRes.json())[0] : null;
  if (!event) return json({ ok: false, error: "No such event" }, 404);
  const config = (event.config ?? {}) as Record<string, unknown>;
  const spreadsheetId = String(config.spreadsheet_id ?? "");
  if (!spreadsheetId) {
    return json({ ok: false, error: "This event has no attendee list yet." }, 400);
  }

  // The printer must belong to this organization.
  const prRes = await fetch(
    `${REST}/printers?id=eq.${printerId}&org_id=eq.${orgId}&select=id,name`,
    { headers: restHeaders },
  );
  const printer = prRes.ok ? (await prRes.json())[0] : null;
  if (!printer) return json({ ok: false, error: "That printer is not in this organization." }, 400);

  // The pre-registration list.
  let people;
  try {
    const auth = await googleAuthFor(orgId, config, null, SCOPE);
    people = await readPreregistered(auth.token, spreadsheetId);
  } catch (e) {
    return json({ ok: false, ...googleFailure(e) });
  }

  if (people.length === 0) {
    return json({ ok: true, count: 0, printer_name: printer.name ?? null });
  }
  if (people.length > MAX_BADGES) {
    return json({
      ok: false,
      error: `That list has ${people.length} rows — more than ${MAX_BADGES}. ` +
        "Check it is the right sheet before printing this many badges.",
    }, 400);
  }

  // One sign-in entry per guest, then one badge per entry — the same shape the
  // desk produces, so the badges match. Written in bulk (one insert each)
  // rather than per guest: a list of several hundred would otherwise be several
  // hundred round trips.
  const entryRows = people.map((p) => ({
    org_id: orgId,
    first_name: p.first_name,
    last_name: p.last_name,
    phone: p.phone,
    email: p.email,
    // A guest of the event, like every event registration — this drives the
    // same badge styling the desk's badges get.
    visitor_type: "visitor",
    printer_id: printerId,
    event_integration_id: integrationId,
    is_primary: true,
    // Pre-printed, not arrived: left pending and unsynced on purpose, so no
    // destination is told the guest has attended before they have.
    google_sync_status: "pending",
    shulcloud_sync_status: "pending",
  }));

  const entriesRes = await fetch(`${REST}/form_entries`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify(entryRows),
  });
  if (!entriesRes.ok) {
    return json({ ok: false, error: "Could not create the badge records." }, 500);
  }
  const entries = await entriesRes.json() as Array<{ id: string }>;

  const jobRows = entries.map((e) => ({
    org_id: orgId,
    entry_id: e.id,
    printer_id: printerId,
    type: "badge",
    status: "queued",
  }));
  const jobsRes = await fetch(`${REST}/print_jobs`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify(jobRows),
  });
  if (!jobsRes.ok) {
    return json({ ok: false, error: "Saved the guests but could not queue the badges." }, 500);
  }

  return json({ ok: true, count: entries.length, printer_name: printer.name ?? null });
});
