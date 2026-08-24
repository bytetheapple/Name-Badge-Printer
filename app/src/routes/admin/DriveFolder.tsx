import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'

/**
 * Which Drive folder visitor selfies land in.
 *
 * Stored on app_settings rather than with the Drive credential, which is where
 * it looks like it belongs — moving it would mean a migration and a change to
 * upload-selfie for no behavioural gain. It is edited here because this is
 * where someone setting up Drive will look for it.
 *
 * Settings reads the same value to decide whether asking for a selfie is even
 * possible: with no folder there is nowhere to put one, so those options are
 * disabled there rather than failing later at the upload.
 */
export default function DriveFolder() {
  const { orgId, isAdmin } = useOrg()
  const [folderId, setFolderId] = useState('')
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!orgId) return
    const { data, error } = await supabase
      .from('app_settings')
      .select('selfie_drive_folder_id')
      .eq('org_id', orgId)
      .maybeSingle()
    if (error) setError(error.message)
    const value = (data?.selfie_drive_folder_id as string | null) ?? ''
    setFolderId(value)
    setSaved(value.trim())
    setLoading(false)
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  async function save() {
    setBusy(true)
    setNotice(null)
    setError(null)
    const value = folderId.trim()
    const { error } = await supabase
      .from('app_settings')
      .update({ selfie_drive_folder_id: value || null })
      .eq('org_id', orgId)
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    setSaved(value)
    setNotice(value ? 'Folder saved.' : 'Folder cleared — selfies are switched off.')
  }

  if (!isAdmin) return null
  if (loading) return null

  const dirty = folderId.trim() !== saved

  return (
    <section className="card">
      <h2>Selfie folder</h2>
      <p className="muted small">Where visitor selfies are uploaded.</p>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <label className="field">
        Google Drive folder ID
        <input
          value={folderId}
          onChange={(e) => setFolderId(e.target.value)}
          placeholder="folder id from the Drive URL"
        />
        <span className="muted small">
          The part after <code>/folders/</code> in the folder's URL. Share the folder with the
          service account above, or uploads will be refused.
        </span>
      </label>

      {!saved && (
        <p className="muted small">
          With no folder set, selfies cannot be collected — the options for them under Settings
          are unavailable until one is.
        </p>
      )}

      <button type="button" onClick={() => void save()} disabled={busy || !dirty}>
        {busy ? 'Saving…' : dirty ? 'Save folder' : 'Saved'}
      </button>
    </section>
  )
}
