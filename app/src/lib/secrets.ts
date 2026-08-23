/**
 * Client-side secret generation for credentials the server only ever stores
 * hashed — bridge tokens, API keys, kiosk tokens.
 *
 * Generating here means the secret is shown once and never travels to the
 * database at all, so a dump cannot yield a working credential.
 */

/** A random secret with the given prefix, e.g. newSecret('nbk_'). */
export function newSecret(prefix: string, bytes = 24): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes))
  return prefix + [...random].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** How long ago a credential was used, phrased for a table cell. */
export function lastSeenLabel(at: string | null, revokedAt: string | null): string {
  if (revokedAt) return 'revoked'
  if (!at) return 'never used'
  const mins = (Date.now() - new Date(at).getTime()) / 60000
  if (mins < 2) return 'just now'
  if (mins < 60) return `${Math.round(mins)} min ago`
  return new Date(at).toLocaleString()
}
