import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'

type SelfieMode = 'off' | 'optional' | 'required'

export default function Settings() {
  const { orgId, isAdmin } = useOrg()
  const [selfieMode, setSelfieMode] = useState<SelfieMode>('off')
  //: Not editable here — it is set beside the Drive credential, under
  //: Integrations. Read only to know whether selfies are possible at all.
  const [folderId, setFolderId] = useState('')
  const [pronounsEnabled, setPronounsEnabled] = useState(false)
  // Snapshot of the last-saved values, so the Save button can grey out until
  // something actually changes.
  const [saved, setSaved] = useState({ selfieMode: 'off' as SelfieMode, pronounsEnabled: false })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const dirty = selfieMode !== saved.selfieMode || pronounsEnabled !== saved.pronounsEnabled

  // No folder means nowhere to put a selfie, so asking for one could only fail
  // at upload time. Better to say so here than to let it be chosen.
  const hasFolder = folderId.trim() !== ''

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
      setSaved({ selfieMode: mode, pronounsEnabled: pronouns })
      setLoading(false)
    })()
  }, [orgId])

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMsg(null)
    setError(null)
    const { error } = await supabase
      .from('app_settings')
      .update({ selfie_mode: selfieMode, pronouns_enabled: pronounsEnabled })
      .eq('org_id', orgId)
    setSaving(false)
    if (error) {
      setError(error.message)
    } else {
      setSaved({ selfieMode, pronounsEnabled })
      setMsg('Saved.')
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
      {msg && !dirty && <div className="notice">{msg}</div>}
      {error && <div className="error">{error}</div>}

      <form onSubmit={save} className="config-form">
        <section className="card">
          <h2>Visitor selfie (applies to visitors only)</h2>
          <label className="field">
            Selfie requirement
            <select
              value={selfieMode}
              onChange={(e) => setSelfieMode(e.target.value as SelfieMode)}
            >
              <option value="off">No selfie</option>
              <option value="optional" disabled={!hasFolder}>
                Optional selfie
              </option>
              <option value="required" disabled={!hasFolder}>
                Required selfie
              </option>
            </select>
          </label>
          {/* One message, not two. Without a folder there are two different
              situations — nothing is being asked for, or something is and is
              failing — and only the second is urgent. */}
          {hasFolder ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              Selfies upload as First_Last_Date_Time to the folder set under Integrations →
              Google Drive.
            </p>
          ) : selfieMode === 'off' ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              Selfies need somewhere to go. Set a Google Drive folder under Integrations →
              Google Drive, and these options become available.
            </p>
          ) : (
            <p className="warn" style={{ marginTop: 8 }}>
              Selfies are set to {selfieMode === 'required' ? 'required' : 'optional'}, but no
              Drive folder is configured, so every upload is failing. Set one under Integrations
              → Google Drive, or change this to no selfie.
            </p>
          )}
        </section>

        <section className="card">
          <h2>Pronouns</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={pronounsEnabled}
              onChange={(e) => setPronounsEnabled(e.target.checked)}
            />
            Show an optional pronouns field on the sign-in form
          </label>
          <p className="muted small" style={{ marginTop: 8 }}>
            When on, people can add pronouns, which print under their name on the badge.
          </p>
        </section>

        <button type="submit" disabled={saving || !dirty}>
          {saving ? 'Saving…' : dirty ? 'Save settings' : 'Saved'}
        </button>
      </form>

    </>
  )
}
