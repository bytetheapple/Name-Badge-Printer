// Shared authentication for the print-bridge endpoints.
//
// A bridge presents an opaque token in `x-bridge-key`. Only its SHA-256 is
// stored, so the lookup hashes what was presented and matches on that. The row
// it finds is the ONLY source of org scoping — nothing a bridge sends in a body
// is ever trusted to say which org or printer it is acting on.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

export const REST = `${SUPABASE_URL}/rest/v1`;

export interface Bridge {
  id: string;
  org_id: string;
  /** null means every printer in the org. */
  printer_ids: string[] | null;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The bridge behind this request, or null if the key is missing/unknown/revoked. */
export async function authenticateBridge(req: Request): Promise<Bridge | null> {
  const key = req.headers.get("x-bridge-key")?.trim();
  if (!key) return null;

  const hash = await sha256Hex(key);
  const res = await fetch(
    `${REST}/bridge_tokens?token_hash=eq.${hash}&revoked_at=is.null&select=id,org_id,printer_ids`,
    { headers: restHeaders },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? (rows[0] as Bridge) : null;
}

/** May this bridge act on this printer? */
export function bridgeAllowsPrinter(bridge: Bridge, printerId: string | null): boolean {
  if (!printerId) return true;
  if (!bridge.printer_ids || bridge.printer_ids.length === 0) return true;
  return bridge.printer_ids.includes(printerId);
}

/** PostgREST filter restricting a query to the printers this bridge may see. */
export function printerFilter(bridge: Bridge): string {
  if (!bridge.printer_ids || bridge.printer_ids.length === 0) return "";
  return `&id=in.(${bridge.printer_ids.join(",")})`;
}
