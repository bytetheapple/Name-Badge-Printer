// The prohibited-visitors list: a Google Sheet the facility fills with people
// barred from entry, read and matched against sign-ins for the greeter desk.
import { REST, restHeaders } from "./integration.ts";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

// Column order in the sheet (A..F). Name is matched; phone and email are also
// matched (a definitive hit); DL number and birthdate are not captured as text
// at sign-in, so they are there for the greeter to read off the licence image.
export const PROHIBITED_HEADERS = [
  "First name",
  "Last name",
  "Driver's license number",
  "Birthdate",
  "Phone",
  "Email",
];

export interface ProhibitedEntry {
  first: string;
  last: string;
  dl_number: string;
  birthdate: string;
  phone: string;
  email: string;
}

/** Write (or re-write) the header row. Safe to call on an existing sheet — it
 *  only touches row 1, so it backfills the Phone/Email columns on lists made
 *  before they existed. */
export async function writeProhibitedHeaders(token: string, spreadsheetId: string): Promise<void> {
  await fetch(
    `${SHEETS}/${spreadsheetId}/values/A1:F1?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [PROHIBITED_HEADERS] }),
    },
  );
}

/** Create the prohibited-visitors spreadsheet, write its header row, and record
 *  it on the integration. OAuth only (drive.file reaches what we create). */
export async function createProhibitedSheet(
  token: string,
  integrationId: string,
  config: Record<string, unknown>,
): Promise<{ id: string; url: string }> {
  const title = "Guest Badges — prohibited visitors";
  const res = await fetch(SHEETS, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { title } }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    spreadsheetId?: string;
    spreadsheetUrl?: string;
    error?: { message?: string };
  };
  const id = String(body?.spreadsheetId ?? "");
  if (!res.ok || !id) throw new Error(String(body?.error?.message ?? `HTTP ${res.status}`));
  const url = String(body?.spreadsheetUrl ?? "") ||
    `https://docs.google.com/spreadsheets/d/${id}/edit`;

  // The header row, so the facility knows which column is which.
  await writeProhibitedHeaders(token, id);

  await fetch(`${REST}/integrations?id=eq.${integrationId}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({
      config: {
        ...config,
        spreadsheet_id: id,
        spreadsheet_url: url,
        spreadsheet_title: title,
        sheet_is_ours: true,
      },
    }),
  });
  return { id, url };
}

/** Read the names and match fields from the list, skipping the header and any
 *  row without both names. */
export async function readProhibitedEntries(
  token: string,
  spreadsheetId: string,
): Promise<ProhibitedEntry[]> {
  const res = await fetch(
    `${SHEETS}/${spreadsheetId}/values/A2:F?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Sheets read failed: HTTP ${res.status}`);
  const body = (await res.json()) as { values?: string[][] };
  const rows = body.values ?? [];
  const out: ProhibitedEntry[] = [];
  for (const r of rows) {
    const first = String(r[0] ?? "").trim();
    const last = String(r[1] ?? "").trim();
    if (!first && !last) continue;
    out.push({
      first,
      last,
      dl_number: String(r[2] ?? "").trim(),
      birthdate: String(r[3] ?? "").trim(),
      phone: String(r[4] ?? "").trim(),
      email: String(r[5] ?? "").trim(),
    });
  }
  return out;
}

/** Normalise a name part for matching: lower-case, trimmed, spaces collapsed. */
export function normName(s: string): string {
  return String(s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

/** Normalise a phone to its digits, keeping the last 10 so formatting and a
 *  leading country/trunk code don't defeat an otherwise-equal match. Empty
 *  (unmatchable) when there are fewer than 7 digits. */
export function normPhone(s: string): string {
  const d = String(s ?? "").replace(/\D+/g, "");
  if (d.length < 7) return "";
  return d.length > 10 ? d.slice(-10) : d;
}

/** Normalise an email for matching: lower-case, trimmed. */
export function normEmail(s: string): string {
  return String(s ?? "").trim().toLowerCase();
}

export type ProhibitedLevel = "red" | "yellow" | "green";

export interface ProhibitedMatch {
  level: ProhibitedLevel;
  /** The listed row that produced this level, for the greeter to verify. */
  matched_name: string;
  /** Why it matched: any of "phone", "email", "name". */
  matched_on: string[];
  dl_number: string;
  birthdate: string;
  phone: string;
  email: string;
}

interface Guest {
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
}

/**
 * Classify a sign-in against the prohibited list.
 *
 *  - RED (definitive): the sign-in's phone or email matches a listed one, with
 *    or without a name match — people sign in under false names.
 *  - YELLOW (verify): the name matches and nothing we can check rules it out —
 *    either a bare name on the list, or extra data we cannot compare at sign-in
 *    (DL number, birthdate), which the greeter checks against the licence image.
 *  - GREEN (likely clear): the name matches but a phone/email the guest did
 *    supply disagrees with the listed one — actively ruled out.
 *
 * The most serious level across all rows wins (red > yellow > green), and the
 * row that produced it is returned so the desk can show the greeter why.
 */
export function classifyProhibited(
  guest: Guest,
  rows: ProhibitedEntry[],
): ProhibitedMatch | null {
  const gFirst = normName(guest.first_name);
  const gLast = normName(guest.last_name);
  const gPhone = normPhone(guest.phone);
  const gEmail = normEmail(guest.email);

  const rank: Record<ProhibitedLevel, number> = { green: 1, yellow: 2, red: 3 };
  let best: ProhibitedMatch | null = null;
  const take = (m: ProhibitedMatch) => {
    if (!best || rank[m.level] > rank[best.level]) best = m;
  };

  for (const r of rows) {
    const matchedOn: string[] = [];
    const phoneMatch = gPhone !== "" && normPhone(r.phone) === gPhone;
    const emailMatch = gEmail !== "" && r.email !== "" && normEmail(r.email) === gEmail;
    if (phoneMatch) matchedOn.push("phone");
    if (emailMatch) matchedOn.push("email");

    const info = (level: ProhibitedLevel, on: string[]): ProhibitedMatch => ({
      level,
      matched_name: `${r.first} ${r.last}`.trim(),
      matched_on: on,
      dl_number: r.dl_number,
      birthdate: r.birthdate,
      phone: r.phone,
      email: r.email,
    });

    // Definitive: a contact identifier matches, name or no name.
    if (phoneMatch || emailMatch) {
      take(info("red", matchedOn));
      continue;
    }

    // From here a name match is required for any flag.
    const nameMatch = gFirst !== "" && gLast !== "" &&
      normName(r.first) === gFirst && normName(r.last) === gLast;
    if (!nameMatch) continue;

    // Did a checkable field the guest supplied actively disagree? Only then is
    // it green; otherwise we could not rule them out, so yellow.
    const phoneDisconfirms = gPhone !== "" && normPhone(r.phone) !== "" && !phoneMatch;
    const emailDisconfirms = gEmail !== "" && r.email !== "" && !emailMatch;
    const disconfirmed = phoneDisconfirms || emailDisconfirms;
    take(info(disconfirmed ? "green" : "yellow", ["name"]));
  }

  return best;
}
