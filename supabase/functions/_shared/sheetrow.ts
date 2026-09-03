// Turning one sign-in into one row of somebody else's spreadsheet.
//
// Separated from the sync so it can be tested without standing up a server,
// and because this is the part that decides which value lands in which column
// — the part where being wrong is silent.

/** The columns written, in the order they are created on an empty sheet. */
export const COLUMNS = [
  "Timestamp",
  "First name",
  "Last name",
  "Email",
  "Phone",
  "Printer",
  "Selfie",
] as const;

export interface RowSource {
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
  selfie_link: string | null;
  printer: { name: string } | null;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Accepts a full sheet URL or a bare id, because both get pasted. */
export function sheetId(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(s) ? s : null;
}

/** A column index as A1 ("A", "B", … "AA"). */
export function colName(i: number): string {
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  }
  return s;
}

/** The values for one sign-in, keyed by the heading each belongs under. */
export function valuesFor(entry: RowSource): Record<string, string> {
  return {
    "timestamp": entry.created_at ?? "",
    "first name": entry.first_name ?? "",
    "last name": entry.last_name ?? "",
    "email": entry.email ?? "",
    "phone": entry.phone ?? "",
    "printer": entry.printer?.name ?? "",
    "selfie": entry.selfie_link ?? "",
  };
}

/**
 * The row to write, laid out to match the sheet's own headings.
 *
 * Never by position. The sheet belongs to the congregation: they will reorder
 * it, insert a column of their own, or delete one they do not want. A
 * positional write would then put phone numbers under Email, silently, for
 * every visitor after the change. The heading is what a column means; its
 * place is theirs to move.
 *
 * A heading this does not recognise gets an empty string rather than being
 * skipped — the row must stay the same width as the header, or the cells after
 * it shift left.
 */
export function rowFor(headers: string[], entry: RowSource): string[] {
  const values = valuesFor(entry);
  return headers.map((h) => values[norm(h)] ?? "");
}

/** Whether any of this sheet's headings are ones we write. */
export function anyKnown(headers: string[]): boolean {
  const values = valuesFor({
    first_name: "",
    last_name: null,
    email: null,
    phone: null,
    created_at: "",
    selfie_link: null,
    printer: null,
  });
  return headers.some((h) => norm(h) in values);
}
