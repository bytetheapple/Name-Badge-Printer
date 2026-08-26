import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'

const LOGO_BUCKET = 'badge-headers'
const MAX_LOGO_BYTES = 2_000_000

/** Content-addressed, so re-uploading the same image reuses the object and the
 *  bridge's cache, while a changed image always gets a fresh URL. */
async function hashBytes(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The organization's name mark, printed at the top of a badge.
 *
 * Per organization rather than per printer: a congregation has one mark, and
 * every printer that chooses the logo header should print the same one. The
 * wording above a badge is a property of the printer — a lobby desk and a
 * social hall can differ — but the mark is not.
 *
 * Until this existed the logo was a PNG shipped inside the bridge, which meant
 * one congregation's mark on every deployment.
 */
export default function OrgLogo() {
  const { orgId, isAdmin } = useOrg()
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A real button driving a hidden input, rather than a styled <label>: the
  // button styles are element-scoped, so a label gets none of them.
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!orgId) return
    const { data, error } = await supabase
      .from('app_settings')
      .select('logo_url')
      .eq('org_id', orgId)
      .maybeSingle()
    if (error) setError(error.message)
    setLogoUrl((data?.logo_url as string | null) ?? null)
    setLoading(false)
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  async function upload(file: File) {
    setMsg(null)
    setError(null)
    if (!file.type.startsWith('image/')) {
      setError('That file is not an image.')
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError('That image is too large (2 MB maximum).')
      return
    }
    setBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const ext = file.type === 'image/png' ? 'png' : 'jpg'
      const path = `${await hashBytes(buf)}.${ext}`
      const up = await supabase.storage
        .from(LOGO_BUCKET)
        .upload(path, buf, { contentType: file.type, upsert: true })
      if (up.error) throw up.error
      const url = supabase.storage.from(LOGO_BUCKET).getPublicUrl(path).data.publicUrl
      const { error } = await supabase
        .from('app_settings')
        .update({ logo_url: url })
        .eq('org_id', orgId)
      if (error) throw error
      setLogoUrl(url)
      setMsg('Name mark updated.')
    } catch (err) {
      setError(`Upload failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (
      !window.confirm(
        'Remove the name mark? Any printer set to use the logo will fall back to text.',
      )
    ) {
      return
    }
    setBusy(true)
    setMsg(null)
    setError(null)
    // The stored object is left in place: it is content-addressed and may be
    // referenced by a printer's own header image. Clearing the reference is
    // what turns the option off.
    const { error } = await supabase
      .from('app_settings')
      .update({ logo_url: null })
      .eq('org_id', orgId)
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    setLogoUrl(null)
    setMsg('Name mark removed.')
  }

  if (!isAdmin || loading) return null

  return (
    <section className="card">
      <h2>Name mark</h2>
      <p className="muted small">
        Your organization's logo, printed at the top of a badge. Until one is uploaded, the
        Printers tab offers only text or a per-printer graphic.
      </p>

      {msg && <div className="notice">{msg}</div>}
      {error && <div className="error">{error}</div>}

      <div className="org-logo">
        <div className="org-logo-preview" aria-label="Name mark preview">
          {logoUrl ? <img src={logoUrl} alt="Your organization's name mark" /> : <span className="muted small">None uploaded</span>}
        </div>

        <div className="org-logo-actions">
          <button className="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? 'Uploading…' : logoUrl ? 'Replace…' : 'Upload…'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              // Cleared so choosing the same file twice still fires onChange.
              e.target.value = ''
              if (f) void upload(f)
            }}
          />
          {logoUrl && (
            <button className="secondary btn-sm" onClick={() => void remove()} disabled={busy}>
              Remove
            </button>
          )}
          <p className="muted small">
            PNG or JPEG, 2 MB maximum. It is printed about 2.4 inches wide in black and white, so
            a wide mark with strong contrast reproduces best — fine detail and pale colours do
            not survive a thermal printer.
          </p>
        </div>
      </div>
    </section>
  )
}
