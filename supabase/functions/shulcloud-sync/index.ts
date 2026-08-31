// Submits a visitor to the ShulCloud "welcome" form. There is no API, so we
// replicate a browser submission: GET the form for a session cookie + CSRF token
// and hidden fields, then POST the mapped fields. Decoupled from printing.
//
// The form URL and field names come from the entry's own organization
// (integrations, kind 'shulcloud'), and from nowhere else. An org that has not
// configured it syncs nowhere rather than posting into anyone's CRM.
import { corsHeaders, json } from "../_shared/cors.ts";
import { recordDelivery, rollUp, targetsFor, type Target } from "../_shared/integration.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_SUCCESS_TEXT = "Thank you for your interest";

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

  const only = body.integration_id ? String(body.integration_id) : null;

  const eRes = await fetch(`${SUPABASE_URL}/rest/v1/form_entries?id=eq.${entryId}&select=*`, {
    headers: restHeaders,
  });
  const entry = (await eRes.json())[0];
  if (!entry) return json({ ok: false, error: "entry not found" }, 404);

  const targets = await targetsFor(entryId, "shulcloud", only);
  if (!targets.length) {
    // Left pending rather than failed: nothing is wrong, there is simply
    // nowhere to send it, and the admin's resync relies on pending.
    return json({ ok: false, error: "No ShulCloud destinations for this sign-in" });
  }

  /**
   * One submission to one ShulCloud form.
   *
   * Each destination is a separate session: the CSRF token and PHPSESSID come
   * from that form's own GET, so they cannot be fetched once and reused across
   * forms even when both live on the same ShulCloud site.
   */
  async function deliver(t: Target): Promise<{ ok: boolean; error?: string }> {
    const FORM_URL = String(t.config.form_url ?? "");
    const F_FIRST = String(t.config.field_first ?? "");
    const F_LAST = String(t.config.field_last ?? "");
    const F_EMAIL = String(t.config.field_email ?? "");
    const F_PHONE = String(t.config.field_phone ?? "");
    const SUCCESS_TEXT = String(t.config.success_text || DEFAULT_SUCCESS_TEXT);

    if (!FORM_URL || !F_FIRST) {
      return { ok: false, error: "Form URL or first-name field is not set" };
    }

    // 1. GET the form for the session cookie, CSRF token, and hidden fields.
    const getRes = await fetch(FORM_URL, { headers: BROWSER });
    if (!getRes.ok) return { ok: false, error: `GET form failed: HTTP ${getRes.status}` };

    const cookie = getRes.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("PHPSESSID="));
    const html = await getRes.text();

    // Isolate the welcome form (the one containing the first-name field), then
    // collect its hidden inputs (form_id, form_name, sccsrf, …).
    let formInner = html;
    for (const seg of html.split(/<form\b/i).slice(1)) {
      const s2 = "<form" + seg;
      if (s2.includes(F_FIRST)) {
        formInner = s2.split(/<\/form>/i)[0];
        break;
      }
    }
    const fields: Record<string, string> = {};
    for (const m of formInner.matchAll(/<input[^>]*type=["\']hidden["\'][^>]*>/gi)) {
      const nm = m[0].match(/name=["\']([^"\']*)["\']/);
      const vl = m[0].match(/value=["\']([^"\']*)["\']/);
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

    if (postRes.ok && respText.includes(SUCCESS_TEXT)) return { ok: true };
    return { ok: false, error: `Unexpected response (HTTP ${postRes.status})` };
  }

  const results: Array<{ ok: boolean; error?: string }> = [];
  for (const t of targets) {
    let outcome: { ok: boolean; error?: string };
    try {
      outcome = await deliver(t);
    } catch (e) {
      outcome = { ok: false, error: String(e).slice(0, 300) };
    }
    if (!outcome.ok) console.error(`shulcloud-sync ${t.name}:`, outcome.error);
    await recordDelivery(entryId, t.id, outcome.ok ? "sent" : "failed", outcome.error);
    results.push(outcome.ok ? { ok: true } : { ok: false, error: `${t.name}: ${outcome.error}` });
  }

  // The old single column, still written until the expandable pill ships. Not
  // written for a single-destination resend, which would otherwise report the
  // whole entry on one destination's result.
  if (!only) {
    const rolled = rollUp(results);
    await setStatus(entryId, {
      shulcloud_sync_status: rolled.status,
      shulcloud_error: rolled.error,
    });
  }

  const failed = results.filter((r) => !r.ok);
  return json({
    ok: failed.length === 0,
    sent: results.length - failed.length,
    total: results.length,
    error: failed.length ? failed.map((f) => f.error).join("; ") : undefined,
  });
});
