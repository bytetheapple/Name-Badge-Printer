import { useCallback, useEffect, useRef, useState } from 'react'
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

  useEffect(() => {
    void loadPrinters()
  }, [loadPrinters])

  // The reachability dot is presented as live status, so it has to be. The
  // bridge reports each printer's state on its heartbeat, roughly every 15
  // seconds; without re-reading, the dot shows whatever was true when the page
  // was opened and quietly goes stale.
  useEffect(() => {
    if (!orgId) return
    const id = window.setInterval(() => void loadPrinters(), STATUS_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [orgId, loadPrinters])

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
    setNotice(
      error
        ? `Could not start the search: ${error.message}`
        : `Looking for ${printer.name} on the network. This takes up to a couple of ` +
          'minutes; the address updates here when it is found.',
    )
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
                  disabled={busy === current.id || !current.mac}
                  title={
                    current.mac
                      ? 'Sweep the network for this printer and correct its address'
                      : 'No MAC recorded yet — the print server fills this in the ' +
                        'next time the printer answers'
                  }
                >
                  {busy === current.id ? 'Looking…' : 'Find it again'}
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
