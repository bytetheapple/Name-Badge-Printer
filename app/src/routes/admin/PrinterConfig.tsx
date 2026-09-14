import { useCallback, useEffect, useRef, useState } from 'react'
import { BRIDGE_FRESH_MS } from '../../lib/bridge'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import BadgeDesign from './BadgeDesign'
import ProvisionWizard from './ProvisionWizard'
import PrinterQr from './PrinterQr'
import PrinterIntegrations from './PrinterIntegrations'
import type { Printer } from '../../lib/types'

/** One printer's tab: its name, and whether the bridge can currently reach it. */
function PrinterTab({
  printer,
  active,
  onSelect,
}: {
  printer: Printer
  active: boolean
  onSelect: () => void
}) {
  // null means the bridge has not reported on it yet — grey rather than red,
  // since "unknown" and "unreachable" are different things to an operator.
  const state = printer.reachable == null ? 'unknown' : printer.reachable ? 'ok' : 'bad'
  return (
    <button
      type="button"
      className={`printer-tab${active ? ' active' : ''}`}
      onClick={onSelect}
      title={state === 'unknown' ? 'Not yet reported' : state === 'ok' ? 'Reachable' : 'Not reachable'}
    >
      <span className={`tab-dot ${state}`} aria-hidden="true" />
      {printer.name || 'Unnamed printer'}
    </button>
  )
}

/**
 * The live state of a "find it again" search, under the printer's address.
 *
 * Reads the session the bridge writes, so it is the truth rather than a
 * hopeful message: still searching (with the seconds ticking, which is the
 * progress the old version never showed), found and now at a new address, or
 * finished without finding it and why. Nothing at all when no recent search.
 */
function LocateStatus({
  locate,
  bridgeOnline,
  bridgeChecked,
}: {
  locate?: LocateRow
  bridgeOnline: boolean
  bridgeChecked: boolean
}) {
  if (!locate) return null

  if (!LOCATE_DONE.has(locate.state)) {
    const started = Date.parse(locate.updated_at)
    const ms = Number.isNaN(started) ? 0 : Math.max(0, Date.now() - started)
    // Offline is the fast, honest answer: a search cannot run without the
    // server, and the heartbeat says so in seconds. This is the case the
    // three-minute wait was hiding.
    if (bridgeChecked && !bridgeOnline) {
      return (
        <div className="locate-status missed">
          The print server is offline, so the search can&apos;t run. Reconnect it on the Print
          Server tab, then try again.
        </div>
      )
    }
    if (ms > LOCATE_STALL_MS) {
      // Online, but past when it should have reported. The search ran and did
      // not find the printer -- powered off, or gone.
      return (
        <div className="locate-status missed">
          The search didn&apos;t find the printer. Check it is powered on, then try again.
        </div>
      )
    }
    const total = Math.round(ms / 1000)
    const clock = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
    return (
      <div className="locate-status searching">
        <span className="spinner-dot" aria-hidden="true" />
        Searching the network for this printer… {clock} (a full search can take up to 3 min)
      </div>
    )
  }
  if (locate.state === 'done') {
    return (
      <div className="locate-status found">
        Found it{locate.wireless_ip ? ` — now at ${locate.wireless_ip}` : ''}. Its address is updated.
      </div>
    )
  }
  return (
    <div className="locate-status missed">
      {locate.error ??
        'The search finished without finding this printer. Check it is powered on and on the network.'}
    </div>
  )
}

/** Add or edit a printer.
 *
 *  A dialog rather than fields on the page, so the page can read as a plain
 *  summary of what is set up. Adding by hand collects the address here because
 *  that is the entire reason for doing it by hand — a printer a scan cannot see
 *  is a printer whose address someone has to type.
 */
function PrinterDialog({
  orgId,
  printer,
  onClose,
  onSaved,
}: {
  orgId: string
  /** Omitted when adding. */
  printer?: Printer
  onClose: () => void
  onSaved: (id?: string) => void
}) {
  const adding = !printer
  const [name, setName] = useState(printer?.name ?? '')
  const [location, setLocation] = useState(printer?.location ?? '')
  const [ip, setIp] = useState(printer?.printer_ip ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!name.trim()) {
      setError('Give the printer a name.')
      return
    }
    // Only insisted on when adding by hand: an existing printer may legitimately
    // be mid-setup with no address yet.
    if (adding && !ip.trim()) {
      setError("Enter the printer's address — that is what adding by hand is for.")
      return
    }
    setSaving(true)
    setError(null)
    const fields = {
      name: name.trim(),
      location: location.trim() || null,
      printer_ip: ip.trim() || null,
    }
    const { data, error } = adding
      ? await supabase
          .from('printers')
          .insert({ org_id: orgId, port: 9100, ...fields })
          .select('id')
          .maybeSingle()
      : await supabase.from('printers').update(fields).eq('id', printer!.id).select('id').maybeSingle()
    setSaving(false)
    if (error) {
      setError(error.message)
      return
    }
    onSaved(data?.id as string | undefined)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{adding ? 'Add a printer' : 'Edit printer'}</h2>
        {error && <div className="error">{error}</div>}
        <label className="field">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Lobby Printer"
            autoFocus
          />
        </label>
        <label className="field">
          Location
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Front desk"
          />
        </label>
        <label className="field">
          Address
          <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.69" />
          <span className="muted small">
            {adding
              ? "The printer's address on your network."
              : 'Change this if the printer has moved to a new address.'}
          </span>
          {/* The print server's own account of why this address does not
              answer, shown where the address is typed rather than only on the
              status card. Typing a correct address and watching nothing happen
              is how a customer lost a morning: the app said "could not find
              the printer" and the real answer -- that the two were on
              networks with no route between them -- was known to the bridge
              and never asked for. */}
          {printer?.reachable === false && printer.unreachable_reason && (
            <span className="muted small">{printer.unreachable_reason}</span>
          )}
        </label>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : adding ? 'Add printer' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Slightly longer than the bridge's ~15s heartbeat, so most polls see
 *  something new rather than re-reading the same rows. */
const STATUS_REFRESH_MS = 20000
//: A finished search stops being news after this long, and clears itself.
const LOCATE_SHOW_MS = 5 * 60 * 1000
//: The bridge caps its own search at 150s and reports on the next
//: heartbeat. Past this with no result, the search is not running -- the
//: print server has not picked the request up, which usually means it is
//: offline.
const LOCATE_STALL_MS = 195 * 1000
const LOCATES_KEY = 'nbk.locates'
//: The bridge heartbeats every ~15s; treat it as online if seen within 45s,
//: the same threshold the Print Server tab uses.

type LocateRow = {
  printer_id: string
  state: string
  error: string | null
  updated_at: string
  wireless_ip: string | null
}

const LOCATE_DONE = new Set(['done', 'failed'])

/**
 * The printer whose tab was last open, so leaving the page and coming back
 * does not send you somewhere else.
 *
 * Only ever a printer id — never 'add'. Someone who has just finished setting a
 * printer up is left on the Add tab, and returning them there every visit
 * afterwards would defeat the point of landing on a printer at all.
 *
 * A stale id from a deleted printer, or from another organization, simply does
 * not match and the first printer is used instead.
 */
const TAB_KEY = 'nbk.printerTab'

const rememberedTab = () => {
  try {
    return window.localStorage.getItem(TAB_KEY) ?? ''
  } catch {
    return '' // private browsing, or storage disabled
  }
}

const rememberTab = (id: string) => {
  try {
    window.localStorage.setItem(TAB_KEY, id)
  } catch {
    /* not worth failing over */
  }
}

export default function PrinterConfig() {
  const { orgId, isAdmin } = useOrg()
  const [printers, setPrinters] = useState<Printer[]>([])
  const [loading, setLoading] = useState(true)
  //: 'add' until the first load says whether there is a printer to show.
  const [tab, setTab] = useState<string>('add')
  //: Whether the landing tab has been picked for this visit. Without it the
  //: twenty-second status refresh would drag the operator back off whichever
  //: printer they had opened.
  const landed = useRef(false)
  //: null = closed, 'add' = adding by hand, otherwise the printer being edited.
  const [dialog, setDialog] = useState<'add' | Printer | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  //: The most recent "find it again" search per printer, straight from the
  //: session row the bridge writes. DB-backed on purpose: the old code kept
  //: this in a notice string, which vanished on a tab switch and could not
  //: tell a search still running from one that finished — so it read as
  //: frozen whatever had happened. This survives a tab switch and a reload.
  const [locates, setLocates] = useState<Record<string, LocateRow>>(() => {
    // Seeded from the last visit: the outcome of a search must survive a tab
    // switch, which unmounts this whole page. It used to live only in the
    // session row and the on-screen state, so leaving and returning lost it
    // entirely -- the search vanished without a trace.
    try {
      return JSON.parse(localStorage.getItem(LOCATES_KEY) ?? '{}')
    } catch {
      return {}
    }
  })
  //: A one-second heartbeat, live only while a search is, so the elapsed
  //: counter moves and the search looks like it is doing something.
  const [, setTick] = useState(0)
  //: When the print server was last heard from, and whether we have looked
  //: yet. A search cannot run while the server is offline, and that is
  //: knowable at once from the heartbeat rather than after a three-minute
  //: wait -- which was the whole of the complaint.
  const [bridgeSeen, setBridgeSeen] = useState<string | null>(null)
  const [bridgeChecked, setBridgeChecked] = useState(false)

  const loadPrinters = useCallback(async () => {
    if (!orgId) return
    const { data } = await supabase
      .from('printers')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at')
    setPrinters((data ?? []) as Printer[])
    setLoading(false)
  }, [orgId])

  // The most recent locate session per printer, recent ones only. Latest per
  // printer wins: order by newest and let the first seen for each id stand.
  const loadLocates = useCallback(async () => {
    if (!orgId) return
    // No time filter in the query: comparing the server's rows against the
    // client's clock hid a just-created row whenever the two clocks disagreed,
    // which showed as nothing happening at all. Recency is decided below, from
    // each row's own timestamp, and only to drop a finished search that is no
    // longer news -- a search still running always shows.
    const { data, error } = await supabase
      .from('provisioning_sessions')
      .select('printer_id, state, error, updated_at, data')
      .eq('org_id', orgId)
      .eq('kind', 'locate')
      .order('updated_at', { ascending: false })
      .limit(40)
    if (error) return // keep whatever is shown rather than blanking it

    // Whether the print server is even there. Cheap, and it turns "waited three
    // minutes to be told nothing started" into "offline, said so at once".
    const { data: st } = await supabase
      .from('printer_status')
      .select('bridge_last_seen')
      .eq('org_id', orgId)
      .maybeSingle()
    setBridgeSeen((st?.bridge_last_seen as string | null) ?? null)
    setBridgeChecked(true)

    const cutoff = Date.now() - LOCATE_SHOW_MS
    const latest: Record<string, LocateRow> = {}
    for (const s of (data ?? []) as Array<Record<string, unknown>>) {
      const pid = s.printer_id as string | null
      if (!pid || latest[pid]) continue
      const state = String(s.state ?? '')
      const updated = String(s.updated_at ?? '')
      const done = LOCATE_DONE.has(state)
      // A finished search older than the window is stale; a running one is
      // always current, however long it has been.
      if (done && Date.parse(updated) < cutoff) continue
      latest[pid] = {
        printer_id: pid,
        state,
        error: (s.error as string | null) ?? null,
        updated_at: updated,
        wireless_ip: ((s.data as Record<string, unknown>)?.wireless_ip as string | null) ?? null,
      }
    }
    // Merge, not replace. A search this read did not return -- because it is
    // seconds old, or because the session aged out -- is kept from what we
    // already had, so the outcome never blanks. A kept search that has run
    // past the stall point renders as failed-try-again rather than spinning;
    // that is handled where it is shown, so nothing has to mutate it here.
    setLocates((prev) => {
      const merged: Record<string, LocateRow> = { ...latest }
      for (const [pid, l] of Object.entries(prev)) {
        if (merged[pid]) continue
        // Kept within the display window whether it finished or is still
        // going; the render decides what a long-running one has become.
        if (Date.now() - Date.parse(l.updated_at) < LOCATE_SHOW_MS) merged[pid] = l
      }
      return merged
    })
  }, [orgId])

  // Mirror the tracker to storage so the next mount can seed from it.
  useEffect(() => {
    try {
      localStorage.setItem(LOCATES_KEY, JSON.stringify(locates))
    } catch {
      // storage unavailable — the tracker still works within this mount
    }
  }, [locates])

  useEffect(() => {
    void loadPrinters()
    void loadLocates()
  }, [loadPrinters, loadLocates])

  // The reachability dot is presented as live status, so it has to be. The
  // bridge reports each printer's state on its heartbeat, roughly every 15
  // seconds; without re-reading, the dot shows whatever was true when the page
  // was opened and quietly goes stale. A running search is read faster, so
  // that gets its own quicker poll.
  useEffect(() => {
    if (!orgId) return
    const slow = window.setInterval(() => void loadPrinters(), STATUS_REFRESH_MS)
    const fast = window.setInterval(() => void loadLocates(), 4000)
    return () => {
      window.clearInterval(slow)
      window.clearInterval(fast)
    }
  }, [orgId, loadPrinters, loadLocates])

  // Tick once a second while any search is still running, so its elapsed
  // counter advances. Stops itself the moment nothing is in flight.
  const bridgeOnline =
    bridgeSeen != null && Date.now() - new Date(bridgeSeen).getTime() < BRIDGE_FRESH_MS

  // A search is actively running only while the server is online and it has
  // not overrun. Offline, or overrun, it is finished -- so the button frees up
  // and the ticker stops.
  const searchActive = (l?: LocateRow) =>
    !!l &&
    !LOCATE_DONE.has(l.state) &&
    (!bridgeChecked || bridgeOnline) &&
    Date.now() - Date.parse(l.updated_at) <= LOCATE_STALL_MS

  const anySearching = Object.values(locates).some((l) => searchActive(l))
  useEffect(() => {
    if (!anySearching) return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [anySearching])

  // Land on a printer, not on the form for adding one. Most customers have a
  // single printer, and arriving at its status is what they came for.
  useEffect(() => {
    if (loading || landed.current) return
    landed.current = true
    const remembered = rememberedTab()
    const known = printers.some((p) => p.id === remembered)
    setTab(known ? remembered : (printers[0]?.id ?? 'add'))
  }, [loading, printers])

  // Follow the operator's choice, so the next visit starts where this one
  // ended. The Add tab is deliberately not recorded — see TAB_KEY.
  function openTab(id: string) {
    setTab(id)
    if (id !== 'add') rememberTab(id)
  }

  // A deleted printer leaves its tab pointing at nothing.
  useEffect(() => {
    if (tab !== 'add' && !printers.some((p) => p.id === tab)) {
      setTab(printers[0]?.id ?? 'add')
    }
  }, [printers, tab])

  async function testPrint(printer: Printer) {
    setBusy(printer.id)
    setNotice(null)
    const { error } = await supabase
      .from('print_jobs')
      .insert({ org_id: orgId, type: 'test', status: 'queued', printer_id: printer.id })
    setBusy(null)
    setNotice(error ? `Could not queue a test print: ${error.message}` : 'Test print queued.')
  }

  /** Ask the print server to sweep for a printer whose address has changed.
   *
   *  The heartbeat already follows a printer by mDNS, so this is for the case
   *  where that fails — mDNS blocked, or the printer on a different subnet
   *  from the one it was on. That needs a scan of the network, which is fine
   *  once because somebody asked for it, and would be wrong as a background
   *  habit; so it lives behind this button rather than in the heartbeat.
   */
  async function locate(printer: Printer) {
    setBusy(printer.id)
    setNotice(null)
    const { error } = await supabase.from('provisioning_sessions').insert({
      org_id: printer.org_id,
      kind: 'locate',
      state: 'discover',
      printer_id: printer.id,
      printer_name: printer.name,
    })
    setBusy(null)
    if (error) {
      setNotice(`Could not start the search: ${error.message}`)
      return
    }
    // Show it searching at once, rather than waiting on a round trip to
    // reveal the row we just wrote -- the button doing nothing visible for a
    // beat is what a slow or skewed read looked like. The tracker refines this
    // to found-or-not from the session, and stays put across tab switches
    // because it reads the session rather than a string set and forgotten.
    setLocates((prev) => ({
      ...prev,
      [printer.id]: {
        printer_id: printer.id,
        state: 'discover',
        error: null,
        updated_at: new Date().toISOString(),
        wireless_ip: null,
      },
    }))
    await loadLocates()
  }

  async function remove(printer: Printer) {
    if (!window.confirm(`Delete "${printer.name}"? Its sign-in QR code will stop working.`)) return
    setBusy(printer.id)
    const { error } = await supabase.from('printers').delete().eq('id', printer.id)
    setBusy(null)
    if (error) setNotice(`Could not delete: ${error.message}`)
    await loadPrinters()
  }

  if (loading) return <p className="muted">Loading…</p>
  if (!isAdmin) {
    return (
      <>
        <h1>Printers</h1>
        <p className="muted">Only owners and admins can change the printer setup.</p>
      </>
    )
  }

  const current = printers.find((p) => p.id === tab) ?? null

  return (
    <>
      <h1>Printers</h1>

      {/* Printers first, in the order they were added, and the way in for a
          new one always last — so an existing tab never moves when another
          printer is added. */}
      <div className="printer-tabs" role="tablist">
        {printers.map((p) => (
          <PrinterTab key={p.id} printer={p} active={tab === p.id} onSelect={() => openTab(p.id)} />
        ))}
        <button
          type="button"
          className={`printer-tab${tab === 'add' ? ' active' : ''}`}
          onClick={() => setTab('add')}
        >
          + Add a Printer
        </button>
      </div>

      <div className="printer-tab-panel">
        {notice && <div className="notice">{notice}</div>}

        {tab === 'add' && (
          <>
            <ProvisionWizard onFinished={() => void loadPrinters()} />
            <div className="add-by-hand">
              <button className="secondary btn-sm" onClick={() => setDialog('add')}>
                Add a printer by hand
              </button>
            </div>
          </>
        )}

        {current && (
          <>
            <div className="printer-summary">
              <div>
                <div className="printer-summary-name">{current.name}</div>
                <div className="muted small">
                  {[current.location, current.printer_ip ?? 'no address set']
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <LocateStatus
                  locate={locates[current.id]}
                  bridgeOnline={bridgeOnline}
                  bridgeChecked={bridgeChecked}
                />
              </div>
              <div className="printer-summary-actions">
                <button className="secondary btn-sm" onClick={() => setDialog(current)}>
                  Edit
                </button>
                <button
                  className="secondary btn-sm"
                  onClick={() => void testPrint(current)}
                  disabled={busy === current.id}
                >
                  {busy === current.id ? 'Queuing…' : 'Test print'}
                </button>
                <button
                  className="secondary btn-sm"
                  onClick={() => void locate(current)}
                  disabled={
                    busy === current.id ||
                    (!current.mac && !current.serial) ||
                    searchActive(locates[current.id])
                  }
                  title={
                    current.mac || current.serial
                      ? 'Sweep the network for this printer and correct its address'
                      : 'No serial or MAC recorded yet — the print server fills this ' +
                        'in the next time the printer answers'
                  }
                >
                  {searchActive(locates[current.id]) ? 'Searching…' : 'Find it again'}
                </button>
                <button
                  className="secondary btn-sm"
                  onClick={() => void remove(current)}
                  disabled={busy === current.id}
                >
                  Delete
                </button>
              </div>
            </div>

            <h2>Badge</h2>
            <BadgeDesign printer={current} onChanged={loadPrinters} />

            <h2>Sign-in QR code</h2>
            <PrinterQr printer={current} onChanged={loadPrinters} />

            <h2>Where sign-ins go</h2>
            <PrinterIntegrations printer={current} />
          </>
        )}
      </div>

      {/* What to buy. It sat in the admin footer, on every page — a standing
          statement about label stock is only useful where printers are, and
          everywhere else it was furniture. */}
      <footer className="admin-footer">
        Badges print on <strong>Brother DK-1234</strong> die-cut name-badge labels (60 × 86 mm).
        That is the only media this system supports.
      </footer>

      {dialog && orgId && (
        <PrinterDialog
          orgId={orgId}
          printer={dialog === 'add' ? undefined : dialog}
          onClose={() => setDialog(null)}
          onSaved={async (id) => {
            await loadPrinters()
            if (id && dialog === 'add') setTab(id) // open what was just added
          }}
        />
      )}
    </>
  )
}
