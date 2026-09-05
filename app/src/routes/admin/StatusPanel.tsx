import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import JoinNetwork from './JoinNetwork'
import { useOrg } from '../../lib/org'
import { lastSeenLabel } from '../../lib/secrets'
import type {
  Printer,
  PrinterStatusRow,
  PrintJob,
  ServerInterface,
  ServerNetworkRequest,
} from '../../lib/types'

// The bridge heartbeats every ~15s; treat it as online if seen within 45s.
const BRIDGE_FRESH_MS = 45000

/**
 * Why an interface has no address, in the reader's words rather than
 * NetworkManager's.
 *
 * A wired port with the cable out reports "unavailable", which is precisely
 * the question the person reading this card is asking — the first time it was
 * looked at, it answered "did I leave the cable disconnected?" with a word
 * that does not mean that to anyone. Hedged as "detected" because no carrier
 * is also what a dead switch port looks like.
 */
function whyNoAddress(i: ServerInterface): string {
  const idle = i.state === 'unavailable' || i.state === 'disconnected'
  if (i.kind === 'wired' && idle) return 'No cable detected'
  if (i.kind === 'wifi' && idle) return 'Not joined to a network'
  return i.state
}

export default function StatusPanel() {
  const { orgId, isAdmin } = useOrg()
  const [bridge, setBridge] = useState<PrinterStatusRow | null>(null)
  const [jobs, setJobs] = useState<PrintJob[]>([])
  //: Readable by staff since the role change, which is the point of putting it
  //: here: "is the printer working" is the question a greeter actually has,
  //: and the Printers tab that used to answer it is an admin's.
  const [printers, setPrinters] = useState<Printer[]>([])
  const [netReq, setNetReq] = useState<ServerNetworkRequest | null>(null)
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
  // Only the most recent: this is "did the change I just made land", not a
  // history, and an old failure sitting under a working server reads as a
  // current fault.
  const loadNetReq = useCallback(async () => {
    if (!orgId || !isAdmin) return
    const { data } = await supabase
      .from('server_network_requests')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(1)
    setNetReq(((data ?? [])[0] as ServerNetworkRequest) ?? null)
  }, [orgId, isAdmin])
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
    void loadNetReq()
    const channel = supabase
      .channel('status-panel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'printer_status' }, () =>
        loadBridge(),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'printers' }, () =>
        loadPrinters(),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'print_jobs' }, () => loadJobs())
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'server_network_requests' },
        () => loadNetReq(),
      )
      .subscribe()
    const timer = window.setInterval(() => setTick((n) => n + 1), 5000)
    return () => {
      void supabase.removeChannel(channel)
      window.clearInterval(timer)
    }
  }, [loadBridge, loadPrinters, loadJobs, loadNetReq])

  const lastSeen = bridge?.bridge_last_seen ? new Date(bridge.bridge_last_seen).getTime() : null
  const bridgeOnline = lastSeen !== null && Date.now() - lastSeen < BRIDGE_FRESH_MS
  // Only while the bridge is online: an offline server's last known addresses
  // are history, and reading them as current is how somebody concludes the
  // network is fine when the server is simply gone.
  const net = bridgeOnline ? bridge?.network ?? null : null

  return (
    <>
      {/* On the heading rather than in a card of its own. Whether the server
          is up is context for everything below it, not a finding — and a card
          that says "Online" every day of the year is a card people stop
          reading, which is the last thing this one can afford to be. */}
      <h1 style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        Print Server
        <span className="muted small" style={{ fontWeight: 400 }}>
          <span className={`tab-dot ${bridgeOnline ? 'ok' : 'bad'}`} aria-hidden="true" />{' '}
          {lastSeen === null
            ? 'Never connected'
            : `${bridgeOnline ? 'Online' : 'Offline'} · last seen ` +
              new Date(lastSeen).toLocaleTimeString()}
        </span>
      </h1>

      {/* Which networks the server is on, next to the printers it can reach.
          Shown even when everything works: the question "are these two on the
          same network" is unanswerable from a card that only appears once
          something has already gone wrong, and by then somebody is at the
          site guessing. */}
      {net && net.interfaces.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h2>Networks</h2>
          <div className="status-row">
            {net.interfaces.map((i: ServerInterface) => (
              <div key={i.name} className={`status-card ${i.ip ? 'ok' : ''}`}>
                <div className="status-label">
                  {i.kind === 'wifi' ? 'WiFi' : i.kind === 'wired' ? 'Wired' : 'Network'}
                  {i.name !== 'default' && <span className="muted"> · {i.name}</span>}
                </div>
                <div className="status-value">{i.ip ?? 'No address'}</div>
                {i.kind === 'wifi' && (
                  <div className="muted small">
                    {i.ssid ? `${i.ssid}${i.signal != null ? ` · ${i.signal}%` : ''}` : 'Not joined'}
                  </div>
                )}
                {!i.ip && <div className="muted small">{whyNoAddress(i)}</div>}
              </div>
            ))}
          </div>
          {/* Only worth saying when it is actionable: a server with the radio
              off cannot be put on a printer's WiFi without a visit. */}
          {net.wifi_radio === 'disabled' && (
            <p className="muted small">
              The WiFi radio on this print server is switched off, so it can only
              reach printers on its wired network.
            </p>
          )}
          {isAdmin && orgId && net.wifi_radio !== 'disabled' && (
            <JoinNetwork
              orgId={orgId}
              request={netReq}
              interfaces={net.interfaces}
              onChanged={loadNetReq}
            />
          )}
        </div>
      )}

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
              {/* Only while it is actually unreachable: on a printer that has
                  come back this is history, and a card that still explains a
                  fixed fault is how people learn to stop reading the card. */}
              {p.reachable === false && p.unreachable_reason && (
                <div className="muted small">{p.unreachable_reason}</div>
              )}
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
