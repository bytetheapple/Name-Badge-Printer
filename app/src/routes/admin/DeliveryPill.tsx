import { useState } from 'react'
import { supabase } from '../../lib/supabase'

export interface Delivery {
  entry_id: string
  integration_id: string | null
  name: string
  kind: string
  status: 'pending' | 'sent' | 'failed' | 'skipped'
  error: string | null
  attempted_at: string | null
}

/** Which Edge Function re-sends to a destination of this kind. Selfies are
 *  absent on purpose: the photo only exists in the kiosk's browser at capture
 *  time, so there is nothing left here to send again. */
const RESENDER: Record<string, string> = {
  google_form: 'google-sync',
  shulcloud: 'shulcloud-sync',
  // Safe to press twice: the sheet sync updates the row it already wrote
  // rather than appending the same visitor again.
  google_sheet: 'google-sheet-sync',
}

/** The worst thing that happened, which is what the closed pill should show —
 *  a green summary hiding one failed destination is the whole problem. */
function summarise(rows: Delivery[]): { status: string; label: string } {
  if (!rows.length) return { status: 'skipped', label: 'nowhere' }
  const sent = rows.filter((r) => r.status === 'sent').length
  const failed = rows.some((r) => r.status === 'failed')
  const pending = rows.some((r) => r.status === 'pending')
  const status = failed ? 'failed' : pending ? 'pending' : sent ? 'sent' : 'skipped'
  return { status, label: `${sent}/${rows.length} sent` }
}

/**
 * Where one sign-in went, and what happened at each destination.
 *
 * A single status per kind could not describe two ShulCloud forms where one
 * took the sign-in and the other did not — and that split is exactly the case
 * someone has to act on, so it is the case the summary is built around.
 *
 * <details> rather than component state: the browser already knows how to open
 * and close a disclosure, and it stays open across the table's re-render when
 * a resend finishes.
 */
export default function DeliveryPill({
  rows,
  onChanged,
}: {
  rows: Delivery[]
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const { status, label } = summarise(rows)

  async function resend(d: Delivery) {
    const fn = d.integration_id ? RESENDER[d.kind] : undefined
    if (!fn || !d.integration_id) return
    setBusy(d.integration_id)
    setMsg(null)
    const { data, error } = await supabase.functions.invoke(fn, {
      body: { entry_id: d.entry_id, integration_id: d.integration_id },
    })
    setBusy(null)
    setMsg(error || !data?.ok ? (data?.error ?? error?.message ?? 'Failed') : `Sent to ${d.name}.`)
    onChanged()
  }

  return (
    <details className="delivery">
      <summary>
        <span className={`pill pill-sync-${status}`}>{label}</span>
      </summary>
      <div className="delivery-detail">
        {!rows.length && <p className="muted small">This sign-in was not sent anywhere.</p>}
        {msg && <p className="muted small">{msg}</p>}
        {rows.map((d) => (
          <div className="delivery-row" key={`${d.entry_id}:${d.integration_id}`}>
            <span className={`pill pill-sync-${d.status}`}>{d.status}</span>
            <span className="delivery-name" title={d.error ?? undefined}>
              {d.name}
              {d.error && <span className="muted small"> · {d.error}</span>}
            </span>
            {/* Offered whatever the outcome: re-sending something that already
                arrived is a normal thing to want after fixing a form. */}
            {d.integration_id && RESENDER[d.kind] && (
              <button
                className="linkish btn-sm"
                disabled={busy === d.integration_id}
                onClick={() => void resend(d)}
                title={`Send to ${d.name} again`}
              >
                {busy === d.integration_id ? '…' : 'Resend'}
              </button>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}
