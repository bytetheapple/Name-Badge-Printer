import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { invokeFn } from '../../lib/functions'

/**
 * Print a badge for every guest on the event's pre-registration list.
 *
 * For an organizer who would rather run all the badges off beforehand than have
 * each guest scan at the desk. It queues one badge per pre-registered guest to a
 * printer the operator picks; the badges are the same ones the desk prints.
 *
 * It does not check anyone in — pre-printing happens before the doors open, so
 * attendance is still recorded when guests actually arrive.
 */
export default function EventPrintAll({
  orgId,
  integrationId,
  config,
}: {
  orgId: string
  integrationId: string
  config: Record<string, unknown>
}) {
  const hasList = typeof config.spreadsheet_id === 'string' && config.spreadsheet_id !== ''
  const [printers, setPrinters] = useState<Array<{ id: string; name: string }>>([])
  const [printerId, setPrinterId] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!orgId) return
    void supabase
      .from('printers')
      .select('id, name')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        const rows = (data as Array<{ id: string; name: string }> | null) ?? []
        setPrinters(rows)
        setPrinterId((prev) => prev || rows[0]?.id || '')
      })
  }, [orgId])

  async function printAll() {
    const printer = printers.find((p) => p.id === printerId)
    if (!printer) return
    if (
      !window.confirm(
        `Queue a badge for every pre-registered guest and print them on ${printer.name}? ` +
          'This prints one badge per guest and does not check anyone in.',
      )
    ) {
      return
    }
    setBusy(true)
    setMsg(null)
    setError(null)
    const res = await invokeFn('event-print-all', {
      org_id: orgId,
      integration_id: integrationId,
      printer_id: printerId,
    })
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? 'Could not print the badges.')
      return
    }
    const count = Number(res.count ?? 0)
    setMsg(
      count === 0
        ? 'The pre-registration list is empty — nothing to print yet.'
        : `Queued ${count} badge${count === 1 ? '' : 's'} to print on ${res.printer_name ?? printer.name}.`,
    )
  }

  if (!hasList) return null

  return (
    <div className="event-print-all" style={{ marginTop: 16 }}>
      <div className="field-row-label" style={{ marginBottom: 6 }}>
        Print all pre-registered badges
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Run off a badge for every guest on the pre-registration list, instead of each guest scanning
        at the desk. They are the same badges the desk prints. This does not check anyone in —
        attendance is still recorded when guests arrive.
      </p>

      {msg && <div className="notice">{msg}</div>}
      {error && <div className="error">{error}</div>}

      {printers.length === 0 ? (
        <p className="muted small">Add a printer to this organization first.</p>
      ) : (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="field" style={{ margin: 0 }}>
            <span className="muted small">Printer</span>
            <select value={printerId} onChange={(e) => setPrinterId(e.target.value)}>
              {printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={busy || !printerId} onClick={() => void printAll()}>
            {busy ? 'Queuing…' : 'Print all pre-registered badges'}
          </button>
        </div>
      )}
    </div>
  )
}
