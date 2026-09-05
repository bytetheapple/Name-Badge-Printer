// What the event registration page needs before anybody types anything.
//
// Public, because it answers a QR code that has been printed on paper and
// handed to strangers. It returns only what the page shows: the event's name,
// the organization's name, and which printer this code prints at. Nothing
// about the attendee list, and nothing that identifies the spreadsheet.
//
// A code for a disabled event, a suspended organization, or an organization
// whose Events entitlement has been switched off gets a plain refusal. That
// last case is the one worth being careful about: the code is still printed
// and still on a table, so the answer has to be a sentence somebody at a desk
// can act on rather than a 404.
import { corsHeaders, json } from "../_shared/cors.ts";
import { CLOSED, resolveEventCode } from "../_shared/eventcode.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Read from the body rather than the query string: a token in a URL ends up
  // in logs and referrers, and this one opens a registration desk.
  let token = "";
  try {
    token = String(((await req.json()) as { token?: unknown })?.token ?? "");
  } catch {
    token = "";
  }
  const code = await resolveEventCode(token);
  if (!code) return json({ ok: false, error: CLOSED }, 404);

  return json({
    ok: true,
    event_name: code.event_name,
    org_name: code.org_name,
    printer_name: code.printer_name,
  });
});
