import { useEffect, useRef, useState } from 'react'

export default function QrCode() {
  const [url, setUrl] = useState(`${window.location.origin}/`)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // Lazy-loaded so qrcode stays out of the public form bundle.
        const QRCode = (await import('qrcode')).default
        if (canvasRef.current && !cancelled) {
          await QRCode.toCanvas(canvasRef.current, url || ' ', { width: 320, margin: 2 })
        }
      } catch (e) {
        setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url])

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
        <canvas ref={canvasRef} />
      </div>

      <div className="toolbar">
        <button onClick={download}>Download PNG</button>
      </div>
    </>
  )
}
