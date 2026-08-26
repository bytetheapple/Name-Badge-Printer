import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import { lastSeenLabel } from '../../lib/secrets'
import type { PiDevice, PlatformOrg } from '../../lib/types'
import BuildServer from './BuildServer'

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
  //: The org being deleted, and the slug typed so far. Held together so the
  //: dialog cannot outlive the row it was opened for.
  const [doomed, setDoomed] = useState<PlatformOrg | null>(null)
  const [typedSlug, setTypedSlug] = useState('')
  const [devices, setDevices] = useState<PiDevice[]>([])
  const [building, setBuilding] = useState(false)
  const [release, setRelease] = useState<{ ref: string | null; notes: string | null } | null>(null)
  const [refDraft, setRefDraft] = useState('')
  const { reload, isPlatformAdmin } = useOrg()

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('platform_overview')
    if (error) setError(error.message)
    else setOrgs((data ?? []) as PlatformOrg[])

    const { data: rows } = await supabase
      .from('pi_devices')
      .select(
        'id, serial, org_id, customer, notes, claim_prefix, claimed_at, bridge_token_id, ' +
          'created_at, pinned_ref, running_ref, last_seen, update_error',
      )
      .order('created_at', { ascending: false })
    setDevices((rows ?? []) as unknown as PiDevice[])

    const { data: rel } = await supabase
      .from('bridge_release')
      .select('ref, notes')
      .maybeSingle()
    setRelease((rel as { ref: string | null; notes: string | null } | null) ?? null)
    setRefDraft((rel?.ref as string | null) ?? '')
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
  async function setReleaseRef() {
    const ref = refDraft.trim()
    if (
      ref &&
      !window.confirm(
        `Every print server not pinned to something else will move to ${ref} within about ` +
          `fifteen minutes. A device that fails to start on it reverts itself. Continue?`,
      )
    ) {
      return
    }
    setBusy('release')
    setError(null)
    const { error } = await supabase
      .from('bridge_release')
      .update({ ref: ref || null, updated_at: new Date().toISOString() })
      .eq('id', true)
    setBusy(null)
    if (error) {
      setError(error.message)
      return
    }
    setNotice(ref ? `Release set to ${ref}.` : 'Release cleared — devices stay where they are.')
    await load()
  }

  async function remove() {
    if (!doomed) return
    setBusy(doomed.org_id)
    setError(null)
    const { data, error } = await supabase.rpc('delete_organization', {
      p_org: doomed.org_id,
      p_confirm_slug: typedSlug.trim(),
    })
    setBusy(null)
    if (error) {
      setError(error.message)
      return
    }
    const gone = (data ?? {}) as Record<string, unknown>
    setNotice(
      `Deleted ${gone.name}: ${gone.printers} printer(s), ${gone.entries} sign-in(s), ` +
        `${gone.members} member(s). This cannot be undone.`,
    )
    setDoomed(null)
    setTypedSlug('')
    await load()
    // The org switcher is built from memberships, and one just disappeared —
    // possibly the one currently selected.
    await reload()
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
                    </button>{' '}
                    <button
                      className="secondary btn-sm danger"
                      disabled={busy === o.org_id}
                      onClick={() => {
                        setDoomed(o)
                        setTypedSlug('')
                        setError(null)
                      }}
                    >
                      Delete
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

      {doomed && (
        <div className="modal-backdrop" onClick={() => setDoomed(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>Delete {doomed.name}?</h2>
            {/* The real numbers, before the question. A slug alone guards
                against the wrong row; this guards against the wrong belief
                about what is in it. */}
            <p className="warn">
              This permanently deletes {doomed.printers} printer
              {doomed.printers === 1 ? '' : 's'}, {doomed.entries_30d} sign-in
              {doomed.entries_30d === 1 ? '' : 's'} in the last 30 days and every older one,
              {' '}{doomed.members} member{doomed.members === 1 ? '' : 's'}, and all of this
              organization's settings, credentials and history. There is no undo.
            </p>
            <p className="muted small">
              Suspending instead stops their kiosks and print server without destroying anything,
              and can be reversed.
            </p>
            <label className="field">
              {/* One flex item, or the column layout stacks the three
                  pieces of this sentence onto separate lines. */}
              <span>
                Type <code>{doomed.slug}</code> to confirm
              </span>
              <input
                value={typedSlug}
                onChange={(e) => setTypedSlug(e.target.value)}
                autoFocus
                autoComplete="off"
              />
            </label>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setDoomed(null)} disabled={busy === doomed.org_id}>
                Cancel
              </button>
              <button
                className="danger"
                onClick={() => void remove()}
                disabled={busy === doomed.org_id || typedSlug.trim() !== doomed.slug}
              >
                {busy === doomed.org_id ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}

      <h2 style={{ marginTop: 36 }}>Bridge release</h2>
      <p className="muted small">
        The version every print server converges on, unless it is pinned to something else.
        Devices check every fifteen minutes; one that fails to start on a new version puts the
        old one back by itself and says so below.
      </p>
      <div className="release-row">
        <label className="field">
          <span>Commit or tag</span>
          <input
            value={refDraft}
            onChange={(e) => setRefDraft(e.target.value)}
            placeholder="leave empty to hold every device where it is"
          />
        </label>
        <button
          onClick={() => void setReleaseRef()}
          disabled={busy === 'release' || refDraft.trim() === (release?.ref ?? '')}
        >
          {busy === 'release' ? 'Setting…' : 'Set release'}
        </button>
      </div>

      <h2 style={{ marginTop: 36 }}>Print servers</h2>
      <p className="muted small">
        Every device built, and who it was built for. Kept independently of the organizations
        themselves, because an organization can be renamed or deleted and the question of what
        hardware went where outlives both.
      </p>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Serial</th>
              <th>Built for</th>
              <th>Version</th>
              <th>Claimed</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>
                  <code>{d.serial}</code>
                </td>
                <td>{d.customer ?? <span className="muted">—</span>}</td>
                <td className="small">
                  {d.running_ref ? <code>{d.running_ref}</code> : <span className="muted">—</span>}
                  {d.pinned_ref && (
                    <div className="muted">
                      pinned to <code>{d.pinned_ref}</code>
                    </div>
                  )}
                  {/* A device that reverted itself. Shown here because
                      otherwise the only symptom is a version that quietly
                      stopped moving with the fleet. */}
                  {d.update_error && <div className="pill pill-sync-failed">{d.update_error}</div>}
                </td>
                <td className="small">
                  {d.claimed_at ? (
                    new Date(d.claimed_at).toLocaleDateString()
                  ) : (
                    /* Allocated but never booted — a card that was written and
                       not finished, or one still on the bench. */
                    <span className="muted">not yet</span>
                  )}
                </td>
                <td className="muted small">{d.notes ?? ''}</td>
              </tr>
            ))}
            {!devices.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No print servers built yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="add-by-hand">
        {building ? (
          <BuildServer orgs={orgs} onDone={() => void load()} />
        ) : (
          <button className="secondary btn-sm" onClick={() => setBuilding(true)}>
            + Build a print server
          </button>
        )}
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
