// Whether an organization is being served right now.
//
// `organizations.status` existed from A1 and nothing read it, so suspending a
// customer changed nothing. This is the one place that answer is produced, so
// the kiosk and the bridge cannot disagree about it.
//
// Suspension is reversible and destroys nothing: sign-ins stop being accepted
// and print jobs stop being handed out, and both resume the moment the status
// goes back.
import { REST, restHeaders } from "./bridge-auth.ts";

/**
 * Cached for the life of this instance.
 *
 * An instance is short-lived and a suspension is not an emergency stop — a few
 * seconds of staleness is worth not asking the database on every sign-in.
 */
const seen = new Map<string, boolean>();

export async function orgIsActive(orgId: string | null): Promise<boolean> {
  if (!orgId) return false;
  const cached = seen.get(orgId);
  if (cached !== undefined) return cached;

  const res = await fetch(`${REST}/rpc/org_is_active`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ p_org: orgId }),
  });
  // Fail open on a transport error: a database hiccup must not look like a
  // suspension and stop a lobby working. A genuinely suspended org returns
  // false from the function itself, which is a different thing.
  if (!res.ok) return true;
  const active = (await res.json()) === true;
  seen.set(orgId, active);
  return active;
}

/** What a visitor sees. Never mentions billing or the word suspended — this is
 *  on a screen in a lobby, and it is not their problem to solve. */
export const SUSPENDED_MESSAGE =
  "Sign-in is unavailable at the moment. Please ask a greeter for help.";
