import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import { driveFolderId } from '../../lib/drive'
import OrgLogo from './OrgLogo'

type SelfieMode = 'off' | 'optional' | 'required'

export default function Settings() {
  const { orgId, isAdmin } = useOrg()
  const [selfieMode, setSelfieMode] = useState<SelfieMode>('off')
  //: Where the photos go. Edited here rather than under Integrations: which
  //: folder to file visitor photos in is a decision about how the congregation
  //: runs its welcome desk, not part of connecting a Google account.
  const [folderId, setFolderId] = useState('')
  //: Whether Drive is connected at all — service account, key, and switched
  //: on. An admin cannot read the integration itself (it belongs to the
  //: owner), so this is the one fact the database will tell them about it.
  const [driveConnected, setDriveConnected] = useState(false)
  const [pronounsEnabled, setPronounsEnabled] = useState(false)
  // Snapshot of the last-saved values, so the Save button can grey out until
  // something actually changes.
  const [saved, setSaved] = useState({
    selfieMode: 'off' as SelfieMode,
    folderId: '',
    pronounsEnabled: false,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  //: Pronouns is excluded: it writes itself, so it is never pending.
  const dirty = selfieMode !== saved.selfieMode || folderId.trim() !== saved.folderId

  // Asking for a photo with nowhere to put it can only fail at upload time,
  // in front of a visitor. Both halves have to be true before it is offered:
  // an account that can write to Drive, and a folder to write into.
  const hasFolder = folderId.trim() !== ''
  const needsFolder = selfieMode !== 'off' && !hasFolder

  useEffect(() => {
    if (!orgId) return
    void (async () => {
      const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .eq('org_id', orgId)
        .maybeSingle()
      if (error) {
        setError(error.message)
        setLoading(false)
        return
      }
      const mode = (data?.selfie_mode ?? 'off') as SelfieMode
      const folder = data?.selfie_drive_folder_id ?? ''
      const pronouns = Boolean(data?.pronouns_enabled)
      setSelfieMode(mode)
      setFolderId(folder)
      setPronounsEnabled(pronouns)
      setSaved({ selfieMode: mode, folderId: folder, pronounsEnabled: pronouns })

      const { data: ready } = await supabase.rpc('integration_ready', {
        p_org: orgId,
        p_kind: 'google_drive',
      })
      setDriveConnected(Boolean(ready))
      setLoading(false)
    })()
  }, [orgId])

  /** Written on click. Nothing else depends on it, so there is nothing for a
   *  Save button to coordinate — only a change to lose by walking away. */
  async function togglePronouns(value: boolean) {
    const before = pronounsEnabled
    setPronounsEnabled(value)
    setError(null)
    const { error } = await supabase
      .from('app_settings')
      .update({ pronouns_enabled: value })
      .eq('org_id', orgId)
    if (error) {
      // Back where it was: a switch showing a state the database does not
      // hold is worse than the failure.
      setPronounsEnabled(before)
      setError(error.message)
      return
    }
    setSaved((p) => ({ ...p, pronounsEnabled: value }))
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    // Refused rather than saved-and-broken: this is exactly the state where a
    // visitor is asked for a photo that cannot be stored.
    if (needsFolder) {
      setError('Choose a Google Drive folder before asking visitors for a photo.')
      return
    }
    // Stored as an id whatever was pasted. Refused rather than saved when a
    // link turns out not to name a folder — a link to a file looks right and
    // fails at the first upload, in front of a visitor.
    const folder = driveFolderId(folderId)
    if (folderId.trim() && !folder) {
      setError(
        'That does not look like a Google Drive folder. Open the folder in Drive and copy the ' +
          'address from your browser.',
      )
      return
    }
    setSaving(true)
    const { error } = await supabase
      .from('app_settings')
      .update({ selfie_mode: selfieMode, selfie_drive_folder_id: folder || null })
      .eq('org_id', orgId)
    setSaving(false)
    if (error) {
      setError(error.message)
    } else {
      setFolderId(folder)
      setSaved({ selfieMode, folderId: folder, pronounsEnabled })
    }
  }

  if (loading) return <p className="muted">Loading…</p>
  if (!isAdmin) {
    return (
      <>
        <h1>Settings</h1>
        <p className="muted">Only owners and admins can change settings.</p>
      </>
    )
  }

  return (
    <>
      <h1>Settings</h1>
      {error && <div className="error">{error}</div>}

      {/* The column, so the panes line up whether or not they are part of the
          form. The selfie settings are; pronouns writes itself. */}
      <div className="config-form">
      <form onSubmit={save}>
        <section className="card">
          <h2>Selfie (visitors only)</h2>
          {/* Said before the control rather than after it, because it is the
              reason the control is unavailable. */}
          {!driveConnected && (
            <p className="muted small" style={{ marginBottom: 12 }}>
              Visitor photos are stored in your congregation's Google Drive, so Drive has to be
              connected before selfies can be collected. An owner can do that under{' '}
              <strong>Integrations → Google Drive</strong>. Until then the only option here is no
              selfie.
            </p>
          )}

          <label className="field">
            Selfie requirement
            {/* The control stays live even when Drive is not connected — only
                the two options that need it are unavailable. Disabling the
                whole thing would trap an organization whose Drive was
                disconnected while selfies were switched on: unable to select
                the one value that would stop the failures. */}
            <select
              value={selfieMode}
              onChange={(e) => {
                const next = e.target.value as SelfieMode
                // Belt and braces: the options are disabled, but a keyboard or
                // an older browser can still land here, and silently ignoring
                // the choice would look like the page was broken.
                if (next !== 'off' && !driveConnected) {
                  setError(
                    'Connect Google Drive under Integrations → Google Drive before collecting ' +
                      'visitor photos.',
                  )
                  return
                }
                setError(null)
                setSelfieMode(next)
              }}
            >
              <option value="off">No selfie</option>
              <option value="optional" disabled={!driveConnected}>
                Optional selfie
              </option>
              <option value="required" disabled={!driveConnected}>
                Required selfie
              </option>
            </select>
          </label>

          {/* The folder is only a question once photos are actually being
              collected. Asking for it up front is asking for something that
              may never be used. */}
          {driveConnected && selfieMode !== 'off' && (
            <>
            {/* Before the field, not after it: it explains why the box is
                there at all. */}
            <p className="muted small" style={{ marginTop: 12 }}>
              Selfies are stored in your Google Drive, in the folder you specify below. Paste the
              URL for the Google Drive folder you want to use.
            </p>
            <label className="field">
              Google Drive folder
              <input
                value={folderId}
                onChange={(e) => setFolderId(e.target.value)}
                onBlur={(e) => {
                  // Reduced to the id when they leave the box rather than as
                  // they type: a field that rewrites itself under the cursor is
                  // unusable, and seeing the id appear on blur is what confirms
                  // the link was understood.
                  const id = driveFolderId(e.target.value)
                  if (id) setFolderId(id)
                }}
                placeholder="https://drive.google.com/drive/folders/…"
              />
            </label>
            </>
          )}

          {/* Already asking for photos, and Drive has gone away underneath it.
              The urgent case, and the only one where something is actively
              failing in front of visitors. */}
          {!driveConnected && selfieMode !== 'off' && (
            <p className="warn" style={{ marginTop: 8 }}>
              Visitors are being asked for a photo, but Google Drive is not connected, so every
              upload is failing. Choose <strong>No selfie</strong> here, or ask an owner to
              reconnect Drive under Integrations.
            </p>
          )}

          {needsFolder && (
            <p className="warn" style={{ marginTop: 8 }}>
              Choose a folder before saving — without one every photo a visitor takes would fail
              to store.
            </p>
          )}

          {/* Inside the pane it applies to. It used to sit below every card,
              between Pronouns and the name mark, which made it look like it
              saved those too — it saves neither. The mode and the folder stay
              behind it together on purpose: saving a mode with no folder is
              the one broken state this pane exists to prevent. */}
          <button type="submit" disabled={saving || !dirty} style={{ marginTop: 16 }}>
            {saving ? 'Saving…' : 'Save selfie settings'}
          </button>
        </section>
      </form>

      <section className="card">
        <h2>Pronouns</h2>
        {/* Takes effect on click, like the integration switches. There is
            nothing to coordinate it with, so making someone press Save for one
            checkbox was only ever a way to lose the change. */}
        <label className="check">
          <input
            type="checkbox"
            checked={pronounsEnabled}
            onChange={(e) => void togglePronouns(e.target.checked)}
          />
          Show an optional pronouns field on the sign-in form
        </label>
      </section>

      {/* In the column too. Outside it the name mark ran to the full width of
          the page against two narrower panes, and picked up none of the
          column's spacing, so it sat tight under Pronouns. */}
      <OrgLogo />
      </div>

    </>
  )
}
