// Resolving a printed event QR code to the event it belongs to.
//
// In _shared rather than beside either function that uses it: both event-config
// and event-register have to agree exactly about what a token means and which
// gates apply, and importing one Edge Function from another would start its
// server as a side effect of the import.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = `${SUPABASE_URL}/rest/v1`;
const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

export const CLOSED = "This registration link is not open. Please see someone at the desk.";

export interface EventCode {
  org_id: string;
  integration_id: string;
  printer_id: string;
  event_name: string;
  org_name: string;
  printer_name: string | null;
  config: Record<string, unknown>;
}

/**
 * Resolve a printed QR token to the event it belongs to, or null.
 *
 * Shared with event-register so the two cannot disagree about what a token
 * means. Every gate is applied here: an event that resolves is an event that
 * may take a registration.
 */
export async function resolveEventCode(token: string): Promise<EventCode | null> {
  if (!token || token.length > 80) return null;
  const res = await fetch(
    `${REST}/event_printers?token=eq.${encodeURIComponent(token)}` +
      `&select=org_id,integration_id,printer_id,` +
      `integration:integrations(id,name,kind,enabled),` +
      `printer:printers(id,name),` +
      `organization:organizations(name,status,events_enabled)`,
    { headers: restHeaders },
  );
  if (!res.ok) return null;
  const row = (await res.json())[0];
  if (!row) return null;

  const integration = row.integration as
    | { name?: string; kind?: string; enabled?: boolean }
    | null;
  const org = row.organization as
    | { name?: string; status?: string; events_enabled?: boolean }
    | null;
  const printer = row.printer as { name?: string } | null;

  if (!integration || integration.kind !== "event" || integration.enabled !== true) return null;
  // The entitlement is checked on every registration, not only when the event
  // is created. Turning Events off for a customer has to stop the codes that
  // are already on tables, or it is not really off.
  if (!org || org.status !== "active" || org.events_enabled !== true) return null;

  // The config is read here so the caller does not need a second round trip,
  // but it is never returned to the browser.
  const cfgRes = await fetch(
    `${REST}/integrations?id=eq.${row.integration_id}&select=config`,
    { headers: restHeaders },
  );
  const config = cfgRes.ok ? ((await cfgRes.json())[0]?.config ?? {}) : {};

  return {
    org_id: String(row.org_id),
    integration_id: String(row.integration_id),
    printer_id: String(row.printer_id),
    event_name: String(integration.name ?? "Event"),
    org_name: String(org.name ?? ""),
    printer_name: printer?.name ? String(printer.name) : null,
    config: config as Record<string, unknown>,
  };
}
