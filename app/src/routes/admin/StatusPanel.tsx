import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { PrinterStatusRow, PrintJob } from '../../lib/types'

// The bridge heartbeats every ~15s; treat it as online if seen within 45s.
const BRIDGE_FRESH_MS = 45000

export default function StatusPanel() {
  const [status, setStatus] = useState<PrinterStatusRow | null>(null)
  const [jobs, setJobs] = useState<PrintJob[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [, setTick] = useState(0) // forces re-render so freshness recomputes

  const loadStatus = useCallback(async () => {
    const { data } = await supabase.from('printer_status').select('*').eq('id', 1).single()
    if (data) setStatus(data as PrinterStatusRow)
  }, [])

  const loadJobs = useCallback(async () => {
    const { data } = await supabase
      .from('print_jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10)
    setJobs((data ?? []) as PrintJob[])
  }, [])

  useEffect(() => {
    void loadStatus()
    void loadJobs()
    const channel = supabase
      .channel('status-panel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'printer_status' }, () =>
        loadStatus(),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'print_jobs' }, () => loadJobs())
      .subscribe()
    const timer = window.setInterval(() => setTick((n) => n + 1), 5000)
    return () => {
      void supabase.removeChannel(channel)
      window.clearInterval(timer)
    }
  }, [loadStatus, loadJobs])

  async function testPrint() {
    setTesting(true)
    setNotice(null)
    const { error } = await supabase.from('print_jobs').insert({ type: 'test', status: 'queued' })
    setTesting(false)
    setNotice(error ? `Could not queue test print: ${error.message}` : 'Test print queued.')
    void loadJobs()
  }

  const lastSeen = status?.bridge_last_seen ? new Date(status.bridge_last_seen).getTime() : null
  const bridgeOnline = lastSeen !== null && Date.now() - lastSeen < BRIDGE_FRESH_MS
  const reachable = status?.printer_reachable

  return (
    <>
      <h1>Status</h1>
      {notice && <div className="notice">{notice}</div>}

      <div className="status-cards">
        <div className={`status-card ${bridgeOnline ? 'ok' : 'bad'}`}>
          <div className="status-label">Bridge</div>
          <div className="status-value">
            {bridgeOnline ? 'Online' : lastSeen ? 'Offline' : 'Never connected'}
          </div>
          <div className="muted small">
            {lastSeen ? `Last seen ${new Date(lastSeen).toLocaleTimeString()}` : 'Waiting for the print bridge'}
          </div>
        </div>

        <div className={`status-card ${!bridgeOnline ? '' : reachable ? 'ok' : 'bad'}`}>
          <div className="status-label">Printer</div>
          <div className="status-value">
            {!bridgeOnline ? 'Unknown' : reachable ? 'Reachable' : 'Not reachable'}
          </div>
          <div className="muted small">
            {status?.media_type
              ? `Media: ${status.media_type}${status.media_width ? ` (${status.media_width})` : ''}`
              : 'No media info yet'}
          </div>
        </div>
      </div>

      {status?.error_state && <div className="error">Printer error: {status.error_state}</div>}

      <div className="toolbar" style={{ marginTop: 20 }}>
        <button onClick={testPrint} disabled={testing}>
          {testing ? 'Queuing…' : 'Send test print'}
        </button>
        <span className="muted small">Queues a test badge for the bridge to print.</span>
      </div>

      <h2 style={{ marginTop: 8 }}>Recent print jobs</h2>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Type</th>
              <th>Status</th>
              <th>Created</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty">
                  No print jobs yet.
                </td>
              </tr>
            ) : (
              jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.type}</td>
                  <td>
                    <span className={`pill pill-${j.status}`}>{j.status}</span>
                  </td>
                  <td>{new Date(j.created_at).toLocaleString()}</td>
                  <td>{j.error ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
