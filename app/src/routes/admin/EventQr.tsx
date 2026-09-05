import { useEffect, useRef, type ReactNode } from 'react'
import { eventUrl } from '../../lib/publicUrl'

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'code'

/**
 * One event code, as an image and as something to put on a desk.
 *
 * Deliberately not PrinterQr. That one makes a lobby poster: the
 * organization's mark in the middle of the code, "Welcome to" above it, one
 * per printer for a room people wander into. An event sign has a different
 * job — it stands on a desk in a row of desks, and what matters is which desk
 * it is, so the printer's name is on it and the event's name is the heading.
 *
 * The code encodes an opaque token. Scanning it opens the registration form
 * already routed to this printer, and the token can be reissued without
 * touching the event, which is what makes a photographed code recoverable.
 */
export default function EventQr({
  token,
  eventName,
  printerName,
  actions,
}: {
  token: string
  eventName: string
  printerName: string
  /** Anything else this code can be done to. Rendered beside the image with
   *  Print, because they all act on the same thing and a row of buttons
   *  somewhere below it reads as acting on the printer instead. */
  actions?: ReactNode
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const url = eventUrl(token)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const canvas = canvasRef.current
      if (!canvas) return
      // Lazy-loaded: the QR library is only needed where a code is shown.
      const QRCode = (await import('qrcode')).default
      if (cancelled) return
      await QRCode.toCanvas(canvas, url, { width: 480, margin: 2, errorCorrectionLevel: 'H' })
      // Only the CSS size, never the width or height attributes: assigning to
      // either of those resets a canvas to blank, which is what the first
      // version of this did immediately after drawing the code. The 480px
      // bitmap stays as it is, and that is what the printed sign uses.
      canvas.style.width = '160px'
      canvas.style.height = '160px'
    })()
    return () => {
      cancelled = true
    }
  }, [url])

  async function printSign() {
    const canvas = canvasRef.current
    if (!canvas) return
    const { jsPDF } = await import('jspdf') // lazy-loaded, it is a large dependency

    const doc = new jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait' })
    const pageW = 8.5
    const boxW = 5
    const boxH = 6.5
    const boxX = (pageW - boxW) / 2
    const boxY = (11 - boxH) / 2
    const cx = pageW / 2

    doc.setLineWidth(0.03)
    doc.rect(boxX, boxY, boxW, boxH)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(24)
    doc.text(doc.splitTextToSize(eventName, boxW - 0.8), cx, boxY + 0.75, { align: 'center' })

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(16)
    doc.text('Registration', cx, boxY + 1.2, { align: 'center' })

    const qrSize = 3.2
    doc.addImage(
      canvas.toDataURL('image/png'),
      'PNG',
      (pageW - qrSize) / 2,
      boxY + 1.6,
      qrSize,
      qrSize,
    )

    doc.setFontSize(15)
    doc.text('Scan to register and print your badge', cx, boxY + boxH - 0.85, {
      align: 'center',
    })
    // Which desk this sign belongs to. Small, and at the bottom: it is for
    // whoever is setting the room up, not for the person scanning it.
    doc.setFontSize(10)
    doc.setTextColor(120)
    doc.text(printerName, cx, boxY + boxH - 0.35, { align: 'center' })

    doc.save(`event-code-${slugify(eventName)}-${slugify(printerName)}.pdf`)
  }

  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginTop: 8 }}>
      <canvas ref={canvasRef} style={{ width: 160, height: 160 }} />
      <div>
        <div className="muted small" style={{ wordBreak: 'break-all', marginBottom: 8 }}>
          {url}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="secondary btn-sm" onClick={() => void printSign()}>
            Print this code
          </button>
          {actions}
        </div>
      </div>
    </div>
  )
}
