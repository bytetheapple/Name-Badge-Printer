// Registering somebody at an event desk.
//
// Public, because it answers a printed QR code. What it does, in order:
//
//   1. Resolve the code to an event, an organization and a printer.
//   2. Match the person against the pre-registration tab.
//   3. Check them off, or add them to the on-site tab.
//   4. Queue a badge, on the scanned printer or on the on-site printer.
//
// Step 2 decides where the badge prints and what it says, so it happens
// before the badge is queued rather than in a background sync. A registration
// desk hands over a badge within seconds and cannot be told afterwards that
// the person was on the list all along.
//
// If Google is unreachable the badge still prints. Somebody standing at a desk
// with a queue behind them is better served by a badge and a gap in the
// spreadsheet than by an error: the sheet can be reconciled later, the queue
// cannot.
import { corsHeaders, json } from "../_shared/cors.ts";
import { checkSubmitAllowed } from "../_shared/kiosk.ts";
import { googleAuthFor } from "../_shared/google.ts";
import {
  appendOnsite,
  checkIn,
  createEventSpreadsheet,
  findAttendee,
  type Person,
} from "../_shared/eventsheet.ts";
import { CLOSED, resolveEventCode } from "../_shared/eventcode.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = `${SUPABASE_URL}/rest/v1`;
const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Printed in the corner of the header for anyone not on the list. */
const ONSITE_NOTE = "ON-SITE";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  const firstName = String(body.first_name ?? "").trim();
  const lastName = String(body.last_name ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const email = String(body.email ?? "").trim();
  // Asked the same way the sign-in form asks it, and meaning the same thing.
  const wantsFollowup = body.wants_followup === true;

  // Both are required here, unlike the sign-in form. The organizer may not
  // have collected either, so the list may be thin on both -- which is exactly
  // why the person in front of us should be asked for both.
  if (!firstName) return json({ ok: false, error: "Please enter your first name." });
  if (!lastName) return json({ ok: false, error: "Please enter your last name." });
  if (!phone) return json({ ok: false, error: "Please enter your cell phone number." });
  if (!email) return json({ ok: false, error: "Please enter your email address." });
  if (firstName.length > 60 || lastName.length > 60) {
    return json({ ok: false, error: "That name is too long." });
  }
  if (phone.length > 40) return json({ ok: false, error: "That phone number is too long." });
  if (!EMAIL_RE.test(email)) {
    return json({ ok: false, error: "Please enter a valid email address." });
  }

  const code = await resolveEventCode(String(body.token ?? ""));
  if (!code) {
    return json(
      { ok: false, error: CLOSED },
      400,
    );
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const limited = await checkSubmitAllowed(
    { org_id: code.org_id, printer_id: code.printer_id, printer_name: null, via: "kiosk_token" },
    ip,
    1,
  );
  if (limited) return json({ ok: false, error: limited }, 429);

  const person: Person = {
    first_name: firstName,
    last_name: lastName,
    phone,
    email,
  };

  // ---- the list -----------------------------------------------------------
  // `onsite` is the decision everything below hangs on, so it defaults to the
  // safe answer. If the sheet cannot be read we do not know whether this
  // person registered, and treating an unknown as pre-registered would hand
  // out a badge that says somebody has already paid.
  let onsite = true;
  let matchedOn: string | null = null;
  let sheetError: string | null = null;
  const when = new Date().toISOString();

  try {
    const auth = await googleAuthFor(code.org_id, code.config, null, SCOPE);
    let spreadsheetId = String(code.config.spreadsheet_id ?? "");
    if (!spreadsheetId) {
      // A safety net, not the normal path: the list is made when the event is
      // created, so that a pre-registered guest list can be pasted into it
      // beforehand. Getting here means that failed and nobody noticed, and a
      // desk with a queue is the wrong place to find out -- so make it now and
      // carry on. Everyone then lands on the on-site tab, which is the correct
      // record of what actually happened.
      const made = await createEventSpreadsheet(
        auth.token,
        code.integration_id,
        code.config,
        code.event_name,
      );
      spreadsheetId = made.id;
    }

    const match = await findAttendee(auth.token, spreadsheetId, person);
    if (match) {
      onsite = false;
      matchedOn = match.on;
      // Not overwritten when they have already been checked in: people lose
      // badges and come back, and the first arrival is the true one.
      if (!match.already) await checkIn(auth.token, spreadsheetId, match.row, when);
    } else {
      await appendOnsite(auth.token, spreadsheetId, person, when);
    }
  } catch (e) {
    // Recorded, not raised. See the note at the top: the badge matters more
    // than the spreadsheet at the moment somebody is standing at a desk.
    sheetError = e instanceof Error ? e.message : String(e);
  }

  // ---- where it prints ----------------------------------------------------
  // On-site badges may go to a printer of their own, typically behind the desk
  // so an administrator can collect payment before handing one over. When they
  // do, every code routes there, whichever one was scanned.
  const sameprinter = code.config.onsite_same_printer !== false;
  const onsitePrinter = String(code.config.onsite_printer_id ?? "");
  const printerId = onsite && !sameprinter && onsitePrinter ? onsitePrinter : code.printer_id;

  const entryRes = await fetch(`${REST}/form_entries`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({
      org_id: code.org_id,
      first_name: firstName,
      last_name: lastName,
      phone,
      email,
      // Everyone at an event desk is a guest of it. The word drives the
      // inverted header on the ordinary badge, and an event badge is never
      // inverted, so this is a record rather than an instruction.
      visitor_type: "visitor",
      wants_followup: wantsFollowup,
      printer_id: printerId,
      event_integration_id: code.integration_id,
      is_primary: true,
      google_sync_status: "pending",
      shulcloud_sync_status: "pending",
      source_ip: ip,
    }),
  });
  if (!entryRes.ok) return json({ ok: false, error: "Could not save your details." }, 500);
  const [entry] = await entryRes.json();

  const jobRes = await fetch(`${REST}/print_jobs`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({
      org_id: code.org_id,
      entry_id: entry.id,
      printer_id: printerId,
      type: "badge",
      status: "queued",
      corner_note: onsite ? ONSITE_NOTE : null,
    }),
  });
  if (!jobRes.ok) return json({ ok: false, error: "Could not start the print." }, 500);
  const [job] = await jobRes.json();

  // The visitor-facing destinations still apply: an event guest who ticked the
  // box is as interested as one who ticked it in the lobby.
  triggerSync("google-sync", entry.id);
  triggerSync("shulcloud-sync", entry.id);
  triggerSync("google-sheet-sync", entry.id);

  return json({
    ok: true,
    job_ids: [job.id],
    onsite,
    matched_on: matchedOn,
    // Told plainly rather than hidden. The desk needs to know the sheet did
    // not take it, because that is the one thing they can still write down.
    sheet_error: sheetError,
  });
});

/** Fire a background sync without blocking the response. */
function triggerSync(fn: string, entryId: string) {
  const task = fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
    body: JSON.stringify({ entry_id: entryId }),
  }).catch(() => {});
  const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(task);
}
