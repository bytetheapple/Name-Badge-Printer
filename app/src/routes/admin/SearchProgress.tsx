import { useEffect, useState } from 'react'
import type { Printer } from '../../lib/types'

/**
 * What the print server is doing about a printer that has gone missing.
 *
 * A moved printer used to show only "Unreachable", as if nothing were being
 * done — while the bridge was in fact sweeping for it in the background on a
 * backoff. This says so: since when, how long ago it last looked, and when it
 * will look next, so a dead-looking printer reads as one being recovered rather
 * than one nobody is coming for.
 *
 * Renders nothing unless the printer is actually unreachable and a search is
 * scheduled — the bridge clears these the moment the printer answers.
 */
export default function SearchProgress({ printer }: { printer: Printer }) {
  // Tick so "2 min ago" and "in 6 min" keep advancing on a card left open,
  // without depending on the parent to re-render. Minute granularity, so
  // every half-minute is plenty.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30000)
    return () => window.clearInterval(id)
  }, [])

  if (printer.reachable !== false || !printer.searching_since) return null

  const since = new Date(printer.searching_since)
  const sinceLabel =
    `${since.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` +
    ` on ${since.toLocaleDateString()}`

  const now = Date.now()

  const last = printer.last_search_at ? new Date(printer.last_search_at).getTime() : null
  // Nothing to say until the first sweep has run — there is a short grace after
  // a printer drops before the first look, and "0 min ago" during it is a small
  // lie.
  const lastLabel =
    last === null
      ? ''
      : ` Last search ${minsAgo(now - last)}.`

  const next = printer.next_search_at ? new Date(printer.next_search_at).getTime() : null
  const nextLabel =
    next === null
      ? ''
      : ` Next search ${minsUntil(next - now)}.`

  return (
    <div className="locate-status searching">
      <span className="spinner-dot" aria-hidden="true" />
      <span>
        Searching for this printer since {sinceLabel}.{lastLabel}
        {nextLabel}
      </span>
    </div>
  )
}

/** "just now" / "1 min ago" / "12 min ago" for a gap in milliseconds. */
function minsAgo(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000))
  if (mins < 1) return 'was just now'
  return `was ${mins} min ago`
}

/** "any moment" / "in 1 min" / "in 6 min" for a gap in milliseconds. A search
 *  that is overdue — the worker is busy on another printer — reads as imminent
 *  rather than as a negative number. */
function minsUntil(ms: number): string {
  const mins = Math.round(ms / 60000)
  if (mins <= 0) return 'any moment'
  return `in ${mins} min`
}
