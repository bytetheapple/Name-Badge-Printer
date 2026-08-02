import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { FormEntry } from '../../lib/types'

export default function EntriesTable() {
  const [rows, setRows] = useState<FormEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [reprinting, setReprinting] = useState<string | null>(null)
  const [resyncing, setResyncing] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    let q = supabase.from('form_entries').select('*').order('created_at', { ascending: false })
    if (from) q = q.gte('created_at', new Date(`${from}T00:00:00`).toISOString())
    if (to) q = q.lte('created_at', new Date(`${to}T23:59:59.999`).toISOString())
    const { data, error } = await q
    if (error) setError(error.message)
    else setRows((data ?? []) as FormEntry[])
    setLoading(false)
  }, [from, to])

  useEffect(() => {
    void load()
  }, [load])

  async function reprint(entry: FormEntry) {
    setReprinting(entry.id)
    setNotice(null)
    const { error } = await supabase
      .from('print_jobs')
      .insert({ entry_id: entry.id, type: 'badge', status: 'queued' })
    setReprinting(null)
    setNotice(error ? `Reprint failed: ${error.message}` : `Queued a reprint for ${entry.first_name}.`)
  }

  async function resync(entry: FormEntry) {
    setResyncing(entry.id)
    setNotice(null)
    const { data, error } = await supabase.functions.invoke('google-sync', {
      body: { entry_id: entry.id },
    })
    setResyncing(null)
    if (error || !data?.ok) {
      setNotice(`Google sync failed: ${data?.error ?? error?.message ?? 'unknown error'}`)
    } else {
      setNotice(`Synced ${entry.first_name} to Google.`)
    }
    void load()
  }

  async function exportXlsx() {
    const XLSX = await import('xlsx') // lazy-loaded: keeps xlsx out of the public form bundle
    const data = rows.map((r) => ({
      'First name': r.first_name,
      'Last name': r.last_name ?? '',
      Phone: r.phone ?? '',
      Email: r.email ?? '',
      Submitted: new Date(r.created_at).toLocaleString(),
      'Google sync': r.google_sync_status,
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Entries')
    XLSX.writeFile(wb, `name-badge-entries-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  return (
    <>
      <h1>Entries</h1>

      <div className="toolbar">
        <label className="field">
          From
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          To
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(from || to) && (
          <button
            className="secondary btn-sm"
            onClick={() => {
              setFrom('')
              setTo('')
            }}
          >
            Clear
          </button>
        )}
        <div className="grow" />
        <button className="btn-sm" onClick={exportXlsx} disabled={rows.length === 0}>
          Export to Excel
        </button>
      </div>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>First</th>
              <th>Last</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Submitted</th>
              <th>Google</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="empty">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty">
                  No entries{from || to ? ' in this date range' : ' yet'}.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.first_name}</td>
                  <td>{r.last_name ?? '—'}</td>
                  <td>{r.phone ?? '—'}</td>
                  <td>{r.email ?? '—'}</td>
                  <td>{new Date(r.created_at).toLocaleString()}</td>
                  <td>
                    <span className={`pill pill-google-${r.google_sync_status}`}>
                      {r.google_sync_status}
                    </span>
                    {r.google_sync_status !== 'sent' && (
                      <button
                        className="secondary btn-sm"
                        style={{ marginLeft: 8 }}
                        onClick={() => resync(r)}
                        disabled={resyncing === r.id}
                      >
                        {resyncing === r.id ? '…' : 'Resync'}
                      </button>
                    )}
                  </td>
                  <td className="actions-cell">
                    <button
                      className="secondary btn-sm"
                      onClick={() => reprint(r)}
                      disabled={reprinting === r.id}
                    >
                      {reprinting === r.id ? 'Queuing…' : 'Reprint'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
        {rows.length} {rows.length === 1 ? 'entry' : 'entries'} shown.
      </p>
    </>
  )
}
