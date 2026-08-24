import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import defaultHeader from '../../assets/shir-hadash-logo.png'
import type { Printer } from '../../lib/types'

const HEADER_BUCKET = 'badge-headers'
const MAX_HEADER_BYTES = 2_000_000

/** Content-addressed name, so re-uploading the same image reuses the object
 *  and the bridge's cache, and a changed image always gets a fresh URL. */
async function hashBytes(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * What this printer's badges say, with a preview.
 *
 * Header and footer are per printer rather than per organization: the wording
 * belongs to the place the badge is handed out. The preview is an approximation
 * — the printed badge is rendered by the bridge with real fonts — but it shows
 * the proportions and the three bands, which is what people are deciding about.
 */
export default function BadgeDesign({
  printer,
  onChanged,
}: {
  printer: Printer
  onChanged: () => void
}) {
  const [header, setHeader] = useState(printer.badge_header ?? 'WELCOME')
  const [subtitle, setSubtitle] = useState(printer.badge_subtitle ?? '')
  const [useGraphic, setUseGraphic] = useState(Boolean(printer.header_image_url))
  const [headerUrl, setHeaderUrl] = useState(printer.header_image_url ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Switching printer tabs reuses this component, so follow the printer.
  useEffect(() => {
    setHeader(printer.badge_header ?? 'WELCOME')
    setSubtitle(printer.badge_subtitle ?? '')
    setUseGraphic(Boolean(printer.header_image_url))
    setHeaderUrl(printer.header_image_url ?? '')
    setMsg(null)
  }, [printer])

  const dirty =
    header !== (printer.badge_header ?? 'WELCOME') ||
    subtitle !== (printer.badge_subtitle ?? '')

  async function saveText() {
    setBusy(true)
    setMsg(null)
    const { error } = await supabase
      .from('printers')
      .update({ badge_header: header, badge_subtitle: subtitle })
      .eq('id', printer.id)
    setBusy(false)
    setMsg(error ? `Error: ${error.message}` : 'Saved.')
    if (!error) onChanged()
  }

  async function pickGraphic(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (fileRef.current) fileRef.current.value = '' // let the same file be re-picked
    if (!file) return
    setMsg(null)
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      setMsg('Please choose a PNG or JPEG image.')
      return
    }
    if (file.size > MAX_HEADER_BYTES) {
      setMsg('That image is too large (2 MB maximum).')
      return
    }
    setBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const ext = file.type === 'image/png' ? 'png' : 'jpg'
      const path = `${await hashBytes(buf)}.${ext}`
      const up = await supabase.storage
        .from(HEADER_BUCKET)
        .upload(path, buf, { contentType: file.type, upsert: true })
      if (up.error) throw up.error
      const url = supabase.storage.from(HEADER_BUCKET).getPublicUrl(path).data.publicUrl
      const { error } = await supabase
        .from('printers')
        .update({ header_image_url: url })
        .eq('id', printer.id)
      if (error) throw error
      setHeaderUrl(url)
      setUseGraphic(true)
      setMsg('Graphic updated.')
      onChanged()
    } catch (err) {
      setMsg(`Upload failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function useTextHeader() {
    setBusy(true)
    setMsg(null)
    // The stored object stays: it is content-addressed and may be shared with
    // another printer. Detaching is enough.
    const { error } = await supabase
      .from('printers')
      .update({ header_image_url: null })
      .eq('id', printer.id)
    setBusy(false)
    if (error) {
      setMsg(`Error: ${error.message}`)
      return
    }
    setHeaderUrl('')
    setUseGraphic(false)
    onChanged()
  }

  const graphic = headerUrl || defaultHeader

  return (
    <div className="badge-design">
      <div>
        <div className="badge-preview" aria-label="Badge preview">
          <div className="badge-preview-header">
            {useGraphic ? (
              <img src={graphic} alt="" />
            ) : (
              <span>{header || ' '}</span>
            )}
          </div>
          <div className="badge-preview-name">
            <strong>Rivka</strong>
            <span>Bernstein</span>
          </div>
          <div className="badge-preview-footer">{subtitle || ' '}</div>
        </div>
        <p className="muted small">A guide to the proportions, not an exact proof.</p>
      </div>

      <div className="badge-controls">
        <div className="field-row">
          <span className="field-label">Header</span>
          <label className="check">
            <input
              type="radio"
              checked={!useGraphic}
              onChange={() => void useTextHeader()}
              disabled={busy}
            />
            Text
          </label>
          <input
            className="grow"
            value={header}
            onChange={(e) => setHeader(e.target.value)}
            disabled={useGraphic}
            placeholder="WELCOME"
          />
        </div>

        <div className="field-row">
          <span className="field-label" />
          <label className="check">
            <input
              type="radio"
              checked={useGraphic}
              onChange={() => fileRef.current?.click()}
              disabled={busy}
            />
            Graphic
          </label>
          <button
            className="secondary btn-sm"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            {headerUrl ? 'Replace image…' : 'Upload an image…'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            hidden
            onChange={pickGraphic}
          />
        </div>

        <div className="field-row">
          <span className="field-label">Footer</span>
          <input
            className="grow"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder="(nothing)"
          />
        </div>

        <div className="field-row">
          <span className="field-label" />
          <button onClick={() => void saveText()} disabled={busy || !dirty}>
            {busy ? 'Saving…' : dirty ? 'Save badge text' : 'Saved'}
          </button>
          {msg && <span className="muted small">{msg}</span>}
        </div>
      </div>
    </div>
  )
}
