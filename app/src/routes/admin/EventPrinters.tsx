import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { newSecret } from '../../lib/secrets'
import EventQr from './EventQr'
import type { EventPrinterRow, Printer } from '../../lib/types'

/**
 * Which printers an event uses, and the QR code for each.
 *
 * One code per printer per event, rather than one per event, so a queue can be
 * split across desks and each desk's badges come out beside the person
 * standing at it. A code carries no event name and no organization: it is an
 * opaque token, resolved server-side on every scan, so a code printed for last
 * year's event opens nothing once that event is switched off.
 *
 * There is no button to reissue a code. Remove and add the printer again does
 * exactly that — a new row with a new token — and an event code is thrown away
 * after one afternoon, so a control of its own was a second way to do one
 * thing.
 *
 * On-site registrations may be routed away from the scanned printer to one
 * behind the desk, where an administrator collects them — usually to take
 * payment before handing a badge over. That is a property of the event rather
 * than of any one code: when it is set, every code's walk-ins go there.
 */
export default function EventPrinters({
  orgId,
  integrationId,
  eventName,
  config,
  onConfig,
}: {
  orgId: string
  integrationId: string
  /** What the organizer called this event. It heads the printed sign, so it
   *  is passed in rather than re-read: the name on paper should be the name
   *  showing on screen when the button was pressed. */
  eventName: string
  config: Record<string, unknown>
  onConfig: (key: string, value: unknown) => void
}) {
  const [printers, setPrinters] = useState<Printer[]>([])
  const [rows, setRows] = useState<EventPrinterRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addId, setAddId] = useState('')

  const load = useCallback(async () => {
    const [{ data: ps }, { data: eps }] = await Promise.all([
      supabase.from('printers').select('*').eq('org_id', orgId).order('name'),
      supabase
        .from('event_printers')
        .select('*')
        .eq('integration_id', integrationId)
        .order('created_at'),
    ])
    setPrinters((ps ?? []) as Printer[])
    setRows((eps ?? []) as EventPrinterRow[])
  }, [orgId, integrationId])

  useEffect(() => {
    void load()
  }, [load])

  const used = new Set(rows.map((r) => r.printer_id))
  const spare = printers.filter((p) => !used.has(p.id))
  const sameprinter = config.onsite_same_printer !== false
  const onsitePrinterId = String(config.onsite_printer_id ?? '')

  async function addPrinter(printerId: string) {
    if (!printerId) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.from('event_printers').insert({
      org_id: orgId,
      integration_id: integrationId,
      printer_id: printerId,
      token: newSecret('e_', 16),
    })
    setBusy(false)
    if (error) setError(error.message)
    setAddId('')
    await load()
  }

  async function removePrinter(row: EventPrinterRow) {
    const printer = printers.find((p) => p.id === row.printer_id)
    // Said plainly, because the code is on paper somewhere and taking the row
    // away is what stops it working.
    if (
      !window.confirm(
        `Remove ${printer?.name ?? 'this printer'} from this event? Any printed QR code ` +
          'for it stops working immediately.',
      )
    ) {
      return
    }
    setBusy(true)
    const { error } = await supabase.from('event_printers').delete().eq('id', row.id)
    setBusy(false)
    if (error) setError(error.message)
    await load()
  }

  return (
    <div style={{ marginTop: 12 }}>
      <h4>Printers</h4>

      {/* Above the list rather than after it: adding the first printer is the
          whole job on a new event, and a control that only appears once there
          is something to add it to is a control nobody finds. Left aligned
          because modal-actions pushes to the right, which reads as finishing
          something rather than starting it. */}
      {spare.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <select value={addId} onChange={(e) => setAddId(e.target.value)}>
            <option value="">Choose a printer…</option>
            {spare.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button disabled={!addId || busy} onClick={() => void addPrinter(addId)}>
            Add printer
          </button>
        </div>
      )}

      {rows.map((row) => {
        const printer = printers.find((p) => p.id === row.printer_id)
        return (
          <div key={row.id} className="field-group" style={{ marginBottom: 10 }}>
            <div>
              <strong>{printer?.name ?? 'Printer no longer set up'}</strong>
              {printer?.location && <span className="muted"> · {printer.location}</span>}
            </div>
            <EventQr
              token={row.token}
              eventName={eventName}
              printerName={printer?.name ?? 'Printer'}
              actions={
                <button
                  className="secondary btn-sm"
                  disabled={busy}
                  onClick={() => void removePrinter(row)}
                >
                  Remove
                </button>
              }
            />
          </div>
        )
      })}

      {!rows.length && (
        <p className="muted small">
          No printers yet. Add one to get a code people can scan.
        </p>
      )}

      <h4 style={{ marginTop: 16 }}>On-site registrations</h4>
      <label className="check">
        <input
          type="checkbox"
          checked={sameprinter}
          onChange={(e) => onConfig('onsite_same_printer', e.target.checked)}
        />
        On-site registrations go to the same printer?
      </label>
      {!sameprinter && (
        <label className="field" style={{ maxWidth: 320 }}>
          Printer for on-site registrations
          <select
            value={onsitePrinterId}
            onChange={(e) => onConfig('onsite_printer_id', e.target.value)}
          >
            <option value="">Choose a printer…</option>
            {printers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="muted small">
            Everyone not on the pre-registration list prints here, whichever code they
            scanned. It may be one of the printers above or a different one.
          </span>
        </label>
      )}
      {/* A setting that is on but unfinished does nothing, silently. Saying so
          beats letting a desk discover it when the first walk-in's badge comes
          out at the wrong end of the room. */}
      {!sameprinter && !onsitePrinterId && (
        <p className="muted small">
          Until a printer is chosen here, on-site badges print at whichever code was
          scanned.
        </p>
      )}

      {error && <p className="error small">{error}</p>}
    </div>
  )
}
