import { REST, restHeaders } from "./bridge-auth.ts";

/**
 * Call a Postgres function as service_role.
 *
 * Returns null on any failure rather than throwing: every caller here is
 * doing bookkeeping alongside work that matters more, and a failed
 * housekeeping call must not take a print job or a heartbeat down with it.
 */
export async function rpc(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${REST}/rpc/${fn}`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify(args),
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
