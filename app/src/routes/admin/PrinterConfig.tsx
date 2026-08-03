import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import type { Printer, PrinterConfigRow } from '../../lib/types'

function PrinterCard({
  printer,
  canDelete,
  onChanged,
}: {
  printer: Printer
  canDelete: boolean
  onChanged: () => void
}) {
  const [name, setName] = useState(printer.name)
  const [location, setLocation] = useState(printer.location ?? '')
  const [ip, setIp] = useState(printer.printer_ip ?? '')
  const [port, setPort] = useState(printer.port)
  const [saved, setSaved] = useState({
    name: printer.name,
    location: printer.location ?? '',
    ip: printer.printer_ip ?? '',
    port: printer.port,
  })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const dirty =
    name !== saved.name || location !== saved.location || ip !== saved.ip || port !== saved.port

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMsg(null)
    const next = { name: name.trim() || 'Unnamed', location: location.trim(), ip: ip.trim(), port }
    const { error } = await supabase
      .from('printers')
      .update({
        name: next.name,
        location: next.location || null,
        printer_ip: next.ip || null,
        port: next.port,
      })
      .eq('id', printer.id)
    setSaving(false)
    if (error) {
      setMsg(`Error: ${error.message}`)
      return
    }
    // Normalize the visible values and mark the card clean (hides Save).
    setName(next.name)
    setLocation(next.location)
    setIp(next.ip)
    setSaved(next)
    onChanged()
  }

  async function remove() {
    if (!window.confirm(`Delete printer "${printer.name}"?`)) return
    setDeleting(true)
    const { error } = await supabase.from('printers').delete().eq('id', printer.id)
    setDeleting(false)
    if (error) setMsg(`Error: ${error.message}`)
    else onChanged()
  }

  return (
    <form className="card" onSubmit={save}>
      {canDelete && (
        <div className="printer-card-head">
          <button type="button" className="secondary btn-sm" onClick={remove} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      )}
      <div className="grid2">
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          Location
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Lobby"
          />
        </label>
        <label className="field">
          IP address
          <input
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
      </div>
      {(msg || dirty) && (
        <div className="printer-card-foot">
          {msg && <span className="error">{msg}</span>}
          {dirty && (
            <button type="submit" className="btn-sm" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      )}
    </form>
  )
}

export default function PrinterConfig() {
  const [printers, setPrinters] = useState<Printer[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)

  const [template, setTemplate] = useState<Record<string, unknown>>({})
  const [labelMedia, setLabelMedia] = useState('62')
  const [header, setHeader] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [printRotation, setPrintRotation] = useState(90)
  const [lengthMm, setLengthMm] = useState(90)
  const [savingCfg, setSavingCfg] = useState(false)
  const [cfgMsg, setCfgMsg] = useState<string | null>(null)

  const loadPrinters = useCallback(async () => {
    const { data } = await supabase.from('printers').select('*').order('created_at')
    setPrinters((data ?? []) as Printer[])
  }, [])

  useEffect(() => {
    void (async () => {
      await loadPrinters()
      const { data } = await supabase.from('printer_config').select('*').eq('id', 1).single()
      if (data) {
        const c = data as PrinterConfigRow
        const t = c.badge_template ?? {}
        setTemplate(t)
        setLabelMedia(c.label_media)
        setHeader((t.header as string) ?? 'WELCOME')
        setSubtitle((t.subtitle as string) ?? 'Shir Hadash')
        setPrintRotation(Number(t.print_rotation ?? 90))
        setLengthMm(Number(t.length_mm ?? 90))
      }
      setLoading(false)
    })()
  }, [loadPrinters])

  async function addPrinter() {
    setAdding(true)
    await supabase.from('printers').insert({ name: 'New Printer', port: 9100 })
    setAdding(false)
    await loadPrinters()
  }

  async function saveConfig(e: FormEvent) {
    e.preventDefault()
    setSavingCfg(true)
    setCfgMsg(null)
    const badge_template = {
      ...template,
      header,
      subtitle,
      print_rotation: printRotation,
      length_mm: lengthMm,
    }
    const { error } = await supabase
      .from('printer_config')
      .update({ label_media: labelMedia, badge_template })
      .eq('id', 1)
    setSavingCfg(false)
    setCfgMsg(error ? error.message : 'Saved. The bridge picks up changes within a few seconds.')
  }

  if (loading) return <p className="muted">Loading…</p>

  return (
    <>
      <h1>Printer</h1>

      <div className="section-head">
        <h2>Printers</h2>
        <button className="btn-sm" onClick={addPrinter} disabled={adding}>
          {adding ? 'Adding…' : '+ Add printer'}
        </button>
      </div>
      {printers.length === 0 && <p className="muted">No printers yet. Add one to start.</p>}
      <div className="config-form">
        {printers.map((p) => (
          <PrinterCard
            key={p.id}
            printer={p}
            canDelete={printers.length > 1}
            onChanged={loadPrinters}
          />
        ))}
      </div>

      <form onSubmit={saveConfig} className="config-form" style={{ marginTop: 28 }}>
        <div className="section-head">
          <h2>Badge settings (all printers)</h2>
        </div>
        {cfgMsg && <div className="notice">{cfgMsg}</div>}

        <section className="card">
          <h2>Badge text</h2>
          <div className="grid2">
            <label className="field">
              Header (top line)
              <input value={header} onChange={(e) => setHeader(e.target.value)} maxLength={24} />
            </label>
            <label className="field">
              Subtitle (bottom line)
              <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} maxLength={40} />
            </label>
          </div>
        </section>

        <section className="card">
          <h2>Badge layout</h2>
          <div className="grid2">
            <label className="field">
              Label media
              <select value={labelMedia} onChange={(e) => setLabelMedia(e.target.value)}>
                <option value="62">62mm continuous</option>
                <option value="29">29mm continuous</option>
                <option value="62x100">62mm × 100mm die-cut</option>
                <option value="62x29">62mm × 29mm die-cut</option>
              </select>
            </label>
            <label className="field">
              Print orientation
              <select
                value={printRotation}
                onChange={(e) => setPrintRotation(Number(e.target.value))}
              >
                <option value={90}>Normal (90°)</option>
                <option value={270}>Flipped (270°)</option>
              </select>
            </label>
            <label className="field">
              Badge length (mm)
              <input
                type="number"
                value={lengthMm}
                min={40}
                max={200}
                onChange={(e) => setLengthMm(Number(e.target.value))}
              />
            </label>
          </div>
        </section>

        <button type="submit" disabled={savingCfg}>
          {savingCfg ? 'Saving…' : 'Save badge settings'}
        </button>
      </form>
    </>
  )
}
