// Reads a ShulCloud form and reports the fields it contains, so the mapping is
// chosen from a list of labels instead of transcribed out of raw HTML.
//
// Nothing is written here. The scan answers with what the form has; the owner
// decides what maps to what, and the integration row is saved by the browser
// under its own RLS. Keeping the write out of this function means a scan can
// never quietly change where a congregation's visitors are sent.
import { corsHeaders, json } from "../_shared/cors.ts";
import { scanForm } from "../_shared/formscan.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// ShulCloud answers 406 to a request that does not look like a browser. Worth
// stating plainly because it is not a guess: curl is refused from here whatever
// headers it sends, while this runtime's fetch is served.
const BROWSER: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

/** The signed-in user behind this request, or null if the JWT is missing/bad. */
async function callerOf(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  return (await res.json())?.id ?? null;
}

/** Integrations are the owner's job — this mirrors the RLS on that table. */
async function isOwner(userId: string, orgId: string): Promise<boolean> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/memberships?org_id=eq.${orgId}&user_id=eq.${userId}&select=role`,
    { headers: restHeaders },
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return rows.length > 0 && rows[0].role === "owner";
}

/**
 * Refuse anything that is not an ordinary public web address.
 *
 * The URL is typed by an owner and this function will fetch it, so it must not
 * become a way to ask the platform to make requests inside its own network.
 * The submission path already fetches this URL, so the exposure is not new —
 * but a scan button is pressed far more casually than a visitor signs in.
 */
function refuse(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "That is not a web address.";
  }
  if (u.protocol !== "https:") return "The form address must start with https://";
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")
  ) {
    return "That address is not a public website.";
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const userId = await callerOf(req);
  if (!userId) return json({ ok: false, error: "Not signed in" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  const orgId = String(body.org_id ?? "");
  const formUrl = String(body.form_url ?? "").trim();
  if (!orgId || !formUrl) return json({ ok: false, error: "org_id and form_url are required" }, 400);
  if (!(await isOwner(userId, orgId))) {
    return json({ ok: false, error: "Only an owner can configure integrations" }, 403);
  }

  const bad = refuse(formUrl);
  if (bad) return json({ ok: false, error: bad }, 400);

  let html: string;
  try {
    const res = await fetch(formUrl, { headers: BROWSER, redirect: "follow" });
    if (!res.ok) {
      return json({
        ok: false,
        error: `The site answered HTTP ${res.status} for that address.` +
          (res.status === 404 ? " Check the form URL." : ""),
      });
    }
    html = await res.text();
  } catch (e) {
    return json({ ok: false, error: `Could not reach that address: ${e}` });
  }

  const scanned = scanForm(html);
  if (!scanned) {
    // Said precisely. "Nothing found" would send someone to check their
    // network; the page loaded fine and simply is not a ShulCloud form.
    return json({
      ok: false,
      error: "That page loaded, but it has no ShulCloud form on it — no field " +
        "is named element_… . Check that the address is the form itself.",
    });
  }

  return json({ ok: true, ...scanned });
});
