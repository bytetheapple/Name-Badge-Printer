import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import { lastSeenLabel } from '../../lib/secrets'
import type { Printer, PrinterStatusRow, PrintJob } from '../../lib/types'

// The bridge heartbeats every ~15s; treat it as online if seen within 45s.
const BRIDGE_FRESH_MS = 45000

export default function StatusPanel() {
  const { orgId } = useOrg()
  const [bridge, setBridge] = useState<PrinterStatusRow | null>(null)
  const [jobs, setJobs] = useState<PrintJob[]>([])
  //: Readable by staff since the role change, which is the point of putting it
  //: here: "is the printer working" is the question a greeter actually has,
  //: and the Printers tab that used to answer it is an admin's.
  const [printers, setPrinters] = useState<Printer[]>([])
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
      .order('name')
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

  const lastSeen = bridge?.bridge_last_seen ? new Date(bridge.bridge_last_seen).getTime() : null
  const bridgeOnline = lastSeen !== null && Date.now() - lastSeen < BRIDGE_FRESH_MS

  return (
    <>
      <h1>Print Server</h1>

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

      <h2 style={{ marginTop: 20 }}>Printers</h2>
      <div className="status-row">
        {printers.map((p) => {
          const media = [p.media_width, p.media_type].filter(Boolean).join(' · ')
          return (
            <div
              key={p.id}
              className={`status-card ${p.reachable === true ? 'ok' : p.reachable === false ? 'bad' : ''}`}
            >
              <div className="status-label">
                {p.name}
                {p.location && <span className="muted"> · {p.location}</span>}
              </div>
              <div className="status-value">
                {p.reachable === true ? 'Ready' : p.reachable === false ? 'Unreachable' : 'Not checked'}
              </div>
              {/* What is loaded, when the printer will say — the commonest
                  reason a badge does not come out is the wrong roll rather
                  than the printer being off.

                  Omitted rather than shown as unknown: the QL-820NWB does not
                  answer status requests at all (see the recon doc), so on
                  every printer we currently ship this line would permanently
                  read "Media unknown", which is not information and teaches
                  people to stop reading the card. */}
              {media && <div className="muted small">{media}</div>}
              <div className="muted small">
                {p.last_checked ? `Checked ${lastSeenLabel(p.last_checked, null)}` : 'Never checked'}
              </div>
              {p.error_state && <div className="muted small">{p.error_state}</div>}
            </div>
          )
        })}
        {!printers.length && <p className="muted small">No printers set up yet.</p>}
      </div>

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
