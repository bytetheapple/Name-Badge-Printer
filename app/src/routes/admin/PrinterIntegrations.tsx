import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import type { Printer } from '../../lib/types'

/** Names and switches only — what integrations_brief() returns to an admin. */
interface IntegrationBrief {
  id: string
  kind: string
  name: string
  enabled: boolean
  default_enabled: boolean
}

/** What this printer does about one integration. "default" means no opinion —
 *  it follows whatever the integration's own default says, now and if that
 *  default later changes. */
type Choice = 'default' | 'on' | 'off'

/**
 * Which destinations this particular kiosk feeds.
 *
 * The table behind this holds exceptions only: a printer with no row follows
 * the integration's default. So "Default" here is genuinely the absence of a
 * setting rather than a copy of the current one — change the default under
 * Integrations and every printer left on Default moves with it.
 */
export default function PrinterIntegrations({ printer }: { printer: Printer }) {
  const { orgId, isAdmin } = useOrg()
  const [integrations, setIntegrations] = useState<IntegrationBrief[]>([])
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    // Through a function rather than the table: integrations belong to the
    // owner, printers to an admin, and this screen needs the names without
    // the credentials behind them.
    const { data: rows, error: e1 } = await supabase.rpc('integrations_brief', { p_org: orgId })
    if (e1) setError(e1.message)
    const list = (rows ?? []) as IntegrationBrief[]
    setIntegrations(list)

    const { data: overrides } = await supabase
      .from('printer_integrations')
      .select('integration_id, enabled')
      .eq('printer_id', printer.id)
    const next: Record<string, Choice> = {}
    for (const row of list) next[row.id] = 'default'
    for (const o of overrides ?? []) {
      next[o.integration_id as string] = o.enabled ? 'on' : 'off'
    }
    setChoices(next)
    setLoading(false)
  }, [orgId, printer.id])

  useEffect(() => {
    void load()
  }, [load])

  async function choose(row: IntegrationBrief, choice: Choice) {
    if (!orgId) return
    setBusy(row.id)
    setError(null)
    setChoices((p) => ({ ...p, [row.id]: choice }))

    const { error } =
      choice === 'default'
        ? await supabase
            .from('printer_integrations')
            .delete()
            .eq('printer_id', printer.id)
            .eq('integration_id', row.id)
        : await supabase.from('printer_integrations').upsert(
            {
              printer_id: printer.id,
              integration_id: row.id,
              org_id: orgId,
              enabled: choice === 'on',
            },
            { onConflict: 'printer_id,integration_id' },
          )
    setBusy(null)
    if (error) {
      setError(error.message)
      await load()
    }
  }

  if (!isAdmin || loading) return null

  if (!integrations.length) {
    return (
      <p className="muted small">
        No integrations are set up yet. An owner can add them under Integrations, and this kiosk
        will follow whatever default they choose.
      </p>
    )
  }

  return (
    <>
      <p className="muted small">
        Where sign-ins from this kiosk are sent. <strong>Default</strong> follows the integration's
        own setting and keeps following it if that changes later.
      </p>
      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Destination</th>
              <th>Default</th>
              <th>This kiosk</th>
            </tr>
          </thead>
          <tbody>
            {integrations.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.name}
                  {/* Switched off entirely is worth saying here: the per-kiosk
                      choice is real but has nothing to act on. */}
                  {!row.enabled && <span className="muted small"> · switched off</span>}
                </td>
                <td className="muted small">{row.default_enabled ? 'On' : 'Off'}</td>
                <td>
                  <select
                    value={choices[row.id] ?? 'default'}
                    disabled={busy === row.id}
                    onChange={(e) => void choose(row, e.target.value as Choice)}
                    aria-label={`${row.name} for this kiosk`}
                  >
                    <option value="default">
                      Default ({row.default_enabled ? 'on' : 'off'})
                    </option>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
