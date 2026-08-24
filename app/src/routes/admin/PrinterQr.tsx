import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { kioskUrl } from '../../lib/publicUrl'
import { newSecret } from '../../lib/secrets'
import type { Printer } from '../../lib/types'
import logoUrl from '../../assets/shir-hadash-logo.png'

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'printer'

/**
 * This printer's lobby QR code, with the two things anyone actually wants: the
 * image, and a label to post beside the printer.
 *
 * The code encodes the printer's opaque kiosk token, so scanning it opens the
 * sign-in form already routed to this printer. Rotating the token invalidates
 * every copy already printed, which is the point of it being rotatable.
 */
export default function PrinterQr({
  printer,
  onChanged,
}: {
  printer: Printer
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const url = kioskUrl(printer.kiosk_token)

  useEffect(() => {
    let cancelled = false
    setNotice(null)
    void (async () => {
      try {
        // Lazy-loaded: the QR library is only needed on this tab.
        const QRCode = (await import('qrcode')).default
        const canvas = canvasRef.current
        if (!canvas || cancelled) return
        await QRCode.toCanvas(canvas, url, { width: 600, margin: 2, errorCorrectionLevel: 'H' })
        if (!cancelled) await drawLogo(canvas)
        // qrcode writes an inline width/height onto the canvas, which beats the
        // stylesheet — so the displayed size has to be handed back to CSS. The
        // bitmap is untouched, and that is what the PNG and the label use.
        canvas.style.width = ''
        canvas.style.height = ''
      } catch (e) {
        setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url])

  /** Centre the mark on the code. Error correction level H tolerates it. */
  async function drawLogo(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = new Image()
    img.src = logoUrl
    await img.decode()
    const size = canvas.width
    const logoW = Math.round(size * 0.28)
    const logoH = Math.round(logoW * (img.naturalHeight / img.naturalWidth))
    const x = (size - logoW) / 2
    const y = (size - logoH) / 2
    const pad = Math.round(size * 0.03)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x - pad, y - pad, logoW + pad * 2, logoH + pad * 2)
    ctx.drawImage(img, x, y, logoW, logoH)
  }

  function downloadPng() {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = `name-badge-qr-${slugify(printer.name)}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  async function printLabel() {
    const canvas = canvasRef.current
    if (!canvas) return
    const { jsPDF } = await import('jspdf') // lazy-loaded, it is a large dependency

    const doc = new jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait' })
    const pageW = 8.5
    const boxW = 3
    const boxH = 4.5
    const boxX = (pageW - boxW) / 2
    const boxY = (11 - boxH) / 2
    const cx = pageW / 2

    doc.setLineWidth(0.03)
    doc.rect(boxX, boxY, boxW, boxH)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(20)
    doc.text('Welcome to', cx, boxY + 0.6, { align: 'center' })
    doc.text('Shir Hadash', cx, boxY + 0.95, { align: 'center' })

    const qrSize = 2.1
    doc.addImage(canvas.toDataURL('image/png'), 'PNG', (pageW - qrSize) / 2, boxY + 1.35, qrSize, qrSize)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(14)
    doc.text(
      doc.splitTextToSize('Scan the QR code to print a Name Tag', boxW - 0.5),
      cx,
      boxY + boxH - 0.55,
      { align: 'center' },
    )
    doc.save(`welcome-label-${slugify(printer.name)}.pdf`)
  }

  /** Invalidate every printed copy of this printer's code. */
  async function rotate() {
    if (
      !window.confirm(
        `Rotate the QR code for "${printer.name}"? Every printed code for this printer stops ` +
          'working immediately and will need reprinting.',
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    const { error } = await supabase
      .from('printers')
      .update({ kiosk_token: newSecret('k_', 16) })
      .eq('id', printer.id)
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    setNotice('New code generated. Reprint and replace the old one.')
    onChanged()
  }

  return (
    <div className="printer-qr">
      <canvas ref={canvasRef} width={600} height={600} className="qr-canvas" />
      <div className="printer-qr-side">
        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
        <div className="printer-qr-actions">
          <button className="secondary btn-sm" onClick={downloadPng}>
            Download PNG
          </button>
          <button className="secondary btn-sm" onClick={() => void printLabel()}>
            Print label
          </button>
        </div>
        <p className="muted small">
          Post this beside the printer. Scanning it opens the sign-in form and sends the badge
          here.
        </p>
        <p className="muted small">
          Tied to a rotatable code, not to the printer itself. If a code is abused or ends up
          somewhere it should not be,{' '}
          <button className="linklike" onClick={() => void rotate()} disabled={busy}>
            {busy ? 'rotating…' : 'rotate it'}
          </button>{' '}
          — every printed copy stops working, so reprint afterwards.
        </p>
      </div>
    </div>
  )
}
