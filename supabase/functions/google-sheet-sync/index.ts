// Writes one visitor sign-in as one row of a Google Sheet.
//
// The congregation owns the sheet: they create it in their own Drive and share
// it with a service account. This never creates one. A sheet created by a
// service account lives in a Drive no person can open, cannot have its
// ownership handed over cleanly, and is orphaned the day that key is rotated —
// which is not where a congregation's visitor log should live.
//
// Members are never sent. That is decided at submit-badge, where the same rule
// is applied to the Google Form and ShulCloud syncs.
import { corsHeaders, json } from "../_shared/cors.ts";
import {
  explainGoogleError,
  type GoogleAuth,
  googleAuthFor,
  GoogleAuthError,
} from "../_shared/google.ts";
import { anyKnown, colName, COLUMNS, rowFor, sheetId } from "../_shared/sheetrow.ts";
import {
  recordDelivery,
  REST,
  restHeaders,
  rollUp,
  type Target,
  targetsFor,
} from "../_shared/integration.ts";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

interface Entry {
  id: string;
  org_id: string;
  wants_followup: boolean;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
  selfie_link: string | null;
  printer: { name: string } | null;
}

async function sheetsFetch(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${SHEETS}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch { /* an empty body is fine on some writes */ }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Make the sheet, in the customer's own Drive.
 *
 * Only possible on an OAuth connection, and it is the reason that path exists:
 * `drive.file` reaches what this application created, so creating the sheet is
 * what earns the right to write to it. A service account cannot do this
 * usefully — the file would land in a Drive no person can open.
 */
async function createSheet(
  token: string,
  integrationId: string,
  config: Record<string, unknown>,
): Promise<string> {
  const create = await fetch(SHEETS, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { title: "Guest Badges — visitor sign-ins" } }),
  });
  const res = {
    ok: create.ok,
    status: create.status,
    body: (await create.json().catch(() => ({}))) as Record<string, unknown>,
  };
  const id = String((res.body as { spreadsheetId?: string })?.spreadsheetId ?? "");
  if (!res.ok || !id) throw new Error(explainGoogleError(res.status, res.body, "", "sheets.googleapis.com"));

  // Written back so the next sign-in appends to this sheet rather than making
  // another one. A second sheet per visitor would be a quiet disaster.
  await fetch(`${REST}/integrations?id=eq.${integrationId}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({
      // Merged, not replaced. PostgREST writes the column whole, so sending
      // only the new keys would drop use_oauth, tab_name and everything else
      // this destination was configured with.
      config: {
        ...config,
        spreadsheet_id: id,
        // Derived when Google does not volunteer it. A spreadsheet's address is
        // a function of its id, so depending on the response for it buys
        // nothing and produces an empty string when the field is absent — which
        // renders as a link to nowhere.
        spreadsheet_url: String((res.body as { spreadsheetUrl?: string })?.spreadsheetUrl ?? "") ||
          `https://docs.google.com/spreadsheets/d/${id}/edit`,
        sheet_is_ours: true,
        // Kept rather than overwritten: it is where the organization's earlier
        // sign-ins are, and the only record of that once this field moves on.
        ...(config.spreadsheet_id && config.spreadsheet_id !== id
          ? { previous_spreadsheet_id: config.spreadsheet_id }
          : {}),
      },
    }),
  });
  return id;
}

async function sendTo(entry: Entry, t: Target): Promise<{ ok: boolean; error?: string }> {
  const tab = String(t.config.tab_name ?? "").trim();

  let auth: GoogleAuth;
  try {
    auth = await googleAuthFor(entry.org_id, t.config, t.secret, SCOPE);
  } catch (e) {
    return { ok: false, error: e instanceof GoogleAuthError ? e.message : String(e) };
  }
  const token = auth.token;
  const saEmail = auth.kind === "service_account" ? auth.email : "";

  let id = sheetId(String(t.config.spreadsheet_id ?? ""));

  // On a connection we can only write to a sheet we made. A link configured
  // under the service-account setup points at one the customer made and shared
  // — invisible to this token — so switching over means making a new sheet,
  // not failing against the old one with a permission error nobody can act on.
  //
  // `sheet_is_ours` is how we tell the two apart: set when we create one, and
  // absent on every sheet configured by hand before this existed.
  const oursAlready = t.config.sheet_is_ours === true;
  const needsOwnSheet = auth.kind === "oauth" && (!id || !oursAlready);

  if (needsOwnSheet) {
    try {
      id = await createSheet(token, t.id, t.config);
    } catch (e) {
      return { ok: false, error: `Could not create the sheet: ${e}` };
    }
  } else if (!id) {
    return { ok: false, error: "No sheet link is set for this destination." };
  }

  // 1. The headings. A sheet the congregation made is empty, so write them
  //    once; a sheet that already has them keeps whatever it has, including
  //    columns of their own that this does not fill in.
  const headRange = `${tab ? `'${tab}'!` : ""}1:1`;
  const head = await sheetsFetch(token, `${id}/values/${encodeURIComponent(headRange)}`);
  if (!head.ok) return { ok: false, error: explainGoogleError(head.status, head.body, saEmail) };

  let headers = (((head.body.values as string[][]) ?? [])[0] ?? []).map(String);
  if (headers.filter((h) => h.trim()).length === 0) {
    const put = await sheetsFetch(
      token,
      `${id}/values/${encodeURIComponent(headRange)}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values: [COLUMNS] }) },
    );
    if (!put.ok) return { ok: false, error: explainGoogleError(put.status, put.body, saEmail) };
    headers = [...COLUMNS];
  }

  const row = rowFor(headers, entry);
  // Every heading was one of theirs — nothing of ours to write.
  if (!anyKnown(headers)) {
    return {
      ok: false,
      error: "Row 1 of that sheet has none of the headings this writes " +
        `(${COLUMNS.join(", ")}). Rename a column, or clear row 1 and they will be created.`,
    };
  }

  // 2. Where it goes. A row already written for this sign-in is updated in
  //    place: the selfie arrives after the sign-in does, and a resend from the
  //    Entries table must not add the same visitor twice.
  const existing = await fetch(
    `${REST}/entry_deliveries?entry_id=eq.${entry.id}&integration_id=eq.${t.id}&select=ref`,
    { headers: restHeaders },
  );
  const ref = existing.ok ? ((await existing.json())[0]?.ref ?? null) : null;

  if (ref) {
    const put = await sheetsFetch(
      token,
      `${id}/values/${encodeURIComponent(ref)}?valueInputOption=USER_ENTERED`,
      { method: "PUT", body: JSON.stringify({ values: [row] }) },
    );
    if (!put.ok) return { ok: false, error: explainGoogleError(put.status, put.body, saEmail) };
    return { ok: true };
  }

  const lastCol = colName(Math.max(headers.length, 1) - 1);
  const appendRange = `${tab ? `'${tab}'!` : ""}A:${lastCol}`;
  const app = await sheetsFetch(
    token,
    `${id}/values/${encodeURIComponent(appendRange)}:append` +
      `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: [row] }) },
  );
  if (!app.ok) return { ok: false, error: explainGoogleError(app.status, app.body, saEmail) };

  const written = String(
    ((app.body.updates as { updatedRange?: string } | undefined)?.updatedRange) ?? "",
  );
  if (written) {
    await fetch(`${REST}/rpc/record_delivery_ref`, {
      method: "POST",
      headers: restHeaders,
      body: JSON.stringify({ p_entry: entry.id, p_integration: t.id, p_ref: written }),
    });
  }
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }
  const entryId = String(body.entry_id ?? "");
  if (!entryId) return json({ ok: false, error: "entry_id is required" }, 400);

  const res = await fetch(
    `${REST}/form_entries?id=eq.${entryId}` +
      `&select=id,org_id,first_name,last_name,email,phone,created_at,selfie_link,`+
      `wants_followup,`+
      `printer:printers(name)`,
    { headers: restHeaders },
  );
  const rows = res.ok ? await res.json() : [];
  if (!rows.length) return json({ ok: false, error: "Unknown sign-in" }, 404);
  const entry = rows[0] as Entry;

  const targets = await targetsFor(entryId, "google_sheet", String(body.only ?? "") || null);
  if (!targets.length) return json({ ok: true, skipped: true });

  // Consent, not scheduling. A visitor who left the follow-up box unticked
  // asked not to hear more, and sending their name, email and telephone number
  // to a congregation's systems anyway is the thing they declined. Enforced
  // here rather than only where the sync is triggered, so a resend from the
  // Entries table honours it too.
  if (entry.wants_followup !== true) {
    for (const t of targets) {
      await recordDelivery(entryId, t.id, "skipped", "the visitor did not ask to hear more");
    }
    return json({ ok: true, skipped: true, reason: "no follow-up requested" });
  }


  const results: Array<{ ok: boolean; error?: string }> = [];
  for (const t of targets) {
    const r = await sendTo(entry, t);
    await recordDelivery(entryId, t.id, r.ok ? "sent" : "failed", r.error ?? null);
    results.push(r);
  }

  const { status, error } = rollUp(results);
  return json({ ok: status !== "failed", status, error });
});
