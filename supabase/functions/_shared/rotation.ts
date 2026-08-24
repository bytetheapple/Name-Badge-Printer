// Bridge credentials that renew themselves.
//
// A print server has no operator. Nobody is going to SSH in and paste a new
// token, so the device is handed one over the channel it already uses and
// already authenticates on.
//
// The invariant that makes this safe: **a token is revoked when its replacement
// is used, never when the replacement is minted.** Every failure in between —
// a failed disk write, a power cut, a dropped response — leaves the device
// holding a credential that still works.
import { REST, restHeaders, sha256Hex } from "./bridge-auth.ts";

/**
 * How long a credential lives before it renews.
 *
 * Not a security boundary — a leaked token is dealt with by revoking it, not by
 * waiting. This bounds how long a credential that leaked *without anyone
 * noticing* stays useful.
 */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** After a device fails to store a replacement, wait before trying again. */
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** How long a superseded token survives once its replacement has been used. */
const SWEEP_GRACE = "7 days";

export interface TokenRow {
  id: string;
  org_id: string;
  name: string | null;
  printer_ids: string[] | null;
  first_used_at: string | null;
  superseded_at: string | null;
  superseded_by: string | null;
  created_at: string;
  rotation_failed_at: string | null;
}

const COLUMNS =
  "id,org_id,name,printer_ids,first_used_at,superseded_at,superseded_by,created_at,rotation_failed_at";

/** Fetch the full row for an authenticated bridge. */
export async function tokenRow(id: string): Promise<TokenRow | null> {
  const res = await fetch(`${REST}/bridge_tokens?id=eq.${id}&select=${COLUMNS}`, {
    headers: restHeaders,
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? (rows[0] as TokenRow) : null;
}

function newSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "nbk_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Is this token due to be replaced?
 *
 * Two reasons, and the first is the important one: a token that has never been
 * used is the value someone typed while imaging the card. Retiring it on first
 * contact means the credential a human handled never stays in service.
 */
export function rotationDue(row: TokenRow, now: number): boolean {
  if (row.rotation_failed_at && now - Date.parse(row.rotation_failed_at) < RETRY_AFTER_MS) {
    return false;
  }
  if (!row.first_used_at) return true;
  return now - Date.parse(row.created_at) > MAX_AGE_MS;
}

/**
 * Record that this token authenticated, and retire its predecessor.
 *
 * This is the confirmation half of the rollover: the old credential is only
 * revoked once the new one has demonstrably reached the device and worked.
 */
export async function noteUsed(row: TokenRow, nowIso: string): Promise<void> {
  if (!row.first_used_at) {
    await fetch(`${REST}/bridge_tokens?id=eq.${row.id}&first_used_at=is.null`, {
      method: "PATCH",
      headers: restHeaders,
      body: JSON.stringify({ first_used_at: nowIso }),
    });
    // Whatever this token replaced has now definitively been superseded.
    await fetch(
      `${REST}/bridge_tokens?superseded_by=eq.${row.id}&revoked_at=is.null`,
      {
        method: "PATCH",
        headers: restHeaders,
        body: JSON.stringify({ revoked_at: nowIso }),
      },
    );
  }
}

/**
 * Mint a replacement and return it, once.
 *
 * Returns null if nothing should change. The plaintext exists only in this
 * response — the database keeps the hash — so it must never be logged.
 */
export async function rotate(row: TokenRow, nowIso: string): Promise<string | null> {
  // A replacement was already minted and never used: the device did not manage
  // to store it. That secret is unrecoverable (only its hash was kept), so it
  // is thrown away and a fresh one issued rather than left to accumulate.
  if (row.superseded_by) {
    await fetch(`${REST}/bridge_tokens?id=eq.${row.superseded_by}&first_used_at=is.null`, {
      method: "DELETE",
      headers: restHeaders,
    });
  }

  const secret = newSecret();
  const created = await fetch(`${REST}/bridge_tokens`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify({
      org_id: row.org_id,
      name: row.name,
      printer_ids: row.printer_ids,
      token_hash: await sha256Hex(secret),
      token_prefix: secret.slice(0, 12),
      replaces: row.id,
    }),
  });
  if (!created.ok) return null;
  const rows = await created.json();
  if (!rows.length) return null;

  const patched = await fetch(
    `${REST}/bridge_tokens?id=eq.${row.id}&revoked_at=is.null`,
    {
      method: "PATCH",
      headers: { ...restHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        superseded_at: nowIso,
        superseded_by: rows[0].id,
        rotation_error: null,
        rotation_failed_at: null,
      }),
    },
  );
  // Losing this race means the token was revoked underneath us. Do not hand
  // out a replacement for a credential an administrator just killed.
  if (!patched.ok || !(await patched.json()).length) {
    await fetch(`${REST}/bridge_tokens?id=eq.${rows[0].id}`, {
      method: "DELETE",
      headers: restHeaders,
    });
    return null;
  }
  return secret;
}

/** The device could not store its replacement. Back off and make it visible. */
export async function noteFailure(row: TokenRow, error: string, nowIso: string): Promise<void> {
  await fetch(`${REST}/bridge_tokens?id=eq.${row.id}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({
      rotation_error: String(error).slice(0, 500),
      rotation_failed_at: nowIso,
    }),
  });
  // The replacement it could not keep is of no use to anyone.
  if (row.superseded_by) {
    await fetch(`${REST}/bridge_tokens?id=eq.${row.superseded_by}&first_used_at=is.null`, {
      method: "DELETE",
      headers: restHeaders,
    });
  }
  await fetch(`${REST}/bridge_tokens?id=eq.${row.id}`, {
    method: "PATCH",
    headers: restHeaders,
    body: JSON.stringify({ superseded_at: null, superseded_by: null }),
  });
}

/** Revoke tokens whose replacement was stored but never used — see the SQL. */
export async function sweep(): Promise<void> {
  await fetch(`${REST}/rpc/sweep_superseded_bridge_tokens`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ p_grace: SWEEP_GRACE }),
  });
}
