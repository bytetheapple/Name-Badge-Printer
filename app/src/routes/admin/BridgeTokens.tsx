import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import type { BridgeToken } from '../../lib/types'

// Wide enough that guessing is hopeless, short enough to retype off a screen.
const TOKEN_BYTES = 24
const COLUMNS = 'id, org_id, name, token_prefix, printer_ids, last_seen, created_at, revoked_at'

/** A fresh secret. Generated here and never sent anywhere but its own hash. */
function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  return `nbk_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const seenLabel = (t: BridgeToken) => {
  if (t.revoked_at) return 'revoked'
  if (!t.last_seen) return 'never connected'
  const mins = (Date.now() - new Date(t.last_seen).getTime()) / 60000
  if (mins < 2) return 'online'
  if (mins < 60) return `${Math.round(mins)} min ago`
  return new Date(t.last_seen).toLocaleString()
}

/**
 * Issue and revoke the credentials the Raspberry Pi print bridges use.
 *
 * The secret is generated in this browser, hashed, and only the hash is stored —
 * so it can be shown exactly once, and a database dump yields nothing usable.
 */
export default function BridgeTokens() {
  const { orgId, isAdmin } = useOrg()
  const [tokens, setTokens] = useState<BridgeToken[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [issuing, setIssuing] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    const { data, error } = await supabase
      .from('bridge_tokens')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .order('created_at')
    if (error) setError(error.message)
    else setTokens((data ?? []) as BridgeToken[])
    setLoading(false)
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  async function issue() {
    if (!orgId) return
    setIssuing(true)
    setError(null)
    const value = newSecret()
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
        Each Raspberry Pi needs its own token. It is scoped to this organization only, so a lost
        device cannot reach anyone else's data.
      </p>
      {error && <div className="error">{error}</div>}

      {secret && (
        <div className="notice" style={{ marginBottom: 12 }}>
          <strong>Copy this now — it is shown only once.</strong>
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
          {issuing ? 'Issuing…' : 'Issue a token'}
        </button>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Token</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} style={t.revoked_at ? { opacity: 0.55 } : undefined}>
                <td>{t.name}</td>
                <td>
                  <code>{t.token_prefix}…</code>
                </td>
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
