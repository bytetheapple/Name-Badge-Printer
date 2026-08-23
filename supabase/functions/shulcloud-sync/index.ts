// Submits a visitor to the ShulCloud "welcome" form. There is no API, so we
// replicate a browser submission: GET the form for a session cookie + CSRF token
// and hidden fields, then POST the mapped fields. Decoupled from printing.
//
// The form URL and field names come from the entry's own organization
// (integrations, kind 'shulcloud'). An org with nothing configured falls back to
// the environment variables below, but only while there is exactly one
// organization — past that, the fallback would post one congregation's visitors
// to another's CRM.
//
// Environment fallback:
//   SHULCLOUD_FORM_URL      the form URL (e.g. https://www.shirhadash.org/form/welcome)
//   SHULCLOUD_FIELD_FIRST   form input name for first name (e.g. element_30776892)
//   SHULCLOUD_FIELD_LAST    "" last name
//   SHULCLOUD_FIELD_EMAIL   "" email
//   SHULCLOUD_FIELD_PHONE   "" phone
//   SHULCLOUD_SUCCESS_TEXT  text that marks a successful submit (default below)
import { corsHeaders, json } from "../_shared/cors.ts";
import { orgOfEntry, resolveSettings } from "../_shared/integration.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_SUCCESS_TEXT = "Thank you for your interest";

const envDefaults = () => ({
  form_url: Deno.env.get("SHULCLOUD_FORM_URL") ?? "",
  field_first: Deno.env.get("SHULCLOUD_FIELD_FIRST") ?? "",
  field_last: Deno.env.get("SHULCLOUD_FIELD_LAST") ?? "",
  field_email: Deno.env.get("SHULCLOUD_FIELD_EMAIL") ?? "",
  field_phone: Deno.env.get("SHULCLOUD_FIELD_PHONE") ?? "",
  success_text: Deno.env.get("SHULCLOUD_SUCCESS_TEXT") ?? DEFAULT_SUCCESS_TEXT,
});

// ShulCloud returns 406 without browser-like headers.
const BROWSER: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

function htmlDecode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function setStatus(entryId: string, fields: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify(fields),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }
  const entryId = String(body.entry_id ?? "");
  if (!entryId) return json({ ok: false, error: "entry_id required" }, 400);

  const orgId = await orgOfEntry(entryId);
  const settings = await resolveSettings(orgId, "shulcloud", envDefaults);

  const FORM_URL = String(settings?.config.form_url ?? "");
  const F_FIRST = String(settings?.config.field_first ?? "");
  const F_LAST = String(settings?.config.field_last ?? "");
  const F_EMAIL = String(settings?.config.field_email ?? "");
  const F_PHONE = String(settings?.config.field_phone ?? "");
  const SUCCESS_TEXT = String(settings?.config.success_text || DEFAULT_SUCCESS_TEXT);

  if (!FORM_URL || !F_FIRST) {
    return json({ ok: false, error: "ShulCloud sync is not configured for this organization" });
  }

  const eRes = await fetch(`${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}&select=*`, {
    headers: restHeaders,
  });
  const entry = (await eRes.json())[0];
  if (!entry) return json({ ok: false, error: "entry not found" }, 404);

  try {
    // 1. GET the form for the session cookie, CSRF token, and hidden fields.
    const getRes = await fetch(FORM_URL, { headers: BROWSER });
    if (!getRes.ok) {
      const err = `GET form failed: HTTP ${getRes.status}`;
      await setStatus(entryId, { shulcloud_sync_status: "failed", shulcloud_error: err });
      return json({ ok: false, error: err });
    }
    const cookie = getRes.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("PHPSESSID="));
    const html = await getRes.text();

    // Isolate the welcome form (the one containing the first-name field), then
    // collect its hidden inputs (form_id, form_name, sccsrf, …).
    let formInner = html;
    for (const seg of html.split(/<form\b/i).slice(1)) {
      const s = "<form" + seg;
      if (s.includes(F_FIRST)) {
        formInner = s.split(/<\/form>/i)[0];
        break;
      }
    }
    const fields: Record<string, string> = {};
    for (const m of formInner.matchAll(/<input[^>]*type=["']hidden["'][^>]*>/gi)) {
      const nm = m[0].match(/name=["']([^"']*)["']/);
      const vl = m[0].match(/value=["']([^"']*)["']/);
      if (nm && nm[1]) fields[nm[1]] = vl ? htmlDecode(vl[1]) : "";
    }

    // 2. Add the mapped visitor fields and POST.
    fields[F_FIRST] = entry.first_name ?? "";
    if (F_LAST) fields[F_LAST] = entry.last_name ?? "";
    if (F_EMAIL && entry.email) fields[F_EMAIL] = entry.email;
    if (F_PHONE && entry.phone) fields[F_PHONE] = entry.phone;

    const postRes = await fetch(FORM_URL, {
      method: "POST",
      headers: {
        ...BROWSER,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: FORM_URL,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    });
    const respText = await postRes.text();

    if (postRes.ok && respText.includes(SUCCESS_TEXT)) {
      await setStatus(entryId, { shulcloud_sync_status: "sent", shulcloud_error: null });
      return json({ ok: true });
    }
    const err = `Unexpected response (HTTP ${postRes.status})`;
    console.error("shulcloud-sync:", err);
    await setStatus(entryId, { shulcloud_sync_status: "failed", shulcloud_error: err });
    return json({ ok: false, error: err });
  } catch (e) {
    const err = String(e).slice(0, 300);
    console.error("shulcloud-sync error:", err);
    await setStatus(entryId, { shulcloud_sync_status: "failed", shulcloud_error: err });
    return json({ ok: false, error: err });
  }
});
