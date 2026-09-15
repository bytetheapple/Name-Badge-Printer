import { useEffect, useState } from 'react'

/**
 * A pending update, counting down beside a server that is behind the release.
 *
 * The ring is full the moment a release is set and empties over about the
 * updater's one-minute check interval, so it reads as "this server should pull
 * the release around now". It is deliberately anchored to when the release was
 * set, not to the device's last check: the updater touches that every minute,
 * and anchoring there refilled the ring on each routine poll — a reset right
 * before the version flipped. Anchored to the release, it counts down once and
 * then sits blank until the server reports the new version, at which point the
 * caller stops rendering it and it vanishes.
 *
 * The tooltip carries the live detail — the target, and how long since the
 * server actually checked in — so an empty ring that is not moving can still be
 * told apart from a server that has gone quiet.
 */

//: The updater's check interval. The ring is scaled to it; a little jitter and
//: the restart itself mean the version often flips a touch after the ring is
//: already empty, which is why empty holds rather than meaning "late".
const PERIOD = 60

export default function UpdateClock({
  since,
  lastCheck,
  target,
}: {
  /** When the release was set — the stable anchor the countdown runs from. */
  since: string | null
  /** When the device last asked for its version, for the tooltip only. */
  lastCheck: string | null
  /** The release it is converging on, for the tooltip only. */
  target: string | null
}) {
  // Tick so the ring empties smoothly between the table's data reloads.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  const start = since ? new Date(since).getTime() : null
  const elapsed = start === null ? null : Math.max(0, (Date.now() - start) / 1000)
  const fraction = elapsed === null ? 1 : Math.max(0, Math.min(1, 1 - elapsed / PERIOD))

  const r = 7
  const circumference = 2 * Math.PI * r

  const lastElapsed =
    lastCheck === null ? null : Math.max(0, (Date.now() - new Date(lastCheck).getTime()) / 1000)
  const title =
    `Update${target ? ` to ${target}` : ''} pending. ` +
    (lastElapsed === null
      ? 'Has not checked in yet.'
      : `Last checked ${describe(lastElapsed)} ago.`)

  return (
    <span
      title={title}
      aria-label={title}
      style={{ display: 'inline-flex', alignItems: 'center' }}
    >
      <svg width="18" height="18" viewBox="0 0 20 20" role="img">
        <circle cx="10" cy="10" r={r} fill="none" stroke="var(--border, #d1d5db)" strokeWidth="2.5" />
        {fraction > 0 && (
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
