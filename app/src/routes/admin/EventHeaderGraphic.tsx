import { useRef, useState } from 'react'
import { HEADER_IMAGE_GUIDANCE, headerImageProblem, uploadHeaderImage } from '../../lib/headerImage'

/**
 * A custom badge header graphic for one event.
 *
 * Badges printed for sign-ins that came through this event's QR codes use this
 * graphic at the top, overriding whatever header the printer or organization
 * would otherwise use — so an event can brand its own badges without changing
 * every printer. The URL is stored on the event integration's `config`
 * (`header_image_url`) and surfaced onto each print job by bridge-poll; an empty
 * value means the badge falls back to the printer's normal header.
 *
 * Same bytes, bucket and rules as the organization name mark and a printer's
 * graphic — this reuses `headerImage.ts`, mirroring OrgLogo's upload/remove.
 */
export default function EventHeaderGraphic({
  config,
  onConfig,
}: {
  config: Record<string, unknown>
  onConfig: (key: string, value: unknown) => void
}) {
  const current = typeof config.header_image_url === 'string' ? config.header_image_url : null
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function upload(file: File) {
    setMsg(null)
    setError(null)
    const problem = headerImageProblem(file)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    try {
      const url = await uploadHeaderImage(file)
      onConfig('header_image_url', url)
      setMsg('Event badge header updated.')
    } catch (err) {
      setError(`Upload failed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  function remove() {
    if (
      !window.confirm(
        'Remove this event’s badge header? Its badges will use the printer’s normal header instead.',
      )
    ) {
      return
    }
    // The stored object is content-addressed and may be shared; clearing the
    // reference is what turns the event header off.
    onConfig('header_image_url', null)
    setMsg('Event badge header removed.')
    setError(null)
  }

  return (
    <div className="event-header-graphic" style={{ marginTop: 16 }}>
      <div className="field-row-label" style={{ marginBottom: 6 }}>
        Badge header graphic
        <span className="muted small"> · optional</span>
      </div>

      {msg && <div className="notice">{msg}</div>}
      {error && <div className="error">{error}</div>}

      <div className="org-logo">
        <div className="org-logo-preview" aria-label="Event badge header preview">
          {current ? (
            <img src={current} alt="This event’s badge header graphic" />
          ) : (
            <span className="muted small">None uploaded</span>
          )}
        </div>

        <div className="org-logo-actions">
          <button className="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? 'Uploading…' : current ? 'Replace…' : 'Upload…'}
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
          {current && (
            <button className="secondary btn-sm" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
          <p className="muted small">
            Printed at the top of every badge created through this event, in place of the printer’s
            usual header. {HEADER_IMAGE_GUIDANCE}
          </p>
        </div>
      </div>
    </div>
  )
}
