import { useEffect, useRef, useState } from 'react'
import logoUrl from '../../assets/shir-hadash-logo.png'

export default function QrCode() {
  const [url, setUrl] = useState(`${window.location.origin}/`)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // qrcode is lazy-loaded so it stays out of the public form bundle.
        const QRCode = (await import('qrcode')).default
        const canvas = canvasRef.current
        if (!canvas || cancelled) return
        // High error correction ('H', ~30%) so the centered logo doesn't break scanning.
        await QRCode.toCanvas(canvas, url || ' ', {
          width: 600,
          margin: 2,
          errorCorrectionLevel: 'H',
        })
        if (!cancelled) await drawLogo(canvas)
      } catch (e) {
        setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url])

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
    // White backing box so the logo reads cleanly over the QR modules.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x - pad, y - pad, logoW + pad * 2, logoH + pad * 2)
    ctx.drawImage(img, x, y, logoW, logoH)
  }

  function download() {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = 'name-badge-qr.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  return (
    <>
      <h1>QR Code</h1>
      <p className="muted">
        Print this and post it by the printer. Scanning it opens the badge form.
      </p>

      <label className="field" style={{ maxWidth: 480 }}>
        Form URL
        <input value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>

      {error && <div className="error">{error}</div>}

      <div className="qr-box">
        <canvas ref={canvasRef} style={{ width: 280, height: 280, maxWidth: '100%' }} />
      </div>

      <div className="toolbar">
        <button onClick={download}>Download PNG</button>
      </div>
    </>
  )
}
