// Making the spreadsheet an organization's sign-ins go into.
//
// Shared because it happens in two places now — when the destination is
// configured, so the operator gets a link straight away, and on the first
// sign-in if it somehow was not. Two copies would drift on the thing that
// matters most: recording, in the same write, that this sheet is one we made
// and may therefore write to.
import { REST, restHeaders } from "./integration.ts";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

export interface MadeSheet {
  id: string;
  url: string;
}

/**
 * Create a spreadsheet in the connected account's Drive and record it.
 *
 * Only meaningful on an OAuth token. `drive.file` reaches what this
 * application created, so creating the sheet is what earns the right to write
 * to it — and a service account creating one would put a congregation's
 * sign-ins in a Drive no person can open.
 */
export async function createSpreadsheet(
  token: string,
  integrationId: string,
  config: Record<string, unknown>,
): Promise<MadeSheet> {
  const res = await fetch(SHEETS, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { title: "Guest Badges — visitor sign-ins" } }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    spreadsheetId?: string;
    spreadsheetUrl?: string;
    error?: { message?: string };
  };
  const id = String(body?.spreadsheetId ?? "");
  if (!res.ok || !id) {
    throw new Error(String(body?.error?.message ?? `HTTP ${res.status}`));
  }
  // Derived when Google does not volunteer it: a spreadsheet's address is a
  // function of its id, and an absent field once became an empty string that
  // rendered as a link to the page you were already on.
  const url = String(body?.spreadsheetUrl ?? "") ||
    `https://docs.google.com/spreadsheets/d/${id}/edit`;

  await fetch(`${REST}/integrations?id=eq.${integrationId}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({
      // Merged, not replaced: PostgREST writes the column whole, and sending
      // only the new keys would drop everything else the destination holds.
      config: {
        ...config,
        spreadsheet_id: id,
        spreadsheet_url: url,
        // What tells this sheet apart from one configured by hand, which an
        // OAuth token cannot reach at all.
        sheet_is_ours: true,
        ...(config.spreadsheet_id && config.spreadsheet_id !== id
          ? { previous_spreadsheet_id: config.spreadsheet_id }
          : {}),
      },
    }),
  });
  return { id, url };
}
