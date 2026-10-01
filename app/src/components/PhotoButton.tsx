import { useRef, useState } from 'react'

/**
 * One photo, taken with the device's own camera.
 *
 * A file input with `capture` opens the native camera app, the person takes the
 * shot and confirms, and it comes back here — the flow people already know, and
 * with no live-video permission dance or custom shutter to misread. The image is
 * scaled down and re-encoded to JPEG before it leaves the page, so a 12-megapixel
 * phone photo does not become a multi-megabyte upload.
 */
export function PhotoButton({
  label,
  retakeLabel,
  capture,
  value,
  onCapture,
  required,
  altText = 'Captured photo',
}: {
  label: string
  retakeLabel: string
  /** 'user' is the front camera (selfie), 'environment' the back (a document). */
  capture: 'user' | 'environment'
  value: string | undefined
  onCapture: (dataUrl: string) => void
  required?: boolean
  altText?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Clear the value so choosing the same file again still fires onChange.
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      onCapture(await toJpeg(file))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="photo-button">
      <div className="photo-button-head">
        <span className="photo-button-label">{label}</span>
        <span className={`photo-button-tag${value ? ' done' : ''}`}>
          {value ? '✓ Taken' : required ? 'Required' : 'Optional'}
        </span>
      </div>

      {value && (
        <div className="selfie-frame">
          <img src={value} alt={altText} />
        </div>
      )}

      <button type="button" className={value ? 'secondary' : ''} disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? 'Working…' : value ? retakeLabel : label}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture={capture}
        hidden
        onChange={(e) => void onFile(e)}
      />
    </div>
  )
}

/** Load, scale to fit `maxDim`, and re-encode as JPEG. Falls back to the raw
 *  data URL if anything about the canvas path fails. */
async function toJpeg(file: File, maxDim = 1600, quality = 0.85): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = reject
      i.src = url
    })
    const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1
    const scale = Math.min(1, maxDim / longest)
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    // Last resort: hand back the original bytes as a data URL.
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
