import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import { lastSeenLabel, newSecret, sha256Hex } from '../../lib/secrets'
import type { BridgeToken } from '../../lib/types'

const COLUMNS =
  'id, org_id, name, token_prefix, printer_ids, last_seen, created_at, revoked_at, ' +
  'first_used_at, superseded_at, rotation_error, rotation_failed_at'

/**
 * What to say about a credential, in place of showing it.
 *
 * A failure to renew is the one thing here worth interrupting someone about:
 * the device keeps working on the credential it has, so nothing looks wrong,
 * but it has stopped rotating and will go on not rotating until someone looks.
 */
function credentialLabel(t: BridgeToken): string {
  if (t.revoked_at) return 'revoked'
  if (t.rotation_error) return 'could not renew — needs attention'
  if (!t.first_used_at) return 'not yet connected'
  const days = Math.floor((Date.now() - new Date(t.first_used_at).getTime()) / 86400000)
  if (days < 1) return 'renewed today'
  if (days === 1) return 'renewed yesterday'
  return `renewed ${days} days ago`
}

const seenLabel = (t: BridgeToken) =>
  !t.revoked_at && t.last_seen && Date.now() - new Date(t.last_seen).getTime() < 120000
    ? 'online'
    : lastSeenLabel(t.last_seen, t.revoked_at)

const RENEW_DAYS = 90

/**
 * The print servers attached to this organization.
 *
 * There is deliberately no secret on this page. A print server has no operator
 * and its owner has no terminal, so a credential nobody can install is worse
 * than useless — it dangles instructions that cannot be followed. Instead the
 * device renews its own credential over the channel it already authenticates
 * on: the value written when the card was imaged is retired the first time it
 * connects, and replaced on a schedule after that.
 *
 * What is left here is the part that genuinely needs a person, and the part
 * that already worked without touching the device: revoking one. That takes
 * effect on the device's next poll, seconds later, whether or not anyone can
 * reach it.
 *
 * Issuing is a platform-admin action, done while imaging a card.
 */
export default function BridgeTokens() {
  const { orgId, isAdmin } = useOrg()
  const [tokens, setTokens] = useState<BridgeToken[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [issuing, setIssuing] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false)

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    const { data, error } = await supabase
      .from('bridge_tokens')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .order('created_at')
    if (error) setError(error.message)
    else setTokens((data ?? []) as unknown as BridgeToken[])
    setLoading(false)
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  // RLS lets a user see only their own row here, so "a row came back" is the
  // whole check — there is nothing to compare against.
  useEffect(() => {
    void (async () => {
      const { data } = await supabase.from('platform_admins').select('user_id').limit(1)
      setIsPlatformAdmin(Boolean(data?.length))
    })()
  }, [])

  async function issue() {
    if (!orgId) return
    setIssuing(true)
    setError(null)
    const value = newSecret('nbk_')
    const { error } = await supabase.from('bridge_tokens').insert({
      org_id: orgId,
      name: name.trim() || 'Print server',
      token_hash: await sha256Hex(value),
      token_prefix: value.slice(0, 12),
    })
    setIssuing(false)
    if (error) {
      setError(error.message)
      return
    }
    setSecret(value)
    setName('')
    await load()
  }

  async function revoke(t: BridgeToken) {
    if (!window.confirm(`Revoke "${t.name}"? That print server will stop working immediately.`)) return
    const { error } = await supabase
      .from('bridge_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', t.id)
    if (error) setError(error.message)
    await load()
  }

  async function forget(t: BridgeToken) {
    if (!window.confirm(`Delete "${t.name}" for good?`)) return
    const { error } = await supabase.from('bridge_tokens').delete().eq('id', t.id)
    if (error) setError(error.message)
    await load()
  }

  if (!isAdmin) return null

  return (
    <section className="card">
      <h2>Print servers</h2>
      <p className="muted small">
        Each print server holds its own credential, scoped to this organization, so a lost device
        cannot reach anyone else's data. It renews itself every {RENEW_DAYS} days with nothing to
        install. Revoking one stops that server within seconds.
      </p>
      {error && <div className="error">{error}</div>}

      {secret && (
        <div className="notice" style={{ marginBottom: 12 }}>
          <strong>Copy this now — it is shown only once.</strong>
          <div className="muted small" style={{ marginTop: 4 }}>
            A bootstrap credential. Write it to the card, and it is retired automatically the
            first time the device connects.
          </div>
          <pre className="token-secret">{secret}</pre>
          Put it in <code>bridge/.env</code> on the Pi as <code>BRIDGE_TOKEN=…</code>, then restart
          the bridge.
          <div style={{ marginTop: 8 }}>
            <button
              className="secondary btn-sm"
              onClick={() => void navigator.clipboard?.writeText(secret)}
            >
              Copy
            </button>{' '}
            <button className="secondary btn-sm" onClick={() => setSecret(null)}>
              I've saved it
            </button>
          </div>
        </div>
      )}

      {isPlatformAdmin && (
        <div className="grid2">
          <label className="field">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Lobby Pi"
            />
          </label>
          <button type="button" onClick={() => void issue()} disabled={issuing}>
            {issuing ? 'Issuing…' : 'Issue a bootstrap credential'}
          </button>
        </div>
      )}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="data" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Credential</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} style={t.revoked_at ? { opacity: 0.55 } : undefined}>
                <td>{t.name}</td>
                <td className="small">{credentialLabel(t)}</td>
                <td className="muted small">{seenLabel(t)}</td>
                <td>
                  {t.revoked_at ? (
                    <button className="secondary btn-sm" onClick={() => void forget(t)}>
                      Delete
                    </button>
                  ) : (
                    <button className="secondary btn-sm" onClick={() => void revoke(t)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!tokens.length && (
              <tr>
                <td colSpan={4} className="muted">
                  No print servers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  )
}
