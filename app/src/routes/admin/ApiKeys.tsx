import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import { lastSeenLabel, newSecret, sha256Hex } from '../../lib/secrets'
import type { ApiKey } from '../../lib/types'

const COLUMNS = 'id, org_id, name, key_prefix, last_used_at, created_at, revoked_at'

/**
 * Keys for the external print API, scoped to this organization.
 *
 * A caller presenting one of these can list this org's printers and queue
 * badges on them — and nothing else, in any other org.
 */
export default function ApiKeys() {
  const { orgId, isAdmin } = useOrg()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [issuing, setIssuing] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    const { data, error } = await supabase
      .from('api_keys')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .order('created_at')
    if (error) setError(error.message)
    else setKeys((data ?? []) as ApiKey[])
    setLoading(false)
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  async function issue() {
    if (!orgId) return
    setIssuing(true)
    setError(null)
    const value = newSecret('nbk_api_')
    const { error } = await supabase.from('api_keys').insert({
      org_id: orgId,
      name: name.trim() || 'API key',
      key_hash: await sha256Hex(value),
      key_prefix: value.slice(0, 16),
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

  async function revoke(k: ApiKey) {
    if (!window.confirm(`Revoke "${k.name}"? Anything using it stops printing immediately.`)) return
    const { error } = await supabase
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', k.id)
    if (error) setError(error.message)
    await load()
  }

  async function forget(k: ApiKey) {
    if (!window.confirm(`Delete "${k.name}" for good?`)) return
    const { error } = await supabase.from('api_keys').delete().eq('id', k.id)
    if (error) setError(error.message)
    await load()
  }

  if (!isAdmin) return null

  return (
    <section className="card">
      <h2>Print API keys</h2>
      <p className="muted small">
        For other applications that queue badges on your printers. Send the key as an{' '}
        <code>x-api-key</code> header — see <code>PRINT_API.md</code>.
      </p>
      {error && <div className="error">{error}</div>}

      {secret && (
        <div className="notice" style={{ marginBottom: 12 }}>
          <strong>Copy this now — it is shown only once.</strong>
          <pre className="token-secret">{secret}</pre>
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
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Chidon app" />
        </label>
        <button type="button" onClick={() => void issue()} disabled={issuing}>
          {issuing ? 'Issuing…' : 'Issue a key'}
        </button>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} style={k.revoked_at ? { opacity: 0.55 } : undefined}>
                <td>{k.name}</td>
                <td>
                  <code>{k.key_prefix}…</code>
                </td>
                <td className="muted small">{lastSeenLabel(k.last_used_at, k.revoked_at)}</td>
                <td>
                  {k.revoked_at ? (
                    <button className="secondary btn-sm" onClick={() => void forget(k)}>
                      Delete
                    </button>
                  ) : (
                    <button className="secondary btn-sm" onClick={() => void revoke(k)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!keys.length && (
              <tr>
                <td colSpan={4} className="muted">
                  No keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  )
}
