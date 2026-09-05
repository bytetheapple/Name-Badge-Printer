import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import type { PiDevice, PlatformOrg } from '../../../lib/types'
import {
  describeVersion,
  repoVersions,
  versionDate,
  type RepoVersion,
} from '../../../lib/repoVersions'
import BuildServer from '../BuildServer'

/**
 * The print servers, and what they run.
 *
 * Devices are kept independently of the organizations they were built for,
 * because an organization can be renamed or deleted and the question of what
 * hardware went where outlives both.
 */
export default function Fleet() {
  const [devices, setDevices] = useState<PiDevice[]>([])
  //: Only for the org picker when building a server; the customer list itself
  //: lives on the Organizations tab.
  const [orgs, setOrgs] = useState<PlatformOrg[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  //: The device whose description is being corrected. Customer and notes
  //: only — everything else on the row is state the claim, rotation and
  //: update paths maintain.
  const [editing, setEditing] = useState<
    { device: PiDevice; customer: string; notes: string } | null
  >(null)
  //: The device being reflashed, and the organization it should belong to
  //: afterwards. Held together so the dialog cannot outlive its row.
  const [reflash, setReflash] = useState<{ device: PiDevice; org: string } | null>(null)
  //: Shown once. The claim code is not stored anywhere we can read it back.
  const [reissued, setReissued] = useState<
    { serial: string; claim_code: string; revoked: number } | null
  >(null)
  const [release, setRelease] = useState<{ ref: string | null; notes: string | null } | null>(null)
  const [refDraft, setRefDraft] = useState('')
  //: Which devices the version actions apply to, by serial.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  //: The version to hold on. Editable whether or not anything is selected —
  //: deciding the version and choosing the devices are separate thoughts, and
  //: forcing an order on them is just friction.
  const [holdRef, setHoldRef] = useState('')
  const [versions, setVersions] = useState<RepoVersion[]>([])
  //: Set when the repository could not be read. The pickers fall back to a
  //: text box then: a rate limit or an outage at GitHub must not leave the
  //: fleet unmanageable.
  const [versionsError, setVersionsError] = useState<string | null>(null)

  const load = useCallback(async () => {
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

    const { data: orgRows } = await supabase.rpc('platform_overview')
    setOrgs((orgRows ?? []) as PlatformOrg[])
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Once per visit rather than inside load(): every action reloads, and the
  // unauthenticated GitHub budget is sixty requests an hour.
  useEffect(() => {
    void repoVersions()
      .then((v) => {
        setVersions(v)
        setVersionsError(null)
      })
      .catch((e: Error) => setVersionsError(e.message))
  }, [])

  async function setReleaseRef() {
    const ref = refDraft.trim()
    if (ref) {
      // One question, not two. The fleet release reaches every device that is
      // not pinned elsewhere, so those are what a rollback is measured
      // against — and the warning belongs in the same dialog as the rest of
      // what is about to happen, rather than in a second one after it.
      const warning = rollbackWarning(
        ref,
        devices.filter((d) => !d.pinned_ref),
      )
      const asked =
        `Every print server not pinned to something else will move to ${ref} within about ` +
        `fifteen minutes. A device that fails to start on it reverts itself.` +
        (warning ? `\n\n${warning}` : '') +
        `\n\nContinue?`
      if (!window.confirm(asked)) return
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

  /**
   * Hold or release every selected device.
   *
   * One call each rather than one call for all: the function validates the ref
   * and reports which device it objected to, and at this fleet size the
   * round trips cost nothing. A failure part way through leaves the devices it
   * already changed changed — said plainly rather than implying a rollback
   * that does not happen.
   */
  async function applyHold(ref: string | null) {
    const serials = [...selected]
    if (!serials.length) return
    if (ref) {
      const warning = rollbackWarning(
        ref,
        devices.filter((d) => serials.includes(d.serial)),
      )
      if (warning && !window.confirm(`${warning}\n\nContinue?`)) return
    }
    setBusy('hold')
    setError(null)
    setNotice(null)

    const failed: string[] = []
    for (const serial of serials) {
      const { error } = await supabase.rpc('pin_pi_device', { p_serial: serial, p_ref: ref })
      if (error) failed.push(`${serial}: ${error.message}`)
    }
    setBusy(null)

    const done = serials.length - failed.length
    if (failed.length) {
      setError(
        `${failed.length} of ${serials.length} could not be changed — ` +
          `${done} were. ${failed.join('; ')}`,
      )
    } else {
      setNotice(
        ref
          ? `${done} print server${done === 1 ? '' : 's'} held on ${ref}, whatever the fleet ` +
            `release says.`
          : `${done} print server${done === 1 ? '' : 's'} follow the fleet release again.`,
      )
    }
    setSelected(new Set())
    await load()
  }

  /**
   * What a reported sha actually is.
   *
   * A device reports seven characters, which on their own say nothing — not
   * what changed, and not whether it is older or newer than the fleet. Looking
   * it up in the list already fetched turns it back into a date and a subject.
   * Null for a version older than the window, or when the repository could not
   * be read.
   */
  function known(short: string | null): RepoVersion | null {
    if (!short) return null
    return versions.find((v) => v.short === short || v.sha.startsWith(short)) ?? null
  }

  /**
   * How new a version is, as a position in the list. Lower is newer; null when
   * the version is not in the window at all.
   */
  function rank(short: string | null): number | null {
    if (!short) return null
    const i = versions.findIndex((v) => v.short === short || v.sha.startsWith(short))
    return i === -1 ? null : i
  }

  /**
   * Stop and ask when this would move a device backwards.
   *
   * Rolling back is a legitimate and sometimes urgent thing to do — a release
   * that breaks in the field is fixed fastest by leaving it — so this asks
   * rather than refuses. What it prevents is the accidental version: picking
   * an entry off a list without noticing it is behind what a device already
   * runs, which looks like nothing happening until somebody wonders why a bug
   * they watched get fixed is back.
   *
   * Devices whose version is not in the list are left out of the question. We
   * cannot tell whether that is older or newer, and guessing either way would
   * make this warning untrustworthy, which is worse than not showing it.
   */
  function rollbackWarning(target: string, over: PiDevice[]): string | null {
    const to = rank(target)
    if (to === null) return null
    const back = over.filter((d) => {
      const from = rank(d.running_ref)
      return from !== null && from < to
    })
    if (!back.length) return null
    const names = back.map((d) => `${d.customer ?? d.serial} (${d.running_ref})`).join('\n  ')
    return (
      `${target} is older than what ${
        back.length === 1 ? 'this server is' : 'these servers are'
      } running:\n\n  ${names}\n\n` +
      'Rolling back reintroduces anything fixed since.'
    )
  }

  function toggle(serial: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(serial)) next.delete(serial)
      else next.add(serial)
      return next
    })
  }

  async function saveEdit() {
    if (!editing) return
    setBusy(editing.device.id)
    setError(null)
    const { error } = await supabase.rpc('update_pi_device', {
      p_serial: editing.device.serial,
      p_customer: editing.customer,
      p_notes: editing.notes,
    })
    setBusy(null)
    if (error) {
      setError(error.message)
      return
    }
    setEditing(null)
    await load()
  }

  async function removeDevice(d: PiDevice) {
    if (
      !window.confirm(
        `Remove ${d.serial}? It was never claimed, so there is nothing to keep. ` +
          `The serial is not reused.`,
      )
    ) {
      return
    }
    setBusy(d.id)
    setError(null)
    const { error } = await supabase.rpc('delete_pi_device', { p_serial: d.serial })
    setBusy(null)
    if (error) setError(error.message)
    await load()
  }

  async function doReflash() {
    if (!reflash) return
    setBusy(reflash.device.id)
    setNotice(null)
    setError(null)
    const { data, error } = await supabase.rpc('reissue_pi_device', {
      p_serial: reflash.device.serial,
      p_org: reflash.org || null,
    })
    setBusy(null)
    if (error || !data) {
      setError(error?.message ?? 'Nothing came back.')
      return
    }
    const out = data as { serial: string; claim_code: string; revoked_credentials: number }
    setReflash(null)
    setReissued({
      serial: out.serial,
      claim_code: out.claim_code,
      revoked: out.revoked_credentials,
    })
    await load()
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <>
      <h1>Fleet</h1>
      <p className="muted small">Every print server built, and who it was built for.</p>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <h2 style={{ marginTop: 28 }}>Bridge release</h2>
      <p className="muted small">
        The version every print server converges on, unless it is pinned to something else.
        Devices check every fifteen minutes; one that fails to start on a new version puts the
        old one back by itself and says so below.
      </p>
      <div className="release-row">
        <label className="field">
          <span>Version</span>
          {/* Chosen, not typed. A sha nobody has described is not a thing you
              should be able to put on a fleet — and six weeks later "a1b2c3d"
              answers neither what it changed nor whether it is the one that
              broke a device. */}
          {versionsError ? (
            <input
              value={refDraft}
              onChange={(e) => setRefDraft(e.target.value)}
              placeholder="commit or tag"
            />
          ) : (
            <select value={refDraft} onChange={(e) => setRefDraft(e.target.value)}>
              <option value="">Hold every server where it is</option>
              {versions.map((v) => (
                <option key={v.sha} value={v.short}>
                  {describeVersion(v)}
                </option>
              ))}
            </select>
          )}
        </label>
        <button
          onClick={() => void setReleaseRef()}
          disabled={busy === 'release' || refDraft.trim() === (release?.ref ?? '')}
        >
          {busy === 'release' ? 'Setting…' : 'Set release'}
        </button>
        {release?.ref && (
          <span className="muted small">
            Currently <code>{release.ref}</code>
          </span>
        )}
        {versionsError && (
          <span className="muted small">
            Could not read the repository ({versionsError}) — enter a commit or tag by hand.
          </span>
        )}
      </div>

      <h2 style={{ marginTop: 36 }}>Print servers</h2>

      {/* The version can be typed before anything is selected: deciding which
          version and choosing which devices are separate thoughts. Only the
          buttons wait for a selection. */}
      <div className="release-row">
        <label className="field">
          <span>Hold selected servers on</span>
          {versionsError ? (
            <input
              value={holdRef}
              onChange={(e) => setHoldRef(e.target.value)}
              placeholder="commit or tag"
            />
          ) : (
            <select value={holdRef} onChange={(e) => setHoldRef(e.target.value)}>
              <option value="">Choose a version…</option>
              {versions.map((v) => (
                <option key={v.sha} value={v.short}>
                  {describeVersion(v)}
                </option>
              ))}
            </select>
          )}
        </label>
        <button
          onClick={() => void applyHold(holdRef.trim())}
          disabled={busy === 'hold' || selected.size === 0 || !holdRef.trim()}
        >
          {busy === 'hold' ? 'Holding…' : `Hold ${selected.size || ''}`.trim()}
        </button>
        <button
          className="secondary"
          onClick={() => void applyHold(null)}
          disabled={busy === 'hold' || selected.size === 0}
        >
          Follow the fleet
        </button>
        <span className="muted small">
          {selected.size === 0
            ? 'Select one or more servers below.'
            : `${selected.size} selected.`}
        </span>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th className="tick-col">
                <input
                  type="checkbox"
                  aria-label="Select every print server"
                  checked={devices.length > 0 && selected.size === devices.length}
                  ref={(el) => {
                    // Neither checked nor unchecked when only some are — the
                    // box says "some of these" rather than lying either way.
                    if (el) el.indeterminate = selected.size > 0 && selected.size < devices.length
                  }}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(devices.map((d) => d.serial)) : new Set())
                  }
                />
              </th>
              <th>Serial</th>
              <th>Built for</th>
              <th>Version</th>
              <th>Updates</th>
              <th>Claimed</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td className="tick-col">
                  <input
                    type="checkbox"
                    aria-label={`Select ${d.serial}`}
                    checked={selected.has(d.serial)}
                    onChange={() => toggle(d.serial)}
                  />
                </td>
                <td>
                  <code>{d.serial}</code>
                </td>
                <td>{d.customer ?? <span className="muted">—</span>}</td>
                <td className="small">
                  {d.running_ref ? <code>{d.running_ref}</code> : <span className="muted">—</span>}
                  {known(d.running_ref) && (
                    <div className="muted" title={known(d.running_ref)!.subject}>
                      {versionDate(known(d.running_ref)!.date)}
                      {known(d.running_ref)!.tags.length > 0 &&
                        ` · ${known(d.running_ref)!.tags.map((t) => t.name).join(', ')}`}
                    </div>
                  )}

                  {/* A device that reverted itself. Shown here because
                      otherwise the only symptom is a version that quietly
                      stopped moving with the fleet. */}
                  {d.update_error && <div className="pill pill-sync-failed">{d.update_error}</div>}

                </td>
                <td className="small">
                  {/* Drawn for both states on purpose. Only the pin used to be
                      shown, so a device that follows the fleet and a device
                      nobody had looked at were the same empty cell. */}
                  {d.pinned_ref ? (
                    <span
                      className="pill pill-held"
                      title={
                        `Held on ${d.pinned_ref}. Setting a new fleet release ` +
                        `will not move this device until the hold is lifted.`
                      }
                    >
                      held on <code>{d.pinned_ref}</code>
                    </span>
                  ) : (
                    <span
                      className="pill pill-follows"
                      title={
                        release?.ref
                          ? `Follows the fleet release (${release.ref}).`
                          : 'Follows the fleet release. No release is set, so this ' +
                            'device stays on whatever it was built with.'
                      }
                    >
                      follows the fleet
                    </span>
                  )}
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
                <td className="actions-cell">
                  <button
                    className="secondary btn-sm"
                    disabled={busy === d.id}
                    onClick={() =>
                      setEditing({ device: d, customer: d.customer ?? '', notes: d.notes ?? '' })
                    }
                  >
                    Edit
                  </button>{' '}
                  <button
                    className="secondary btn-sm"
                    disabled={busy === d.id}
                    onClick={() => setReflash({ device: d, org: d.org_id ?? '' })}
                  >
                    Reflash
                  </button>{' '}
                  {/* Only while it has never been claimed. After that its row
                      is the record of what was shipped, and reflashing is how
                      a device is retired. */}
                  {!d.claimed_at && (
                    <button
                      className="secondary btn-sm danger"
                      disabled={busy === d.id}
                      onClick={() => void removeDevice(d)}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!devices.length && (
              <tr>
                <td colSpan={8} className="muted">
                  No print servers built yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editing.device.serial}</h2>
            <label className="field">
              Built for
              <input
                value={editing.customer}
                onChange={(e) => setEditing({ ...editing, customer: e.target.value })}
                placeholder="the congregation's name"
              />
              <span className="muted small">
                Kept even if the organization is later renamed or deleted — "what did I ship
                them" outlives both.
              </span>
            </label>
            <label className="field">
              Notes
              <input
                value={editing.notes}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                placeholder="optional"
              />
            </label>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button disabled={busy === editing.device.id} onClick={() => void saveEdit()}>
                {busy === editing.device.id ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {reflash && (
        <div className="modal-backdrop" onClick={() => setReflash(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Reflash {reflash.device.serial}?</h2>
            <p className="muted small">
              Every credential this server holds stops working immediately, including the ones it
              rotated to since it was built — so the card currently in it cannot come back. It
              will show as never connected until someone writes a new card and runs the install
              command.
            </p>

            <label className="field">
              Belongs to
              <select
                value={reflash.org}
                onChange={(e) => setReflash({ ...reflash, org: e.target.value })}
              >
                <option value="">Unassigned (a spare)</option>
                {orgs.map((o) => (
                  <option key={o.org_id} value={o.org_id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <span className="muted small">
                Leave it where it is to rebuild the same server, or choose another organization to
                move it. Either way it has to be claimed again.
              </span>
            </label>

            <div className="modal-actions">
              <button className="secondary" onClick={() => setReflash(null)}>
                Cancel
              </button>
              <button
                className="danger"
                disabled={busy === reflash.device.id}
                onClick={() => void doReflash()}
              >
                {busy === reflash.device.id ? 'Working…' : 'Reflash it'}
              </button>
            </div>
          </div>
        </div>
      )}

      {reissued && (
        <div className="modal-backdrop" onClick={() => setReissued(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{reissued.serial}</h2>
            <p className="muted small">
              {reissued.revoked === 0
                ? 'It held no live credential, so nothing had to be revoked.'
                : `${reissued.revoked} credential${reissued.revoked === 1 ? '' : 's'} revoked. ` +
                  'The old card is now inert.'}{' '}
              Write a new card with this serial as the hostname, then run this on it. The claim
              code is shown once.
            </p>
            <pre className="token-secret">
              curl -sSL https://guestbadges.com/pi.sh | sudo bash -s -- {reissued.claim_code}
            </pre>
            <button
              className="secondary btn-sm"
              onClick={() =>
                void navigator.clipboard?.writeText(
                  `curl -sSL https://guestbadges.com/pi.sh | sudo bash -s -- ${reissued.claim_code}`,
                )
              }
            >
              Copy the command
            </button>
            <div className="modal-actions">
              <button onClick={() => setReissued(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      <div className="add-by-hand">
        {building ? (
          <BuildServer orgs={orgs} onDone={() => void load()} />
        ) : (
          <button className="secondary btn-sm" onClick={() => setBuilding(true)}>
            + Build a print server
          </button>
        )}
      </div>
    </>
  )
}
