import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { Printer } from '../../lib/types'
import logoUrl from '../../assets/shir-hadash-logo.png'

export default function QrCode() {
  const [printers, setPrinters] = useState<Printer[]>([])
  const [selected, setSelected] = useState('')
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase.from('printers').select('*').order('created_at')
      if (error) {
        setError(error.message)
        return
      }
      const list = (data ?? []) as Printer[]
      setPrinters(list)
      if (list.length) setSelected(list[0].id)
    })()
  }, [])

  const url = selected
    ? `${window.location.origin}/?printer=${selected}`
    : `${window.location.origin}/`

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const QRCode = (await import('qrcode')).default
        const canvas = canvasRef.current
        if (!canvas || cancelled) return
        await QRCode.toCanvas(canvas, url, { width: 600, margin: 2, errorCorrectionLevel: 'H' })
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
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x - pad, y - pad, logoW + pad * 2, logoH + pad * 2)
    ctx.drawImage(img, x, y, logoW, logoH)
  }

  function download() {
    const canvas = canvasRef.current
    if (!canvas) return
    const printer = printers.find((p) => p.id === selected)
    const slug = (printer?.name ?? 'qr').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const link = document.createElement('a')
    link.download = `name-badge-qr-${slug}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  return (
    <>
      <h1>QR Code</h1>
      <p className="muted">
        Pick a printer, then print this QR and post it by that printer. Scanning it opens the badge
        form and routes the badge to this printer.
      </p>

      {printers.length === 0 ? (
        <div className="notice">Add a printer on the Printer tab first.</div>
      ) : (
        <label className="field" style={{ maxWidth: 360 }}>
          Printer
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {printers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.location ? ` — ${p.location}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      {error && <div className="error">{error}</div>}

      <div className="qr-box">
        <canvas ref={canvasRef} style={{ width: 280, height: 280, maxWidth: '100%' }} />
      </div>
      <p className="muted small" style={{ wordBreak: 'break-all', maxWidth: 400 }}>
        {url}
      </p>

      <div className="toolbar">
        <button onClick={download} disabled={!selected}>
          Download PNG
        </button>
      </div>
    </>
  )
}
