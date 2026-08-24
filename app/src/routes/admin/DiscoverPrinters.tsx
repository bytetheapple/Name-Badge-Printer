import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import type { DiscoveredPrinter, Printer } from '../../lib/types'

const COLUMNS = 'id, org_id, ip, mac, model, node_name, first_seen, last_seen'
const POLL_MS = 3000
const GIVE_UP_MS = 90_000

/**
 * Find printers on the site's network and add one.
 *
 * The admin cannot look for printers itself — they are on the customer's LAN,
 * which this page (HTTPS, and blocked by the absence of CORS on the printer)
 * cannot reach. So it asks the bridge, which is on that network, and waits for
 * what it reports back.
 */
export default function DiscoverPrinters({
  printers,
  onAdded,
}: {
  /** Already configured, so a scan can say which of its results are old news. */
  printers: Printer[]
  onAdded: () => void
}) {
  const { orgId, isAdmin } = useOrg()
  const [found, setFound] = useState<DiscoveredPrinter[]>([])
  const [scanning, setScanning] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const timers = useRef<number[]>([])

  const load = useCallback(async () => {
    if (!orgId) return [] as DiscoveredPrinter[]
    const { data, error } = await supabase
      .from('discovered_printers')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .order('last_seen', { ascending: false })
    if (error) {
      setError(error.message)
      return []
    }
    const rows = (data ?? []) as DiscoveredPrinter[]
    setFound(rows)
    return rows
  }, [orgId])

  useEffect(() => {
    void load()
    // Capture the array now: cleanup runs after unmount, when reading
    // `timers.current` would be reaching for a ref that may have moved on.
    const pending = timers.current
    return () => pending.forEach((t) => window.clearTimeout(t))
  }, [load])

  async function scan() {
    if (!orgId) return
    setScanning(true)
    setError(null)
    setNotice(null)

    // The bridge picks this up on its next poll, within a couple of seconds.
    const { error } = await supabase
      .from('printer_status')
      .update({ scan_requested_at: new Date().toISOString() })
      .eq('org_id', orgId)
    if (error) {
      setScanning(false)
      setError(`Could not ask the print server to scan: ${error.message}`)
      return
    }

    const started = Date.now()
    const before = found.length
    const tick = async () => {
      const rows = await load()
      if (rows.length > before) {
        setScanning(false)
        setNotice(`Found ${rows.length} printer${rows.length === 1 ? '' : 's'}.`)
        return
      }
      if (Date.now() - started > GIVE_UP_MS) {
        setScanning(false)
        setNotice(
          rows.length
            ? 'No new printers this time.'
            : 'Nothing found. Is the print server running, and on the same network as the printer?',
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
    if (error) {
      setError(error.message)
      setAdding(null)
      return
    }
    // The row stays: it is a record of what is on the network, and an added
    // printer still is. It flips to "already active" immediately, which is
    // clearer feedback than the row disappearing.
    setAdding(null)
    setNotice(`Added ${p.ip}. Give it a name and check the layout below.`)
    await load()
    onAdded()
  }

  /** The configured printer at this address, if there is one. */
  const alreadyAdded = (p: DiscoveredPrinter) =>
    printers.find((existing) => existing.printer_ip === p.ip)

  if (!isAdmin) return null

  return (
    <section className="card">
      <h2>Find a printer</h2>
      <p className="muted small">
        Asks the print server to look for label printers on the network it is connected to. Only it
        can see them — this page cannot reach the local network directly. Other devices that answer
        on the network, such as office printers, are left out.
      </p>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <button type="button" onClick={() => void scan()} disabled={scanning}>
        {scanning ? 'Scanning…' : 'Scan for printers'}
      </button>
      {scanning && (
        <p className="muted small" style={{ marginTop: 8 }}>
          Waiting for the print server to report back. This takes a few seconds — longer if it is
          busy printing.
        </p>
      )}

      {found.length > 0 && (
        <table className="table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Address</th>
              <th>Model</th>
              <th>Seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {found.map((p) => (
              <tr key={p.id}>
                <td>
                  <code>{p.ip}</code>
                  {p.mac && <div className="muted small">{p.mac}</div>}
                </td>
                <td>{p.model ?? 'unknown'}</td>
                <td className="muted small">{new Date(p.last_seen).toLocaleTimeString()}</td>
                <td>
                  {alreadyAdded(p) ? (
                    <span className="muted small">
                      Already active as <strong>{alreadyAdded(p)!.name}</strong>
                    </span>
                  ) : (
                    <button
                      className="secondary btn-sm"
                      disabled={adding === p.id}
                      onClick={() => void add(p)}
                    >
                      {adding === p.id ? 'Adding…' : 'Add'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
