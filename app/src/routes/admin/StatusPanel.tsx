import { useCallback, useEffect, useState } from 'react'
import { BRIDGE_FRESH_MS } from '../../lib/bridge'
import { supabase } from '../../lib/supabase'
import JoinNetwork from './JoinNetwork'
import SearchProgress from './SearchProgress'
import { useOrg } from '../../lib/org'
import type {
  Printer,
  PrinterStatusRow,
  PrintJob,
  ServerInterface,
  ServerNetworkRequest,
} from '../../lib/types'

// The bridge heartbeats every ~15s; treat it as online if seen within 45s.

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
function whyNoAddress(i: ServerInterface, radio?: string | null): string {
  const idle = i.state === 'unavailable' || i.state === 'disconnected'
  if (i.kind === 'wired' && idle) return 'No cable detected'
  if (i.kind === 'wifi' && radio === 'disabled') return 'Radio switched off'
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
  const [joining, setJoining] = useState(false)
  const [, setTick] = useState(0)
  //: How many badges are still waiting to print (not yet claimed by the print
  //: server), which is what the "cancel pending" control acts on. Counted
  //: separately from the recent-jobs list, which is capped at ten.
  const [queued, setQueued] = useState(0)
  const [cancelling, setCancelling] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  //: The last time a badge actually came out of each printer — the honest "it
  //: was working" signal, unlike the reachability probe, which only says a port
  //: answered.
  const [lastPrints, setLastPrints] = useState<Record<string, string>>({})
  //: The printer whose connection is being tested, and the result per printer.
  const [testing, setTesting] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<Record<string, string>>({})

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
  // The most recent successful print per printer, in one query — the newest
  // printed job for each. Refreshed only when a job finishes, not on the status
  // poll: a badge coming out is not a per-second event.
  const loadLastPrints = useCallback(async () => {
    if (!orgId) return
    const { data } = await supabase
      .from('print_jobs')
      .select('printer_id, printed_at')
      .eq('org_id', orgId)
      .eq('status', 'printed')
      .not('printed_at', 'is', null)
      .order('printed_at', { ascending: false })
      .limit(400)
    const map: Record<string, string> = {}
    for (const r of (data ?? []) as Array<{ printer_id: string | null; printed_at: string }>) {
      if (r.printer_id && !map[r.printer_id]) map[r.printer_id] = r.printed_at
    }
    setLastPrints(map)
  }, [orgId])

  /**
   * A real, on-demand connection test.
   *
   * Only the bridge can reach the printer, so this is a short round trip: ask it
   * to probe (probe_requested_at), then wait for last_checked to move — a fresh
   * probe, whether ours or a heartbeat that happened to land first. Watching
   * last_checked *change* rather than comparing it to the browser clock keeps
   * this right even when the two clocks disagree.
   */
  async function testConnection(p: Printer) {
    const before = p.last_checked ?? ''
    setTesting(p.id)
    setTestMsg((m) => ({ ...m, [p.id]: '' }))
    const { error } = await supabase
      .from('printers')
      .update({ probe_requested_at: new Date().toISOString() })
      .eq('id', p.id)
    if (error) {
      setTesting(null)
      setTestMsg((m) => ({ ...m, [p.id]: `Could not start the test: ${error.message}` }))
      return
    }
    const startedAt = Date.now()
    const poll = async () => {
      const { data } = await supabase
        .from('printers')
        .select('reachable, last_checked, unreachable_reason')
        .eq('id', p.id)
        .maybeSingle()
      const checked = (data?.last_checked as string | null) ?? ''
      if (checked && checked !== before) {
        setTesting(null)
        setTestMsg((m) => ({
          ...m,
          [p.id]: data?.reachable
            ? 'Reachable — the printer answered.'
            : `No answer${data?.unreachable_reason ? ` — ${data.unreachable_reason}` : '.'}`,
        }))
        void loadPrinters()
        return
      }
      if (Date.now() - startedAt > 12000) {
        setTesting(null)
        setTestMsg((m) => ({
          ...m,
          [p.id]: 'No response from the print server (it may be offline). Try again.',
        }))
        return
      }
      window.setTimeout(() => void poll(), 1000)
    }
    window.setTimeout(() => void poll(), 1200)
  }
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
    // The true number waiting, which can exceed the ten shown above.
    const { count } = await supabase
      .from('print_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('status', 'queued')
    setQueued(count ?? 0)
  }, [orgId])

  /**
   * Clear the badges still waiting to print.
   *
   * Only the queued ones — a job the print server has already taken is not
   * ours to pull out from under it, and the delete is scoped to 'queued' both
   * here and in the row policy so it never can. The point is the printer that
   * was offline overnight: without this, a day's worth of badges prints for
   * people long gone the moment it reconnects.
   */
  async function cancelQueued() {
    if (!orgId) return
    if (
      !window.confirm(
        `Cancel ${queued} badge${queued === 1 ? '' : 's'} still waiting to print? ` +
          `They will not print when the print server reconnects.`,
      )
    ) {
      return
    }
    setCancelling(true)
    setNotice(null)
    const { error } = await supabase
      .from('print_jobs')
      .delete()
      .eq('org_id', orgId)
      .eq('status', 'queued')
    setCancelling(false)
    if (error) {
      setNotice(`Could not cancel the pending badges: ${error.message}`)
      return
    }
    await loadJobs()
  }

  useEffect(() => {
    const refreshAll = () => {
      void loadBridge()
      void loadPrinters()
      void loadJobs()
      void loadLastPrints()
      void loadNetReq()
    }
    refreshAll()
    const channel = supabase
      .channel('status-panel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'printer_status' }, () =>
        loadBridge(),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'printers' }, () =>
        loadPrinters(),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'print_jobs' }, () => {
        void loadJobs()
        void loadLastPrints()
      })
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'server_network_requests' },
        () => loadNetReq(),
      )
      .subscribe()

    // Re-read rather than only re-render: online-ness is judged against
    // bridge_last_seen, so a page that never refetches it eventually calls a
    // healthy server offline. Fast while the tab is watched, slow while it is
    // hidden — and, most importantly, an immediate refetch the moment it comes
    // back to the front, because a background tab's timers are throttled to
    // about once a minute and the shown status would otherwise be that stale
    // exactly when someone returns to it to check.
    let timer = 0
    const schedule = () => {
      window.clearInterval(timer)
      timer = window.setInterval(
        () => {
          setTick((n) => n + 1)
          void loadBridge()
        },
        document.hidden ? 60000 : 5000,
      )
    }
    schedule()
    const onVisible = () => {
      if (!document.hidden) refreshAll()
      schedule()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      void supabase.removeChannel(channel)
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [loadBridge, loadPrinters, loadJobs, loadLastPrints, loadNetReq])

  const lastSeen = bridge?.bridge_last_seen ? new Date(bridge.bridge_last_seen).getTime() : null
  const bridgeOnline = lastSeen !== null && Date.now() - lastSeen < BRIDGE_FRESH_MS
  // Shown whether or not the server is online, but never passed off as
  // current: an offline server's addresses are history, and reading them as
  // live is how somebody concludes the network is fine when the server is
  // gone. Hiding them outright was worse — a section that silently vanishes
  // reads as a bug in the page, which is precisely how it was reported.
  const net = bridge?.network ?? null
  const waitingToJoin = netReq?.state === 'pending' || netReq?.state === 'sent' 

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
            {net.interfaces.map((i: ServerInterface) => {
              // The way onto a network belongs in the card for the radio that
              // has none — not under the section, where it read as being about
              // the server as a whole. A radio that is already on a network
              // shows the network instead: moving a working server to a
              // different one is a bench job, not a console one.
              const offerJoin =
                i.kind === 'wifi' && !i.ip && isAdmin && !!orgId && bridgeOnline
              return (
                <div key={i.name} className={`status-card ${i.ip ? 'ok' : ''}`}>
                  <div className="status-label">
                    {i.kind === 'wifi' ? 'WiFi' : i.kind === 'wired' ? 'Wired' : 'Network'}
                    {i.name !== 'default' && <span className="muted"> · {i.name}</span>}
                  </div>
                  <div className="status-value">{i.ip ?? 'No address'}</div>
                  {i.kind === 'wifi' && i.ip && (
                    <div className="muted small">
                      {i.ssid ? `${i.ssid}${i.signal != null ? ` · ${i.signal}%` : ''}` : 'Joined'}
                    </div>
                  )}
                  {!i.ip && <div className="muted small">{whyNoAddress(i, net.wifi_radio)}</div>}
                  {offerJoin && waitingToJoin && (
                    <div className="muted small" style={{ marginTop: 8 }}>
                      Joining {netReq?.ssid}. It has up to a couple of minutes, and stays
                      on its current network if the new one cannot reach us.
                    </div>
                  )}
                  {offerJoin && !waitingToJoin && (
                    <>
                      {netReq?.state === 'failed' && netReq.error && (
                        <div className="muted small" style={{ marginTop: 8 }}>
                          {netReq.error}
                        </div>
                      )}
                      {!joining && (
                        <button
                          className="secondary"
                          style={{ marginTop: 10 }}
                          onClick={() => setJoining(true)}
                        >
                          Join a wireless network
                        </button>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>
          {/* Only worth saying when it is actionable: a server with the radio
              off cannot be put on a printer's WiFi without a visit. */}
          {joining && orgId && (
            <JoinNetwork
              orgId={orgId}
              interfaces={net.interfaces}
              networks={net.networks ?? []}
              onDone={() => {
                setJoining(false)
                void loadNetReq()
              }}
              onCancel={() => setJoining(false)}
            />
          )}
          {!bridgeOnline && (
            <p className="muted small">
              Last checked in
              {lastSeen ? ` at ${new Date(lastSeen).toLocaleTimeString()}` : ''}. The print
              server checks in every couple of seconds; it hasn&apos;t in a little while, so
              these figures may be out of date.
            </p>
          )}
        </div>
      )}

      <h2 style={{ marginTop: 20 }}>Printers</h2>
      <div className="status-row">
        {printers.map((p) => {
          const media = [p.media_width, p.media_type].filter(Boolean).join(' · ')
          // A green dot only means "the last probe reached it" — and when the
          // print server is offline, no probe has run, so that green is stale.
          // Show it red then: for all practical purposes a printer the server
          // cannot reach is unreachable.
          const state =
            !bridgeOnline ? 'bad' : p.reachable === true ? 'ok' : p.reachable === false ? 'bad' : ''
          const lastPrint = lastPrints[p.id]
          return (
            <div key={p.id} className={`status-card ${state}`}>
              <div className="status-label">
                {p.name}
                {p.location && <span className="muted"> · {p.location}</span>}
              </div>
              <div className="status-value">
                {state === 'ok' ? 'Ready' : state === 'bad' ? 'Unreachable' : 'Not checked'}
              </div>
              {/* What is loaded, when the printer will say — the commonest
                  reason a badge does not come out is the wrong roll rather
                  than the printer being off. Omitted rather than shown as
                  unknown: the QL-820NWB does not answer status requests, so
                  this would otherwise permanently read "Media unknown". */}
              {media && <div className="muted small">{media}</div>}

              {/* The honest "it was working" signal: a badge actually came out.
                  Unlike the dot, this cannot go stale-green. */}
              <div className="muted small">
                Last printout: {lastPrint ? new Date(lastPrint).toLocaleString() : 'never'}
              </div>

              {!bridgeOnline ? (
                <div className="muted small">The print server is offline, so it can't be checked.</div>
              ) : (
                p.reachable === false &&
                p.unreachable_reason && <div className="muted small">{p.unreachable_reason}</div>
              )}
              {p.error_state && bridgeOnline && <div className="muted small">{p.error_state}</div>}

              <div style={{ marginTop: 8 }}>
                <button
                  className="secondary btn-sm"
                  onClick={() => void testConnection(p)}
                  disabled={testing === p.id}
                >
                  {testing === p.id ? 'Testing…' : 'Test connection'}
                </button>
                {testMsg[p.id] && <div className="muted small" style={{ marginTop: 4 }}>{testMsg[p.id]}</div>}
              </div>

              {/* And that the server is doing something about it — the
                  background search's progress, so a missing printer reads as
                  one being recovered rather than one nobody is coming for. */}
              <SearchProgress printer={p} />
            </div>
          )
        })}
        {!printers.length && <p className="muted small">No printers set up yet.</p>}
      </div>

      <h2 style={{ marginTop: 20 }}>Recent print jobs</h2>

      {notice && <div className="error">{notice}</div>}

      {/* Badges still waiting to print, with a way to clear them. The case this
          is for: the printer was offline overnight, and without this a day's
          worth of badges prints for people long gone the moment it comes back. */}
      {queued > 0 && (
        <div
          className="notice"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}
        >
          <span>
            {queued} badge{queued === 1 ? ' is' : 's are'} waiting to print
            {bridgeOnline ? '' : ' — the print server is offline'}. They print when it reconnects.
          </span>
          <button
            className="secondary btn-sm"
            onClick={() => void cancelQueued()}
            disabled={cancelling}
          >
            {cancelling ? 'Cancelling…' : `Cancel ${queued} pending`}
          </button>
        </div>
      )}

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
