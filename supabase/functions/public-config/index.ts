// Public read of the settings the visitor form needs, for one kiosk.
//
// Resolves the kiosk token to an org and returns only that org's safe fields —
// never the Drive folder id, and never another tenant's settings.
import { corsHeaders, json } from "../_shared/cors.ts";
import { REST, resolveKiosk, restHeaders } from "../_shared/kiosk.ts";

const DEFAULTS = { selfie_mode: "off", pronouns_enabled: false };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // An empty body is the oldest form of this call; resolveKiosk handles it.
  }

  try {
    const { kiosk } = await resolveKiosk(body);
    // A form that cannot be placed still renders, with safe defaults — the
    // submit call is where an unusable link is reported to the visitor.
    if (!kiosk) return json({ ok: true, ...DEFAULTS });

    const res = await fetch(
      `${REST}/app_settings?org_id=eq.${kiosk.org_id}&select=selfie_mode,pronouns_enabled`,
      { headers: restHeaders },
    );
    const rows = res.ok ? await res.json() : [];
    return json({
      ok: true,
      selfie_mode: rows[0]?.selfie_mode ?? DEFAULTS.selfie_mode,
      pronouns_enabled: rows[0]?.pronouns_enabled ?? DEFAULTS.pronouns_enabled,
      printer_name: kiosk.printer_name,
    });
  } catch {
    return json({ ok: true, ...DEFAULTS });
  }
});
