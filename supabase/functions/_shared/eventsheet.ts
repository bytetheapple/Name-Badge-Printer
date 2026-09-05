// The spreadsheet behind an Event integration.
//
// Two tabs, both made by us so the column names are known: matching a person
// against a sheet whose headings someone may rename is a silent no-match, and
// a silent no-match at a registration desk means a pre-registered guest is
// quietly recorded as a walk-in.
//
//   Pre-registered        First name | Last name | Cell phone | Email | Checked in
//   On-site registration  First name | Last name | Cell phone | Email | Registered
//
// "Checked in" is a timestamp rather than a tick: it answers when somebody
// arrived as well as whether, and the desk usually wants both.
import { REST, restHeaders } from "./integration.ts";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

export const PREREG_TAB = "Pre-registered";
export const ONSITE_TAB = "On-site registration";
export const HEADERS = ["First name", "Last name", "Cell phone", "Email"];
const PREREG_HEADERS = [...HEADERS, "Checked in"];
const ONSITE_HEADERS = [...HEADERS, "Registered"];
/** Column the check-in time goes in; fifth, so column E. */
const CHECKED_COL = "E";

/**
 * What the event's spreadsheet is called.
 *
 * One function rather than a literal in each place, because the title is
 * derived from the event's name and the two have to agree: a rename that
 * moves one and not the other leaves a customer with a list they cannot find
 * by name.
 */
export function eventSheetTitle(eventName: string): string {
  return `${(eventName || "Event").trim()} registration`;
}

export interface Person {
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
}

export interface Match {
  /** 1-based row in the sheet, header included, which is what A1 notation wants. */
  row: number;
  /** Which field matched, for the activity log. */
  on: "phone" | "email" | "name";
  /** Already checked in when we found them. A second badge is not an error,
   *  people lose them, but it is worth not overwriting the first arrival. */
  already: boolean;
}

/**
 * Digits only, last ten. Formatting differs between a sheet somebody typed by
 * hand and a form that formats as you type, and comparing those literally is a
 * guaranteed miss.
 */
export function phoneKey(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function emailKey(raw: string): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function nameKey(first: string, last: string): string {
  const f = String(first ?? "").trim().toLowerCase();
  const l = String(last ?? "").trim().toLowerCase();
  return `${f} ${l}`;
}

async function sheetsFetch(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${SHEETS}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as { error?: { message?: string } })?.error?.message;
    throw new Error(String(message ?? `HTTP ${res.status}`));
  }
  return body;
}

/**
 * Create the event's spreadsheet, with both tabs and their headings.
 *
 * Only meaningful on an OAuth token: `drive.file` reaches what this
 * application created, so creating the sheet is what earns the right to write
 * to it later.
 */
export async function createEventSpreadsheet(
  token: string,
  integrationId: string,
  config: Record<string, unknown>,
  eventName: string,
): Promise<{ id: string; url: string; title: string }> {
  const title = eventSheetTitle(eventName);
  const made = await sheetsFetch(token, "", {
    method: "POST",
    body: JSON.stringify({
      properties: { title },
      sheets: [
        { properties: { title: PREREG_TAB } },
        { properties: { title: ONSITE_TAB } },
      ],
    }),
  }) as { spreadsheetId?: string; spreadsheetUrl?: string };

  const id = String(made?.spreadsheetId ?? "");
  if (!id) throw new Error("Google did not return a spreadsheet id.");
  const url = String(made?.spreadsheetUrl ?? "") ||
    `https://docs.google.com/spreadsheets/d/${id}/edit`;

  // Headings in one batch. Written after creation rather than as part of it,
  // because the create call takes sheet properties and not cell values.
  await sheetsFetch(token, `/${id}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: [
        { range: `${PREREG_TAB}!A1`, values: [PREREG_HEADERS] },
        { range: `${ONSITE_TAB}!A1`, values: [ONSITE_HEADERS] },
      ],
    }),
  });

  await fetch(`${REST}/integrations?id=eq.${integrationId}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({
      // Merged, not replaced: PostgREST writes the column whole, and sending
      // only the new keys would drop everything else the event holds.
      config: {
        ...config,
        spreadsheet_id: id,
        spreadsheet_url: url,
        spreadsheet_title: title,
        sheet_is_ours: true,
      },
    }),
  });
  return { id, url, title };
}

/**
 * Find someone on the pre-registration list.
 *
 * Phone first, because it is the field people give most consistently and the
 * one least likely to collide. But an organizer may not have collected phone
 * numbers at all, and a particular registrant may not have given one, so a row
 * with no phone falls through to email and then to first and last name
 * together. Each rule applies only where both sides have the field: matching
 * an empty phone against an empty phone would check off the first blank row in
 * the sheet.
 */
export async function findAttendee(
  token: string,
  spreadsheetId: string,
  person: Person,
): Promise<Match | null> {
  const range = encodeURIComponent(`${PREREG_TAB}!A2:E`);
  const body = await sheetsFetch(
    token,
    `/${spreadsheetId}/values/${range}`,
  ) as { values?: string[][] };
  const rows = Array.isArray(body?.values) ? body.values : [];

  const wantPhone = phoneKey(person.phone);
  const wantEmail = emailKey(person.email);
  const wantName = nameKey(person.first_name, person.last_name);
  const hasName = wantName.replace(/ /g, "") !== "";

  // Three passes rather than one, so a phone match anywhere in the sheet beats
  // a name match higher up it. Names collide, two Dan Cohens at one event is
  // ordinary, and the strongest evidence should win wherever it sits.
  const passes: Array<(row: string[]) => boolean> = [
    (row) => Boolean(wantPhone) && phoneKey(row[2] ?? "") === wantPhone,
    (row) => Boolean(wantEmail) && emailKey(row[3] ?? "") === wantEmail,
    (row) => hasName && nameKey(row[0] ?? "", row[1] ?? "") === wantName,
  ];
  const on: Array<Match["on"]> = ["phone", "email", "name"];

  for (let p = 0; p < passes.length; p++) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !passes[p](row)) continue;
      return { row: i + 2, on: on[p], already: String(row[4] ?? "").trim() !== "" };
    }
  }
  return null;
}

/** Stamp the arrival time beside a pre-registered guest. */
export async function checkIn(
  token: string,
  spreadsheetId: string,
  row: number,
  when: string,
): Promise<void> {
  const range = encodeURIComponent(`${PREREG_TAB}!${CHECKED_COL}${row}`);
  await sheetsFetch(
    token,
    `/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values: [[when]] }) },
  );
}

/** Add somebody who was not on the list. */
export async function appendOnsite(
  token: string,
  spreadsheetId: string,
  person: Person,
  when: string,
): Promise<void> {
  const range = encodeURIComponent(`${ONSITE_TAB}!A1`);
  await sheetsFetch(
    token,
    `/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      body: JSON.stringify({
        values: [[
          person.first_name,
          person.last_name,
          person.phone,
          person.email,
          when,
        ]],
      }),
    },
  );
}

/**
 * Rename the spreadsheet to follow the event.
 *
 * Covered by drive.file: the scope reaches files this application created,
 * which is exactly the ones this is ever called on. Returns the new title so
 * the caller can record it beside the id.
 */
export async function renameEventSpreadsheet(
  token: string,
  spreadsheetId: string,
  eventName: string,
): Promise<string> {
  const title = eventSheetTitle(eventName);
  await sheetsFetch(token, `/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        { updateSpreadsheetProperties: { properties: { title }, fields: "title" } },
      ],
    }),
  });
  return title;
}
