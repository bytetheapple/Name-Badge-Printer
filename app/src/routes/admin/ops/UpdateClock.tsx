import { useEffect, useState } from 'react'

/**
 * How long until a print server next checks for a new version.
 *
 * The updater runs on a systemd timer, about once a minute (OnUnitActiveSec=1min
 * plus up to 15s of jitter), and each run records the moment it asked. This
 * draws a ring that is full just after a check and empties as the next one
 * approaches — so after setting a fleet release you can watch it come due on
 * each device rather than wondering whether anything is happening.
 *
 * A device that has not asked in well over a period is drawn hollow: its update
 * path is not reporting, which is a fault worth seeing on its own.
 */

//: The nominal seconds between checks — the timer's period. The ring is scaled
//: to this; the actual gap is a little longer with jitter, which the overdue
//: threshold allows for.
const PERIOD = 60
//: Past this, a check is late enough to mean the device is not reporting rather
//: than merely between checks. Period, plus the jitter, plus a margin.
const OVERDUE = 105

export default function UpdateClock({ at }: { at: string | null }) {
  // Tick so the ring empties smoothly between data reloads.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  const t = at ? new Date(at).getTime() : null
  const elapsed = t === null ? null : Math.max(0, (Date.now() - t) / 1000)
  const overdue = elapsed === null || elapsed > OVERDUE
  const fraction = overdue ? 0 : Math.max(0, Math.min(1, 1 - elapsed! / PERIOD))

  const r = 7
  const circumference = 2 * Math.PI * r

  const title =
    elapsed === null
      ? 'Has not reported an update check yet.'
      : overdue
        ? `Last checked for an update ${describe(elapsed)} ago — not currently reporting.`
        : `Checks for a new version about once a minute. Last checked ${describe(elapsed)} ago; ` +
          `next in about ${Math.max(0, Math.round(PERIOD - elapsed))}s.`

  return (
    <span
      title={title}
      aria-label={title}
      style={{ display: 'inline-flex', alignItems: 'center' }}
    >
      <svg width="27" height="27" viewBox="0 0 20 20" role="img">
        <circle cx="10" cy="10" r={r} fill="none" stroke="var(--border, #d1d5db)" strokeWidth="2.5" />
        {!overdue && (
          <circle
            cx="10"
            cy="10"
            r={r}
            fill="none"
            stroke="var(--accent, #2563eb)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${fraction * circumference} ${circumference}`}
            transform="rotate(-90 10 10)"
          />
        )}
      </svg>
    </span>
  )
}

/** "45s" / "3 min" / "2 h" — the coarseness people actually read a gap at. */
function describe(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min`
  return `${Math.round(mins / 60)} h`
}
