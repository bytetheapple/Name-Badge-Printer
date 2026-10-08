// The prohibited-visitors list: a Google Sheet the facility fills with people
// barred from entry, read and matched against sign-ins for the greeter desk.
import { REST, restHeaders } from "./integration.ts";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

export const PROHIBITED_HEADERS = [
  "First name",
  "Last name",
  "Driver's license number",
  "Birthdate",
];

export interface ProhibitedEntry {
  first: string;
  last: string;
  dl_number: string;
  birthdate: string;
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
  await fetch(
    `${SHEETS}/${id}/values/A1:D1?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [PROHIBITED_HEADERS] }),
    },
  );

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

/** Read the names (and verification fields) from the list, skipping the header
 *  and any row without both names. */
export async function readProhibitedEntries(
  token: string,
  spreadsheetId: string,
): Promise<ProhibitedEntry[]> {
  const res = await fetch(
    `${SHEETS}/${spreadsheetId}/values/A2:D?majorDimension=ROWS`,
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
    });
  }
  return out;
}

/** Normalise a name part for matching: lower-case, trimmed, spaces collapsed. */
export function normName(s: string): string {
  return String(s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}
