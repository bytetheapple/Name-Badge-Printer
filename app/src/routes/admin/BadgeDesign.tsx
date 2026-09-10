import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { HEADER_IMAGE_GUIDANCE, headerImageProblem, uploadHeaderImage } from '../../lib/headerImage'
import { useOrg } from '../../lib/org'
import type { Printer } from '../../lib/types'


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
  const [mode, setMode] = useState<'text' | 'logo' | 'image'>(printer.badge_header_mode ?? 'text')
  const [headerUrl, setHeaderUrl] = useState(printer.header_image_url ?? '')
  //: The organization's own mark. Null means none is uploaded yet; the option
  //: is still offered, and choosing it asks for the file.
  const [orgLogo, setOrgLogo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  //: For the name mark. Choosing that option with none uploaded opens this,
  //: exactly as choosing the printer graphic with none uploaded opens the
  //: other — the two options behave the same way, which they did not before.
  const logoRef = useRef<HTMLInputElement>(null)
  const { orgId } = useOrg()

  // The organization's mark, for the preview and to decide whether the logo
  // option exists. Read here rather than passed down: it belongs to the org,
  // not to the printer this component is editing.
  useEffect(() => {
    if (!orgId) return
    void supabase
      .from('app_settings')
      .select('logo_url')
      .eq('org_id', orgId)
      .maybeSingle()
      .then(({ data }) => setOrgLogo((data?.logo_url as string | null) ?? null))
  }, [orgId])

  // Switching printer tabs reuses this component, so follow the printer.
  useEffect(() => {
    setHeader(printer.badge_header ?? 'WELCOME')
    setSubtitle(printer.badge_subtitle ?? '')
    setMode(printer.badge_header_mode ?? 'text')
    setHeaderUrl(printer.header_image_url ?? '')
    setMsg(null)
  }, [printer])

  /**
   * Upload the organization's name mark from here, then use it.
   *
   * The same thing Settings does, reachable from the place somebody is
   * actually deciding about it. It belongs to the organization, so every
   * printer that chooses the name mark prints this one.
   */
  async function pickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (logoRef.current) logoRef.current.value = ''
    if (!file || !orgId) return
    setMsg(null)
    const problem = headerImageProblem(file)
    if (problem) {
      setMsg(problem)
      return
    }
    setBusy(true)
    try {
      const url = await uploadHeaderImage(file)
      const { error } = await supabase
        .from('app_settings')
        .update({ logo_url: url })
        .eq('org_id', orgId)
      if (error) throw error
      setOrgLogo(url)
      setBusy(false)
      await chooseMode('logo')
      setMsg('Name mark uploaded and in use on this printer.')
    } catch (err) {
      setBusy(false)
      setMsg(`Upload failed: ${(err as Error).message}`)
    }
  }

  /** Switch which of the three headers this printer prints. */
  async function chooseMode(next: 'text' | 'logo' | 'image') {
    setMode(next)
    setBusy(true)
    setMsg(null)
    const { error } = await supabase
      .from('printers')
      .update({ badge_header_mode: next })
      .eq('id', printer.id)
    setBusy(false)
    if (error) setMsg(`Error: ${error.message}`)
    else onChanged()
  }

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
    const problem = headerImageProblem(file)
    if (problem) {
      setMsg(problem)
      return
    }
    setBusy(true)
    try {
      const url = await uploadHeaderImage(file)
      const { error } = await supabase
        .from('printers')
        .update({ header_image_url: url })
        .eq('id', printer.id)
      if (error) throw error
      await supabase
        .from('printers')
        .update({ badge_header_mode: 'image' })
        .eq('id', printer.id)
      setHeaderUrl(url)
      setMode('image')
      setMsg('Graphic updated.')
      onChanged()
    } catch (err) {
      setMsg(`Upload failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // In image mode show the upload; in logo mode the organization's own mark.
  const shown = mode === 'image' && headerUrl ? headerUrl : orgLogo

  return (
    <div className="badge-design">
      <div>
        <div className="badge-preview" aria-label="Badge preview">
          <div className="badge-preview-header">
            {mode !== 'text' && shown ? (
              <img src={shown} alt="" />
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
              checked={mode === 'text'}
              onChange={() => void chooseMode('text')}
              disabled={busy}
            />
            Text
          </label>
          <input
            className="grow"
            value={header}
            onChange={(e) => setHeader(e.target.value)}
            disabled={mode !== 'text'}
            placeholder="WELCOME"
          />
        </div>

        {/* Always offered. It used to vanish when no mark was uploaded and a
            note took its place — which read as a caption for the option below
            it, not as a choice that was missing. Choosing it with no mark asks
            for the file, the way the printer graphic does. */}
        <div className="field-row">
          <span className="field-label" />
          <label className="check">
            <input
              type="radio"
              checked={mode === 'logo'}
              onChange={() => (orgLogo ? void chooseMode('logo') : logoRef.current?.click())}
              disabled={busy}
            />
            Organization name mark
          </label>
          {orgLogo ? (
            <span className="muted small">Shared by every printer that chooses it.</span>
          ) : (
            <button
              className="secondary btn-sm"
              onClick={() => logoRef.current?.click()}
              disabled={busy}
            >
              Upload
            </button>
          )}
          <input
            ref={logoRef}
            type="file"
            accept="image/png,image/jpeg"
            style={{ display: 'none' }}
            onChange={(e) => void pickLogo(e)}
          />
        </div>

        <div className="field-row">
          <span className="field-label" />
          <label className="check">
            <input
              type="radio"
              checked={mode === 'image'}
              onChange={() => (headerUrl ? void chooseMode('image') : fileRef.current?.click())}
              disabled={busy}
            />
            Special image for this printer only
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
        {/* What the file should be. Applies to both images above -- they are
            the same bytes in the same bucket printed the same way -- and it is
            here rather than in an error message because the error arrives
            after somebody has already made the wrong file. */}
        <div className="field-row">
          <span className="field-label" />
          <span className="muted small">{HEADER_IMAGE_GUIDANCE}</span>
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
