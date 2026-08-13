import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'

type SelfieMode = 'off' | 'optional' | 'required'

export default function Settings() {
  const [selfieMode, setSelfieMode] = useState<SelfieMode>('off')
  const [folderId, setFolderId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase.from('app_settings').select('*').eq('id', 1).single()
      if (error) {
        setError(error.message)
        setLoading(false)
        return
      }
      setSelfieMode((data.selfie_mode ?? 'off') as SelfieMode)
      setFolderId(data.selfie_drive_folder_id ?? '')
      setLoading(false)
    })()
  }, [])

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMsg(null)
    setError(null)
    const { error } = await supabase
      .from('app_settings')
      .update({ selfie_mode: selfieMode, selfie_drive_folder_id: folderId.trim() || null })
      .eq('id', 1)
    setSaving(false)
    if (error) setError(error.message)
    else setMsg('Saved.')
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <>
      <h1>Settings</h1>
      {msg && <div className="notice">{msg}</div>}
      {error && <div className="error">{error}</div>}

      <form onSubmit={save} className="config-form">
        <section className="card">
          <h2>Visitor selfie</h2>
          <div className="grid2">
            <label className="field">
              Selfie requirement
              <select value={selfieMode} onChange={(e) => setSelfieMode(e.target.value as SelfieMode)}>
                <option value="off">No selfie</option>
                <option value="optional">Optional selfie</option>
                <option value="required">Required selfie</option>
              </select>
            </label>
            <label className="field">
              Google Drive folder ID
              <input
                value={folderId}
                onChange={(e) => setFolderId(e.target.value)}
                placeholder="folder id from the Drive URL"
              />
            </label>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            Applies to visitors only. Selfies upload to this Drive folder as
            First_Last_Date_Time. The folder must be shared with the service account, and its
            ID is the part after <code>/folders/</code> in the folder's URL.
          </p>
        </section>

        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </form>
    </>
  )
}
