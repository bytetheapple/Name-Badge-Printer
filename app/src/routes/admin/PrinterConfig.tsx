import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import type { PrinterConfigRow } from '../../lib/types'

export default function PrinterConfig() {
  const [template, setTemplate] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [ip, setIp] = useState('')
  const [port, setPort] = useState(9100)
  const [labelMedia, setLabelMedia] = useState('62')
  const [header, setHeader] = useState('')
  const [subtitle, setSubtitle] = useState('')

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase.from('printer_config').select('*').eq('id', 1).single()
      if (error) {
        setError(error.message)
        setLoading(false)
        return
      }
      const c = data as PrinterConfigRow
      const t = c.badge_template ?? {}
      setTemplate(t)
      setIp(c.printer_ip ?? '')
      setPort(c.port)
      setLabelMedia(c.label_media)
      setHeader((t.header as string) ?? 'WELCOME')
      setSubtitle((t.subtitle as string) ?? 'Shir Hadash')
      setLoading(false)
    })()
  }, [])

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setNotice(null)
    setError(null)
    const badge_template = { ...template, header, subtitle }
    const { error } = await supabase
      .from('printer_config')
      .update({ printer_ip: ip.trim() || null, port, label_media: labelMedia, badge_template })
      .eq('id', 1)
    setSaving(false)
    if (error) setError(error.message)
    else setNotice('Saved. The bridge will pick up changes within a few seconds.')
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <>
      <h1>Printer</h1>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <form onSubmit={save} className="config-form">
        <section className="card">
          <h2>Connection</h2>
          <div className="grid2">
            <label className="field">
              Printer IP address
              <input
                type="text"
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="192.168.1.50"
                inputMode="decimal"
              />
            </label>
            <label className="field">
              Port
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                min={1}
                max={65535}
              />
            </label>
            <label className="field">
              Label media
              <select value={labelMedia} onChange={(e) => setLabelMedia(e.target.value)}>
                <option value="62">62mm continuous</option>
                <option value="29">29mm continuous</option>
                <option value="62x100">62mm × 100mm die-cut</option>
                <option value="62x29">62mm × 29mm die-cut</option>
              </select>
            </label>
          </div>
        </section>

        <section className="card">
          <h2>Badge text</h2>
          <div className="grid2">
            <label className="field">
              Header (top line)
              <input type="text" value={header} onChange={(e) => setHeader(e.target.value)} maxLength={24} />
            </label>
            <label className="field">
              Subtitle (bottom line)
              <input type="text" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} maxLength={40} />
            </label>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            The name itself comes from each submission. Header and subtitle are the same on every badge.
          </p>
        </section>

        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </>
  )
}
