import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import type { FormEntry } from '../../lib/types'

type DisplayItem =
  | { kind: 'solo'; key: string; entry: FormEntry }
  | { kind: 'party'; key: string; primary: FormEntry; roster: FormEntry[] }

const familyLabel = (primary: FormEntry) =>
  `Family of ${primary.last_name ?? primary.first_name}`

const personName = (e: FormEntry) =>
  `${e.first_name} ${e.last_name ?? ''}`.trim() + (e.pronouns ? ` (${e.pronouns})` : '')

type SyncStatus = 'pending' | 'sent' | 'failed' | 'skipped'

/**
 * One destination's state, with a way to try it again.
 *
 * All three sit in a single cell rather than a column each. The table already
 * ran wide enough that its right-hand columns scrolled out of sight, which is
 * how a Resync button came to be invisible in exactly the situation it existed
 * for.
 */
function SyncPill({
  label,
  status,
  busy,
  title,
  onResync,
}: {
  label: string
  status: SyncStatus
  busy?: boolean
  /** The recorded error, shown on hover — the detail is usually the answer. */
  title?: string | null
  onResync?: () => void
}) {
  const retryable = Boolean(onResync) && (status === 'failed' || status === 'pending')
  return (
    <span className="sync-pill">
      <span className={`pill pill-sync-${status}`} title={title ?? undefined}>
        {label} {status}
      </span>
      {retryable && (
        <button className="linkish btn-sm" onClick={onResync} disabled={busy} title={`Retry ${label}`}>
          {busy ? '…' : '↻'}
        </button>
      )}
    </span>
  )
}

/**
 * A date box that looks empty when it is empty.
 *
 * Safari draws today's date into an unset `type="date"` field, so both filters
 * appear to be set to today while the list is in fact unfiltered — which reads
 * as a broken filter rather than an empty one. Chrome shows `mm/dd/yyyy` and
 * has no such problem.
 *
 * Holding it as a text box until it is touched gives the same format hint in
 * every browser, and swapping to a real date input on focus keeps the native
 * picker and validation.
 */
function DateFilter({
  value,
  min,
  max,
  onChange,
}: {
  value: string
  min?: string
  max?: string
  onChange: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const asDate = editing || value !== ''

  return (
    <input
      type={asDate ? 'date' : 'text'}
      value={value}
      min={min}
      max={max}
      placeholder="mm/dd/yyyy"
      onFocus={(e) => {
        setEditing(true)
        // The picker only opens on a real date input, which this becomes on
        // the very next render — so ask for it after that has happened.
        //
        // By then the browser may no longer count this as a user gesture, and
        // showPicker() throws NotAllowedError rather than declining quietly.
        // It is a convenience: the field is focused either way and can be
        // typed into, and a second click opens the picker.
        requestAnimationFrame(() => {
          try {
            e.target.showPicker?.()
          } catch {
            /* no gesture — the operator can click once more */
          }
        })
      }}
      onBlur={() => setEditing(false)}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** Collapse family sign-ins (rows sharing a party_id) into one line, preserving
 * fetch order. Lone entries pass through as their own row. */
function groupParties(rows: FormEntry[]): DisplayItem[] {
  const parties = new Map<string, { key: string; entries: FormEntry[] }>()
  const order: Array<{ kind: 'solo'; entry: FormEntry } | { kind: 'party'; key: string }> = []
  for (const r of rows) {
    if (!r.party_id) {
      order.push({ kind: 'solo', entry: r })
      continue
    }
    let g = parties.get(r.party_id)
    if (!g) {
      g = { key: r.party_id, entries: [] }
      parties.set(r.party_id, g)
      order.push({ kind: 'party', key: r.party_id })
    }
    g.entries.push(r)
  }
  return order.map((it) => {
    if (it.kind === 'solo') return { kind: 'solo', key: it.entry.id, entry: it.entry }
    const entries = parties.get(it.key)!.entries
    const primary = entries.find((e) => e.is_primary) ?? entries[0]
    const roster = [primary, ...entries.filter((e) => e.id !== primary.id)]
    return { kind: 'party', key: it.key, primary, roster }
  })
}

export default function EntriesTable() {
  const { orgId } = useOrg()
  const [rows, setRows] = useState<FormEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [reprinting, setReprinting] = useState<string | null>(null)
  const [resyncing, setResyncing] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    setError(null)
    let q = supabase
      .from('form_entries')
      .select('*, printer:printers(name)')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
    if (from) q = q.gte('created_at', new Date(`${from}T00:00:00`).toISOString())
    if (to) q = q.lte('created_at', new Date(`${to}T23:59:59.999`).toISOString())
    const { data, error } = await q
    if (error) setError(error.message)
    else setRows((data ?? []) as FormEntry[])
    setLoading(false)
  }, [orgId, from, to])

  useEffect(() => {
    void load()
  }, [load])

  async function reprint(entry: FormEntry) {
    setReprinting(entry.id)
    setNotice(null)
    const { error } = await supabase
      .from('print_jobs')
      .insert({
        org_id: orgId,
        entry_id: entry.id,
        printer_id: entry.printer_id,
        type: 'badge',
        status: 'queued',
      })
    setReprinting(null)
    setNotice(error ? `Reprint failed: ${error.message}` : `Queued a reprint for ${entry.first_name}.`)
  }

  async function reprintParty(item: { key: string; primary: FormEntry; roster: FormEntry[] }) {
    setReprinting(item.key)
    setNotice(null)
    const jobs = item.roster.map((e) => ({
      org_id: orgId,
      entry_id: e.id,
      printer_id: e.printer_id,
      type: 'badge',
      status: 'queued',
    }))
    const { error } = await supabase.from('print_jobs').insert(jobs)
    setReprinting(null)
    setNotice(
      error
        ? `Reprint failed: ${error.message}`
        : `Queued ${jobs.length} reprints for the ${familyLabel(item.primary)}.`,
    )
  }

  async function resync(entry: FormEntry, fn: 'google-sync' | 'shulcloud-sync') {
    setResyncing(`${fn.split('-')[0]}:${entry.id}`)
    setNotice(null)
    const { data, error } = await supabase.functions.invoke(fn, {
      body: { entry_id: entry.id },
    })
    setResyncing(null)
    const where = fn === 'google-sync' ? 'Google' : 'ShulCloud'
    if (error || !data?.ok) {
      setNotice(`${where} sync failed: ${data?.error ?? error?.message ?? 'unknown error'}`)
    } else {
      setNotice(`Synced ${entry.first_name} to ${where}.`)
    }
    void load()
  }

  async function exportXlsx() {
    const XLSX = await import('xlsx') // lazy-loaded: keeps xlsx out of the public form bundle
    // Label each family so the flat export still shows who signed in together.
    const partyLabel = new Map<string, string>()
    for (const r of rows) if (r.party_id && r.is_primary) partyLabel.set(r.party_id, familyLabel(r))
    const data = rows.map((r) => ({
      'First name': r.first_name,
      'Last name': r.last_name ?? '',
      Pronouns: r.pronouns ?? '',
      Party: r.party_id ? (partyLabel.get(r.party_id) ?? 'Family') : '',
      Type: r.visitor_type === 'member' ? 'Member' : 'Visitor',
      Printer: r.printer?.name ?? '',
      Phone: r.phone ?? '',
      Email: r.email ?? '',
      Submitted: new Date(r.created_at).toLocaleString(),
      'Google sync': r.google_sync_status,
      'ShulCloud sync': r.shulcloud_sync_status,
      Photo: r.selfie_status,
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Entries')
    XLSX.writeFile(wb, `name-badge-entries-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const items = groupParties(rows)

  return (
    <>
      <h1>Entries</h1>

      <div className="toolbar">
        <label className="field">
          From
          <DateFilter value={from} max={to || undefined} onChange={setFrom} />
        </label>
        <label className="field">
          To
          <DateFilter value={to} min={from || undefined} onChange={setTo} />
        </label>
        {(from || to) && (
          <button
            className="secondary btn-sm"
            onClick={() => {
              setFrom('')
              setTo('')
            }}
          >
            Clear
          </button>
        )}
        <span className="muted" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
          {loading
            ? '…'
            : `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}${
                from || to ? ' in range' : ''
              }`}
        </span>
        <div className="grow" />
        <button className="btn-sm" onClick={exportXlsx} disabled={rows.length === 0}>
          Export to Excel
        </button>
      </div>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>First</th>
              <th>Last</th>
              <th>Pronouns</th>
              <th>Type</th>
              <th>Syncs</th>
              <th>Printer</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Submitted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} className="empty">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty">
                  No entries{from || to ? ' in this date range' : ' yet'}.
                </td>
              </tr>
            ) : (
              items.map((it) => {
                const r = it.kind === 'solo' ? it.entry : it.primary
                const busy = it.kind === 'solo' ? reprinting === r.id : reprinting === it.key
                return (
                  <tr key={it.key}>
                    <td>
                      {it.kind === 'party' ? (
                        <>
                          <strong>{familyLabel(it.primary)}</strong>
                          <div className="party-roster muted">
                            {it.roster.map(personName).join(' · ')}
                          </div>
                        </>
                      ) : (
                        r.first_name
                      )}
                    </td>
                    <td>{it.kind === 'party' ? `${it.roster.length} people` : r.last_name ?? '—'}</td>
                    <td>{it.kind === 'party' ? '—' : r.pronouns ?? '—'}</td>
                    <td>{r.visitor_type === 'member' ? 'Member' : 'Visitor'}</td>
                    <td>
                      <div className="sync-cell">
                        <SyncPill
                          label="Google"
                          status={r.google_sync_status}
                          busy={resyncing === `google:${r.id}`}
                          onResync={() => resync(r, 'google-sync')}
                        />
                        <SyncPill
                          label="ShulCloud"
                          status={r.shulcloud_sync_status}
                          busy={resyncing === `shulcloud:${r.id}`}
                          onResync={() => resync(r, 'shulcloud-sync')}
                        />
                        {/* No resync: the photo only exists in the kiosk's
                            browser at capture time, so it cannot be sent
                            again from here. */}
                        <SyncPill label="Photo" status={r.selfie_status} title={r.selfie_error} />
                      </div>
                    </td>
                    <td>{r.printer?.name ?? '—'}</td>
                    <td>{r.phone ?? '—'}</td>
                    <td>{r.email ?? '—'}</td>
                    <td>{new Date(r.created_at).toLocaleString()}</td>
                    <td className="actions-cell">
                      <button
                        className="secondary btn-sm"
                        onClick={() => (it.kind === 'party' ? reprintParty(it) : reprint(r))}
                        disabled={busy}
                      >
                        {busy ? 'Queuing…' : it.kind === 'party' ? 'Reprint all' : 'Reprint'}
                      </button>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
        {rows.length} {rows.length === 1 ? 'entry' : 'entries'} shown.
      </p>
    </>
  )
}
