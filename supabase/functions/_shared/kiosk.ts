// Resolving "which printer, in which org" for the public sign-in path.
//
// The kiosk token is the supported answer: opaque, unguessable, rotatable, and
// it names the printer without the caller ever naming an org — the org comes
// from the printer row, so a caller cannot point a submission at someone else's
// tenant no matter what it sends.
//
// Two legacy shapes are still accepted so that QR codes already hanging in a
// lobby keep working:
//
//   * `printer_id` — the old ?printer=<uuid> link. Safe for the same reason:
//     the org is read off the row, never taken from the request.
//   * neither — the very first single-printer links. This one cannot stay
//     honest once there is more than one tenant, so it is refused as soon as a
//     second org exists rather than guessing. Same failsafe as A1's
//     default_org_id().
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const REST = `${SUPABASE_URL}/rest/v1`;
export const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

import { orgIsActive, SUSPENDED_MESSAGE } from "./org.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^k_[0-9a-f]{32}$/;

export interface Kiosk {
  org_id: string;
  printer_id: string;
  printer_name: string | null;
  /** How this kiosk was identified, for logging and for nudging upgrades. */
  via: "kiosk_token" | "printer_id" | "sole_org";
}

export interface KioskResult {
  kiosk: Kiosk | null;
  /** Message safe to show a visitor. Set whenever kiosk is null. */
  error?: string;
}

async function printerBy(query: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${REST}/printers?${query}&select=id,org_id,name`, {
    headers: restHeaders,
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? rows[0] : null;
}

/**
 * Refuse a kiosk whose organization is suspended.
 *
 * Applied once, at the end of resolution, rather than at each of the three
 * ways a kiosk can be identified — a check that has to be repeated is a check
 * that will eventually be forgotten in one branch.
 */
async function unlessSuspended(result: KioskResult): Promise<KioskResult> {
  if (!result.kiosk) return result;
  if (await orgIsActive(result.kiosk.org_id)) return result;
  return { kiosk: null, error: SUSPENDED_MESSAGE };
}

export async function resolveKiosk(body: Record<string, unknown>): Promise<KioskResult> {
  return unlessSuspended(await resolveKioskInner(body));
}

async function resolveKioskInner(body: Record<string, unknown>): Promise<KioskResult> {
  const token = String(body.kiosk_token ?? "").trim();
  const printerId = String(body.printer_id ?? "").trim();

  if (token) {
    if (!TOKEN_RE.test(token)) return { kiosk: null, error: "This sign-in link is not valid." };
    const row = await printerBy(`kiosk_token=eq.${token}`);
    if (!row) return { kiosk: null, error: "This sign-in link is no longer active." };
    return {
      kiosk: {
        org_id: row.org_id as string,
        printer_id: row.id as string,
        printer_name: (row.name as string) ?? null,
        via: "kiosk_token",
      },
    };
  }

  if (printerId) {
    if (!UUID_RE.test(printerId)) return { kiosk: null, error: "This sign-in link is not valid." };
    const row = await printerBy(`id=eq.${printerId}`);
    if (!row) return { kiosk: null, error: "This sign-in link is no longer active." };
    return {
      kiosk: {
        org_id: row.org_id as string,
        printer_id: row.id as string,
        printer_name: (row.name as string) ?? null,
        via: "printer_id",
      },
    };
  }

  // No hint at all. Only answerable while this is a single-tenant database.
  const orgsRes = await fetch(`${REST}/organizations?select=id&limit=2`, { headers: restHeaders });
  const orgs = orgsRes.ok ? await orgsRes.json() : [];
  if (orgs.length !== 1) {
    return { kiosk: null, error: "This sign-in link is out of date. Please scan the QR code again." };
  }
  const row = await printerBy(`org_id=eq.${orgs[0].id}&order=created_at.asc&limit=1`);
  if (!row) return { kiosk: null, error: "No printer is configured." };
  return {
    kiosk: {
      org_id: row.org_id as string,
      printer_id: row.id as string,
      printer_name: (row.name as string) ?? null,
      via: "sole_org",
    },
  };
}

/** The rate limit / queue cap gate. Returns a visitor-safe message, or null. */
export async function checkSubmitAllowed(
  kiosk: Kiosk,
  ip: string | null,
  badges: number,
): Promise<string | null> {
  const res = await fetch(`${REST}/rpc/check_submit_allowed`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({
      p_org: kiosk.org_id,
      p_printer: kiosk.printer_id,
      p_ip: ip,
      p_badges: badges,
    }),
  });
  // Fail open on an infrastructure error: a broken limiter must not stop a
  // congregation signing people in. It fails closed on an actual limit.
  if (!res.ok) return null;
  return (await res.json()) as string | null;
}
