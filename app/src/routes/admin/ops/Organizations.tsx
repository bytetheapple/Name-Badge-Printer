import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../../lib/supabase'
import { useOrg } from '../../../lib/org'
import { lastSeenLabel } from '../../../lib/secrets'
import type { PlatformOrg } from '../../../lib/types'

const BRIDGE_FRESH_MS = 45000

/** The fields the detail panel edits, in one place so Save writes exactly them. */
type Draft = {
  name: string
  internal_name: string
  address: string
  notes: string
  custom_integrations: boolean
  events_enabled: boolean
}

function draftOf(o: PlatformOrg): Draft {
  return {
    name: o.name,
    internal_name: o.internal_name ?? '',
    address: o.address ?? '',
    notes: o.notes ?? '',
    custom_integrations: o.custom_integrations,
    events_enabled: o.events_enabled,
  }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (Object.keys(a) as (keyof Draft)[]).every((k) => a[k] === b[k])
}

/**
 * The customer list, and what you do to a customer.
 *
 * Creating a tenant, issuing a print server's credential, granting custom
 * integrations, suspending, deleting. Every one of these was a hand-written
 * SQL statement once, and two of them — revoking a stolen device, resuming a
 * suspended congregation — are things you would want to do quickly and
 * possibly from a phone.
 */
export default function Organizations() {
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
  //: Which row the detail panel is about. The table is a summary now; every
  //: action and every setting lives in the panel for the selected one.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  //: The panel's editable fields, as typed. Reset whenever the selection or
  //: the loaded row changes, so a stale draft cannot be saved over a row
  //: somebody else moved.
  const [draft, setDraft] = useState<Draft | null>(null)
  const { reload, switchOrg } = useOrg()
  const navigate = useNavigate()

  const selected = orgs.find((o) => o.org_id === selectedId) ?? null

  useEffect(() => {
    setDraft(selected ? draftOf(selected) : null)
  }, [selected])

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
    setNotice(
      `${name.trim()} created. Open it to set up printers and integrations, then invite their ` +
        `first owner from the Members tab.`,
    )
    setSlug('')
    setName('')
    setCreating(false)
    await load()
    // The switcher lists every organization for an operator, and there is a
    // new one.
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

  /**
   * Write the panel's fields for the selected organization.
   *
   * One update rather than a write per control. The entitlements used to save
   * on click from checkboxes in the table, which was fine for two booleans and
   * wrong once there are names and an address beside them: a page where some
   * fields save themselves and others wait for a button is a page where
   * somebody loses an edit.
   *
   * Turning Events off leaves the customer's event integrations alone: they
   * stop accepting registrations and say so, and come back untouched if it is
   * turned on again. A billing decision should not delete anything.
   */
  async function save() {
    if (!selected || !draft) return
    if (!draft.name.trim()) {
      setError('An organization needs a name.')
      return
    }
    setBusy(selected.org_id)
    setNotice(null)
    setError(null)
    const { error } = await supabase
      .from('organizations')
      .update({
        name: draft.name.trim(),
        internal_name: draft.internal_name.trim() || null,
        address: draft.address.trim() || null,
        notes: draft.notes.trim() || null,
        custom_integrations: draft.custom_integrations,
        events_enabled: draft.events_enabled,
      })
      .eq('id', selected.org_id)
    setBusy(null)
    if (error) {
      setError(error.message)
      return
    }
    setNotice(`Saved ${draft.name.trim()}.`)
    await load()
    // The switcher shows the name, and it may just have changed.
    await reload()
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
    // The row the panel was about is gone; a panel left open on it would be
    // editing nothing.
    setSelectedId(null)
    await load()
    // One just disappeared — possibly the one currently selected.
    await reload()
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <>
      <h1>Organizations</h1>
      <p className="muted small">Every customer on this deployment.</p>

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

      {/* A summary, and a way to pick one. Every action and every setting is
          in the panel below for the selected row -- a table that tried to
          carry all of it pushed its buttons off the right edge, where nobody
          found them, and had checkboxes saving on click beside text that
          would not have. */}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Organization</th>
              <th>Status</th>
              <th>Print server</th>
              <th>Activity</th>
              <th>Custom</th>
              <th>Events</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => {
              const seen = o.bridge_last_seen ? new Date(o.bridge_last_seen).getTime() : null
              const online = seen !== null && Date.now() - seen < BRIDGE_FRESH_MS
              const isSelected = o.org_id === selectedId
              return (
                <tr
                  key={o.org_id}
                  onClick={() => setSelectedId(o.org_id)}
                  className={isSelected ? 'is-selected' : undefined}
                  style={{
                    cursor: 'pointer',
                    ...(o.status !== 'active' ? { opacity: 0.6 } : {}),
                  }}
                >
                  <td>
                    {/* The operator's handle first when there is one: it is
                        what tells two customers of the same name apart, which
                        is what this column is for. The real name is what
                        prints, and it sits underneath. */}
                    {o.internal_name ? (
                      <>
                        {o.internal_name}
                        <div className="muted small">{o.name}</div>
                      </>
                    ) : (
                      o.name
                    )}
                    <div className="muted small">
                      <code>{o.slug}</code>
                      {o.members === 0 && ' · nobody invited yet'}
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
                  <td className="small">
                    {o.printers} printer{o.printers === 1 ? '' : 's'} · {o.members} member
                    {o.members === 1 ? '' : 's'}
                    <div className="muted">
                      {o.entries_30d} sign-in{o.entries_30d === 1 ? '' : 's'} in 30 days
                    </div>
                  </td>
                  <td className="small">{o.custom_integrations ? 'Yes' : <span className="muted">—</span>}</td>
                  <td className="small">{o.events_enabled ? 'Yes' : <span className="muted">—</span>}</td>
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

      {selected && draft && (
        <section className="card" style={{ marginTop: 20 }}>
          <h2>{selected.internal_name || selected.name}</h2>

          <div className="grid2">
            <label className="field">
              Name
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <span className="muted small">
                As their guests see it: on badges, the sign-in form and the lobby sign.
              </span>
            </label>
            <label className="field">
              Internal name
              <input
                value={draft.internal_name}
                onChange={(e) => setDraft({ ...draft, internal_name: e.target.value })}
                placeholder="Temple Beth El (Aptos)"
              />
              <span className="muted small">
                For telling similar names apart here. The customer never sees it.
              </span>
            </label>
          </div>

          <label className="field">
            Address
            <textarea
              rows={2}
              value={draft.address}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            />
          </label>
          <label className="field">
            Notes
            <textarea
              rows={3}
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </label>

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 4 }}>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.custom_integrations}
                onChange={(e) => setDraft({ ...draft, custom_integrations: e.target.checked })}
              />
              Custom integrations
              <span className="muted small"> — Google Form and ShulCloud, once built for them</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.events_enabled}
                onChange={(e) => setDraft({ ...draft, events_enabled: e.target.checked })}
              />
              Events
            </label>
          </div>

          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button
              onClick={() => void save()}
              disabled={busy === selected.org_id || sameDraft(draft, draftOf(selected))}
            >
              {busy === selected.org_id ? 'Saving…' : 'Save'}
            </button>
          </div>

          {/* What you do to a customer, apart from editing them. Kept apart
              from Save because none of these are saved: each acts on its own
              and says so. */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              marginTop: 20,
              paddingTop: 16,
              borderTop: '1px solid var(--border)',
            }}
          >
            <button
              className="secondary btn-sm"
              onClick={() => {
                switchOrg(selected.org_id)
                navigate('/admin/entries')
              }}
            >
              Open
            </button>
            <button
              className="secondary btn-sm"
              disabled={busy === selected.org_id}
              onClick={() => void issueCredential(selected)}
            >
              Issue credential
            </button>
            <button
              className="secondary btn-sm"
              disabled={busy === selected.org_id}
              onClick={() =>
                void setStatus(selected, selected.status === 'active' ? 'suspended' : 'active')
              }
            >
              {selected.status === 'active' ? 'Suspend' : 'Resume'}
            </button>
            <button
              className="secondary btn-sm danger"
              disabled={busy === selected.org_id}
              onClick={() => {
                setDoomed(selected)
                setTypedSlug('')
                setError(null)
              }}
            >
              Delete
            </button>
          </div>
        </section>
      )}

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
