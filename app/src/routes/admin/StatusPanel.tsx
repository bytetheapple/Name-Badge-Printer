import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import type { Printer, PrinterStatusRow, PrintJob } from '../../lib/types'

// The bridge heartbeats every ~15s; treat it as online if seen within 45s.
const BRIDGE_FRESH_MS = 45000

export default function StatusPanel() {
  const { orgId } = useOrg()
  const [bridge, setBridge] = useState<PrinterStatusRow | null>(null)
  const [printers, setPrinters] = useState<Printer[]>([])
  const [jobs, setJobs] = useState<PrintJob[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [, setTick] = useState(0)

  const loadBridge = useCallback(async () => {
    if (!orgId) return
    const { data } = await supabase
      .from('printer_status')
      .select('*')
      .eq('org_id', orgId)
      .maybeSingle()
    setBridge((data as PrinterStatusRow) ?? null)
  }, [orgId])
  const loadPrinters = useCallback(async () => {
    if (!orgId) return
    const { data } = await supabase
      .from('printers')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at')
    setPrinters((data ?? []) as Printer[])
  }, [orgId])
  const loadJobs = useCallback(async () => {
    if (!orgId) return
    const { data } = await supabase
      .from('print_jobs')
      .select('*, printer:printers(name)')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(10)
    setJobs((data ?? []) as PrintJob[])
  }, [orgId])

  useEffect(() => {
    void loadBridge()
    void loadPrinters()
    void loadJobs()
    const channel = supabase
      .channel('status-panel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'printer_status' }, () =>
        loadBridge(),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'printers' }, () =>
        loadPrinters(),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'print_jobs' }, () => loadJobs())
      .subscribe()
    const timer = window.setInterval(() => setTick((n) => n + 1), 5000)
    return () => {
      void supabase.removeChannel(channel)
      window.clearInterval(timer)
    }
  }, [loadBridge, loadPrinters, loadJobs])

  async function testPrint(printerId: string) {
    setTesting(printerId)
    setNotice(null)
    const { error } = await supabase
      .from('print_jobs')
      .insert({ org_id: orgId, type: 'test', status: 'queued', printer_id: printerId })
    setTesting(null)
    setNotice(error ? `Could not queue test print: ${error.message}` : 'Test print queued.')
    void loadJobs()
  }

  const lastSeen = bridge?.bridge_last_seen ? new Date(bridge.bridge_last_seen).getTime() : null
  const bridgeOnline = lastSeen !== null && Date.now() - lastSeen < BRIDGE_FRESH_MS

  return (
    <>
      <h1>Status</h1>
      {notice && <div className="notice">{notice}</div>}

      <div
        className={`status-card ${bridgeOnline ? 'ok' : 'bad'}`}
        style={{ marginBottom: 20, maxWidth: 400 }}
      >
        <div className="status-label">Bridge</div>
        <div className="status-value">
          {bridgeOnline ? 'Online' : lastSeen ? 'Offline' : 'Never connected'}
        </div>
        <div className="muted small">
          {lastSeen ? `Last seen ${new Date(lastSeen).toLocaleTimeString()}` : 'Waiting for the print bridge'}
        </div>
      </div>

      <h2>Printers</h2>
      {printers.length === 0 ? (
        <p className="muted">No printers configured. Add one on the Printer tab.</p>
      ) : (
        <div className="status-cards" style={{ gridTemplateColumns: '1fr' }}>
          {printers.map((p) => {
            const reachable = bridgeOnline ? p.reachable : null
            return (
              <div
                key={p.id}
                className={`status-card ${reachable == null ? '' : reachable ? 'ok' : 'bad'}`}
              >
                <div className="printer-row">
                  <div>
                    <div className="status-value" style={{ fontSize: 18 }}>
                      {p.name}
                      {p.location ? ` · ${p.location}` : ''}
                    </div>
                    <div className="muted small">
                      {reachable == null
                        ? 'Status unknown (bridge offline)'
                        : reachable
                          ? 'Reachable'
                          : 'Not reachable'}
                      {p.media_type ? ` · ${p.media_type}${p.media_width ? ` (${p.media_width})` : ''}` : ''}
                      {p.printer_ip ? ` · ${p.printer_ip}:${p.port}` : ' · no IP set'}
                    </div>
                    {p.error_state && (
                      <div className="small" style={{ color: 'var(--err-text)' }}>
                        Error: {p.error_state}
                      </div>
                    )}
                  </div>
                  <button
                    className="btn-sm"
                    onClick={() => testPrint(p.id)}
                    disabled={testing === p.id}
                  >
                    {testing === p.id ? 'Queuing…' : 'Test print'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <h2 style={{ marginTop: 20 }}>Recent print jobs</h2>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Type</th>
              <th>Printer</th>
              <th>Status</th>
              <th>Created</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty">
                  No print jobs yet.
                </td>
              </tr>
            ) : (
              jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.type}</td>
                  <td>{j.printer?.name ?? '—'}</td>
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
