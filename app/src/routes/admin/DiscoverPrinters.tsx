import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import type { DiscoveredPrinter, Printer } from '../../lib/types'

const COLUMNS = 'id, org_id, ip, mac, model, node_name, first_seen, last_seen'
const POLL_MS = 2000
const GIVE_UP_MS = 90_000

/**
 * Scan the site's network for label printers and add one.
 *
 * The admin cannot look for printers itself — they are on the customer's LAN,
 * which this page cannot reach. It asks the print server, which can, and waits
 * for what it reports back.
 *
 * Nothing is shown until a scan has run. A previous scan's results say nothing
 * about what is on the network now — a printer found last week may be long
 * gone — so showing them would invite adding something that no longer exists.
 */
export default function DiscoverPrinters({
  printers,
  onAdded,
}: {
  /** Already configured, so the scan can leave them out. */
  printers: Printer[]
  onAdded: () => void
}) {
  const { orgId, isAdmin } = useOrg()
  const [found, setFound] = useState<DiscoveredPrinter[]>([])
  const [scanned, setScanned] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timers = useRef<number[]>([])

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((t) => window.clearTimeout(t))
  }, [])

  const load = useCallback(async () => {
    if (!orgId) return [] as DiscoveredPrinter[]
    const { data, error } = await supabase
      .from('discovered_printers')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .order('ip')
    if (error) {
      setError(error.message)
      return []
    }
    const rows = (data ?? []) as DiscoveredPrinter[]
    setFound(rows)
    return rows
  }, [orgId])

  async function scan() {
    if (!orgId) return
    setScanning(true)
    setScanned(false)
    setError(null)
    setFound([])

    // Clear the last scan's results: this scan's answer is the only one worth
    // showing, and a stale row is worse than none.
    await supabase.from('discovered_printers').delete().eq('org_id', orgId)

    const requestedAt = new Date().toISOString()
    const { error } = await supabase
      .from('printer_status')
      .update({ scan_requested_at: requestedAt })
      .eq('org_id', orgId)
    if (error) {
      setScanning(false)
      setError(`Could not ask the print server to scan: ${error.message}`)
      return
    }

    const started = Date.now()
    const tick = async () => {
      // The print server records when it finished, so "found nothing" is a real
      // answer rather than something to wait out.
      const { data } = await supabase
        .from('printer_status')
        .select('scan_completed_at')
        .eq('org_id', orgId)
        .maybeSingle()
      if (data?.scan_completed_at && new Date(data.scan_completed_at) > new Date(requestedAt)) {
        await load()
        setScanning(false)
        setScanned(true)
        return
      }
      if (Date.now() - started > GIVE_UP_MS) {
        setScanning(false)
        setError(
          'The print server did not answer. Is it running, and on the same network as the printer?',
        )
        return
      }
      timers.current.push(window.setTimeout(() => void tick(), POLL_MS))
    }
    timers.current.push(window.setTimeout(() => void tick(), POLL_MS))
  }

  async function add(p: DiscoveredPrinter) {
    if (!orgId) return
    setAdding(p.id)
    setError(null)
    const { error } = await supabase.from('printers').insert({
      org_id: orgId,
      name: p.model?.replace(/^Brother\s+/i, '') || 'New Printer',
      printer_ip: p.ip,
      port: 9100,
    })
    setAdding(null)
    if (error) {
      setError(error.message)
      return
    }
    onAdded() // the row drops out of the list, since it is configured now
  }

  if (!isAdmin) return null

  // Only what is not already set up: this is a list of printers to add.
  const configured = new Set(printers.map((p) => (p.printer_ip ?? '').trim()))
  const newPrinters = found.filter((p) => !configured.has(p.ip.trim()))

  return (
    <div className="scan-block">
      <button type="button" onClick={() => void scan()} disabled={scanning}>
        {scanning ? 'Scanning…' : 'Scan for New Printers'}
      </button>

      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}

      {scanned && newPrinters.length === 0 && !error && (
        <p className="muted" style={{ marginTop: 16 }}>
          No new printers found.
        </p>
      )}

      {newPrinters.length > 0 && (
        <table className="data" style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>IP Address</th>
              <th>MAC Address</th>
              <th>Model</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {newPrinters.map((p) => (
              <tr key={p.id}>
                <td>
                  <code>{p.ip}</code>
                </td>
                <td>
                  <code>{p.mac ?? '—'}</code>
                </td>
                <td>{p.model ?? 'unknown'}</td>
                <td>
                  <button
                    className="secondary btn-sm"
                    disabled={adding === p.id}
                    onClick={() => void add(p)}
                  >
                    {adding === p.id ? 'Adding…' : 'Add printer'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
