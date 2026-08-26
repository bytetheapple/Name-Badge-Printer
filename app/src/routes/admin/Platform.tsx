import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import { lastSeenLabel } from '../../lib/secrets'
import type { PlatformOrg } from '../../lib/types'

const BRIDGE_FRESH_MS = 45000

/**
 * The cross-tenant view, for the people who run the service.
 *
 * Everything here was a hand-written SQL statement until now: creating a
 * tenant, issuing a print server's credential, revoking one, granting custom
 * integrations, suspending a customer. None of those is rare enough to leave
 * in the SQL editor, and two of them — revoking a stolen device, resuming a
 * suspended congregation — are things you would want to do quickly and
 * possibly from a phone.
 *
 * Visible only to platform admins. The database enforces that independently:
 * platform_overview() returns nothing to anyone else, so a mistake here leaks
 * nothing.
 */
export default function Platform() {
  const [orgs, setOrgs] = useState<PlatformOrg[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [secret, setSecret] = useState<{ org: string; value: string } | null>(null)
  const { reload, isPlatformAdmin } = useOrg()

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('platform_overview')
    if (error) setError(error.message)
    else setOrgs((data ?? []) as PlatformOrg[])
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function createOrg() {
    if (!slug.trim() || !name.trim()) {
      setError('An organization needs both a name and a slug.')
      return
    }
    setBusy('create')
    setError(null)
    setNotice(null)
    const { error } = await supabase.rpc('create_organization', {
      p_slug: slug.trim(),
      p_name: name.trim(),
    })
    setBusy(null)
    if (error) {
      setError(error.message)
      return
    }
    setNotice(`${name.trim()} created. You are its owner — hand that over once it is set up.`)
    setSlug('')
    setName('')
    setCreating(false)
    await load()
    // The org switcher is built from memberships, and there is a new one.
    await reload()
  }

  async function setStatus(org: PlatformOrg, status: 'active' | 'suspended') {
    const verb = status === 'suspended' ? 'Suspend' : 'Resume'
    if (
      status === 'suspended' &&
      !window.confirm(
        `Suspend ${org.name}? Their kiosks stop accepting sign-ins and their print server ` +
          `stops receiving jobs, within seconds. Nothing is deleted and resuming restores it.`,
      )
    ) {
      return
    }
    setBusy(org.org_id)
    setNotice(null)
    const { error } = await supabase.from('organizations').update({ status }).eq('id', org.org_id)
    setBusy(null)
    if (error) setError(error.message)
    else setNotice(`${verb}d ${org.name}.`)
    await load()
  }

  async function setCustom(org: PlatformOrg, on: boolean) {
    setBusy(org.org_id)
    setNotice(null)
    const { error } = await supabase
      .from('organizations')
      .update({ custom_integrations: on })
      .eq('id', org.org_id)
    setBusy(null)
    if (error) setError(error.message)
    else setNotice(`Custom integrations ${on ? 'enabled' : 'disabled'} for ${org.name}.`)
    await load()
  }

  async function issueCredential(org: PlatformOrg) {
    setBusy(org.org_id)
    setNotice(null)
    setError(null)
    const { data, error } = await supabase.rpc('issue_bridge_token', {
      p_org: org.org_id,
      p_name: 'Print server',
    })
    setBusy(null)
    if (error || !data) {
      setError(error?.message ?? 'No credential was returned.')
      return
    }
    setSecret({ org: org.name, value: String(data) })
    await load()
  }

  // Presentation only — platform_overview() returns nothing to anyone else, so
  // reaching this by URL shows an empty table rather than another org's data.
  // Saying so is kinder than letting it look broken.
  if (!isPlatformAdmin) {
    return (
      <>
        <h1>Platform</h1>
        <p className="muted">This page is for the Name Badge Kiosk team.</p>
      </>
    )
  }
  if (loading) return <p className="muted">Loading…</p>

  return (
    <>
      <h1>Platform</h1>
      <p className="muted small">
        Every organization on this deployment. Only visible to the Name Badge Kiosk team.
      </p>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      {secret && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>Bootstrap credential for {secret.org} — shown only once.</strong>
          <pre className="token-secret">{secret.value}</pre>
          Write it to the card as <code>BRIDGE_TOKEN=</code> in <code>bridge/.env</code>. The
          device replaces it with one of its own the first time it connects.
          <div style={{ marginTop: 8 }}>
            <button
              className="secondary btn-sm"
              onClick={() => void navigator.clipboard?.writeText(secret.value)}
            >
              Copy
            </button>{' '}
            <button className="secondary btn-sm" onClick={() => setSecret(null)}>
              I've saved it
            </button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Organization</th>
              <th>Status</th>
              <th>Print server</th>
              <th>Activity</th>
              <th>Custom</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => {
              const seen = o.bridge_last_seen ? new Date(o.bridge_last_seen).getTime() : null
              const online = seen !== null && Date.now() - seen < BRIDGE_FRESH_MS
              return (
                <tr key={o.org_id} style={o.status !== 'active' ? { opacity: 0.6 } : undefined}>
                  <td>
                    {o.name}
                    <div className="muted small">
                      <code>{o.slug}</code>
                      {/* The cost of making the creator the owner: without
                          this, an onboarding never handed over looks exactly
                          like one that was. */}
                      {o.operator_attached && ' · not handed over'}
                    </div>
                  </td>
                  <td>
                    <span className={`pill pill-sync-${o.status === 'active' ? 'sent' : 'failed'}`}>
                      {o.status}
                    </span>
                  </td>
                  <td className="small">
                    {o.live_bridges === 0 ? (
                      <span className="muted">none issued</span>
                    ) : (
                      <>
                        <span className={`tab-dot ${online ? 'ok' : 'bad'}`} />{' '}
                        {online ? 'online' : lastSeenLabel(o.bridge_last_seen, null)}
                      </>
                    )}
                  </td>
                  {/* Three counts in one cell rather than three columns. The
                      Entries table taught this: a wide table pushes its
                      actions off the right edge, where nobody finds them. */}
                  <td className="small">
                    {o.printers} printer{o.printers === 1 ? '' : 's'} · {o.members} member
                    {o.members === 1 ? '' : 's'}
                    <div className="muted">
                      {o.entries_30d} sign-in{o.entries_30d === 1 ? '' : 's'} in 30 days
                    </div>
                  </td>
                  <td>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={o.custom_integrations}
                        disabled={busy === o.org_id}
                        onChange={(e) => void setCustom(o, e.target.checked)}
                      />
                    </label>
                  </td>
                  <td className="actions-cell">
                    <button
                      className="secondary btn-sm"
                      disabled={busy === o.org_id}
                      onClick={() => void issueCredential(o)}
                    >
                      Issue credential
                    </button>{' '}
                    <button
                      className="secondary btn-sm"
                      disabled={busy === o.org_id}
                      onClick={() => void setStatus(o, o.status === 'active' ? 'suspended' : 'active')}
                    >
                      {o.status === 'active' ? 'Suspend' : 'Resume'}
                    </button>
                  </td>
                </tr>
              )
            })}
            {!orgs.length && (
              <tr>
                <td colSpan={6} className="muted">
                  No organizations yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="add-by-hand">
        {creating ? (
          <div className="manual-address">
            <label className="field">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Beth Shalom" autoFocus />
            </label>
            <label className="field">
              Slug
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="beth-shalom"
              />
              <span className="muted small">
                Lowercase letters, numbers and hyphens. It appears in support conversations, so
                make it something that survives being read aloud.
              </span>
            </label>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setCreating(false)} disabled={busy === 'create'}>
                Cancel
              </button>
              <button onClick={() => void createOrg()} disabled={busy === 'create'}>
                {busy === 'create' ? 'Creating…' : 'Create organization'}
              </button>
            </div>
          </div>
        ) : (
          <button className="secondary btn-sm" onClick={() => setCreating(true)}>
            + Create an organization
          </button>
        )}
      </div>
    </>
  )
}
