import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../lib/supabase'

/**
 * A print server's connectivity history.
 *
 * The console's "offline" flag is a 15-second freshness heuristic — it flickers,
 * and cannot tell a real outage from a brief lapse while the bridge was busy
 * printing. This shows the actual record: a device_outages row is written (by a
 * trigger on pi_devices.last_seen) each time a server recovers from a gap longer
 * than a couple of minutes, so what shows here is real drops, not flickers.
 *
 * An outage still in progress has not been recorded yet — it has not ended — so
 * the current gap is derived here from the device's last_seen.
 */

//: A gap shorter than this is not a drop — it matches the trigger's threshold,
//: and sits above the updater's ~60s check-in so a healthy server never reads
//: as disconnected.
const DROP_SECONDS = 120

type Device = {
  id: string
  serial: string
  customer: string | null
  last_seen: string | null
  monitoring_since: string | null
}
type Outage = { started_at: string; ended_at: string; seconds: number }

type Window = 'hour' | 'day' | 'week'
const WINDOW_MS: Record<Window, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
}
const WINDOW_LABEL: Record<Window, string> = { hour: 'Hour', day: 'Day', week: 'Week' }

/** An interval in ms-since-epoch, already clipped to the window. */
type Span = { start: number; end: number; ongoing: boolean }

export default function OpsConnectivity() {
  const [devices, setDevices] = useState<Device[]>([])
  const [selected, setSelected] = useState<string>('')
  const [outages, setOutages] = useState<Outage[]>([])
  const [range, setRange] = useState<Window>('day')
  const [loading, setLoading] = useState(true)
  //: A ticking clock so the current gap and the "now" edge advance on a page
  //: left open, without re-reading the database every second.
  const [now, setNow] = useState(() => Date.now())

  const loadDevices = useCallback(async () => {
    const { data } = await supabase
      .from('pi_devices')
      .select('id, serial, customer, last_seen, monitoring_since')
      .order('customer', { ascending: true, nullsFirst: false })
    const rows = (data ?? []) as Device[]
    setDevices(rows)
    setSelected((s) => s || rows[0]?.id || '')
    setLoading(false)
  }, [])

  const loadOutages = useCallback(async () => {
    if (!selected) {
      setOutages([])
      return
    }
    const since = new Date(Date.now() - WINDOW_MS.week).toISOString()
    const { data } = await supabase
      .from('device_outages')
      .select('started_at, ended_at, seconds')
      .eq('device_id', selected)
      .gte('ended_at', since)
      .order('ended_at', { ascending: false })
    setOutages((data ?? []) as Outage[])
  }, [selected])

  useEffect(() => {
    void loadDevices()
  }, [loadDevices])
  useEffect(() => {
    void loadOutages()
  }, [loadOutages])

  // Tick the clock, and re-read the outages now and then so a drop that ended
  // since the page loaded appears without a manual refresh.
  useEffect(() => {
    const tick = range === 'hour' ? 2000 : 15000
    const t = window.setInterval(() => setNow(Date.now()), tick)
    const r = window.setInterval(() => void loadOutages(), 30000)
    return () => {
      window.clearInterval(t)
      window.clearInterval(r)
    }
  }, [range, loadOutages])

  const device = devices.find((d) => d.id === selected) ?? null
  const lastSeenMs = device?.last_seen ? new Date(device.last_seen).getTime() : null
  const currentlyDown = lastSeenMs !== null && now - lastSeenMs > DROP_SECONDS * 1000
  // Before this we have no record, so the graph paints grey and the stats count
  // only the time we were actually watching.
  const monitoringStart = device?.monitoring_since ? new Date(device.monitoring_since).getTime() : null

  // The offline spans within the current window, clipped and merged with any
  // outage still in progress (which no row records yet).
  const { spans, windowStart } = useMemo(() => {
    const windowStart = now - WINDOW_MS[range]
    const spans: Span[] = []
    for (const o of outages) {
      const s = Math.max(new Date(o.started_at).getTime(), windowStart)
      const e = Math.min(new Date(o.ended_at).getTime(), now)
      if (e > s) spans.push({ start: s, end: e, ongoing: false })
    }
    if (currentlyDown && lastSeenMs !== null) {
      spans.push({ start: Math.max(lastSeenMs, windowStart), end: now, ongoing: true })
    }
    spans.sort((a, b) => a.start - b.start)
    return { spans, windowStart }
  }, [outages, range, now, currentlyDown, lastSeenMs])

  const stats = useMemo(() => {
    const downMs = spans.reduce((sum, s) => sum + (s.end - s.start), 0)
    const longestMs = spans.reduce((m, s) => Math.max(m, s.end - s.start), 0)
    // Uptime is measured over the part of the window we were actually
    // monitoring, not the grey unknown before it — otherwise a server watched
    // for an hour would claim a week of perfect uptime.
    const monitoredStart = Math.max(windowStart, monitoringStart ?? now)
    const monitoredMs = Math.max(0, now - monitoredStart)
    return {
      drops: spans.length,
      downMinutes: Math.round(downMs / 60000),
      longestMinutes: Math.round(longestMs / 60000),
      uptime: monitoredMs > 0 ? Math.max(0, Math.min(100, ((monitoredMs - downMs) / monitoredMs) * 100)) : null,
    }
  }, [spans, windowStart, monitoringStart, now])

  if (loading) return <p className="muted">Loading…</p>

  return (
    <>
      <h1>Connectivity</h1>
      <p className="muted small">
        When each print server was disconnected, over the last 7 days. A drop is a gap longer than
        two minutes — real outages, not the brief freshness flickers the console can show.
      </p>

      {devices.length === 0 ? (
        <p className="muted">No print servers built yet.</p>
      ) : (
        <>
          <div className="release-row" style={{ alignItems: 'flex-end' }}>
            <label className="field">
              <span>Print server</span>
              <select value={selected} onChange={(e) => setSelected(e.target.value)}>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.customer ? `${d.customer} — ${d.serial}` : d.serial}
                  </option>
                ))}
              </select>
            </label>

            <div className="seg" role="group" aria-label="Time range" style={{ marginBottom: 2 }}>
              {(['hour', 'day', 'week'] as Window[]).map((w) => (
                <button
                  key={w}
                  type="button"
                  className={`seg-btn${range === w ? ' active' : ''}`}
                  aria-pressed={range === w}
                  onClick={() => setRange(w)}
                >
                  {WINDOW_LABEL[w]}
                </button>
              ))}
            </div>

            <span className="muted small" style={{ marginBottom: 6 }}>
              {device && (
                <>
                  <span
                    className={`tab-dot ${currentlyDown ? 'bad' : lastSeenMs === null ? '' : 'ok'}`}
                    aria-hidden="true"
                  />{' '}
                  {lastSeenMs === null
                    ? 'never connected'
                    : currentlyDown
                      ? `offline — last seen ${ago(now - lastSeenMs)} ago`
                      : 'online'}
                </>
              )}
            </span>
          </div>

          <div className="stat-row">
            <Stat label="Drops" value={String(stats.drops)} sub={`in the last ${range}`} />
            <Stat label="Disconnected" value={minutes(stats.downMinutes)} sub="total, this range" />
            <Stat label="Longest drop" value={minutes(stats.longestMinutes)} sub="this range" />
            <Stat
              label="Uptime"
              value={stats.uptime === null ? '—' : `${stats.uptime.toFixed(stats.uptime >= 99.95 ? 0 : 2)}%`}
              sub={stats.uptime === null ? 'not yet monitored' : 'while monitored'}
            />
          </div>

          <ConnectivityGraph
            spans={spans}
            windowStart={windowStart}
            now={now}
            range={range}
            monitoringStart={monitoringStart}
          />
        </>
      )}
    </>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      <div className="muted small">{sub}</div>
    </div>
  )
}

/** A timeline: online ground with red bands where the server was down, and a
 *  grey band over any part of the window before monitoring began. */
function ConnectivityGraph({
  spans,
  windowStart,
  now,
  range,
  monitoringStart,
}: {
  spans: Span[]
  windowStart: number
  now: number
  range: Window
  monitoringStart: number | null
}) {
  const W = 1000
  const H = 64
  const total = now - windowStart
  const x = (t: number) => ((t - windowStart) / total) * W

  // Where the record begins within this window: everything left of it is grey,
  // "no data", rather than an assumed green. Null means never monitored — the
  // whole window is grey.
  const monitoredFrom = monitoringStart === null ? now : Math.max(windowStart, monitoringStart)
  const greyW = Math.max(0, x(monitoredFrom))

  // A handful of evenly spaced time ticks along the bottom.
  const ticks: { at: number; label: string }[] = []
  const count = 6
  for (let i = 0; i <= count; i++) {
    const t = windowStart + (total * i) / count
    ticks.push({ at: t, label: tickLabel(t, range) })
  }

  return (
    <div className="graph-wrap">
      <svg viewBox={`0 0 ${W} ${H + 22}`} width="100%" role="img" aria-label="Connectivity timeline">
        {/* Online ground. */}
        <rect x="0" y="8" width={W} height={H - 16} rx="4" fill="var(--ok-bg, #d1fae5)" />
        {/* No-data ground, before monitoring began. */}
        {greyW > 0 && (
          <rect x="0" y="8" width={greyW} height={H - 16} rx="4" fill="var(--pending-bg, #f3f4f6)">
            <title>No data before {new Date(monitoredFrom).toLocaleString()} — not yet monitored</title>
          </rect>
        )}
        {/* Down bands. */}
        {spans.map((s, i) => {
          const x1 = x(s.start)
          const w = Math.max(1.5, x(s.end) - x1)
          return (
            <rect
              key={i}
              x={x1}
              y="8"
              width={w}
              height={H - 16}
              fill="var(--err-text, #991b1b)"
              opacity={s.ongoing ? 0.85 : 1}
            >
              <title>
                {new Date(s.start).toLocaleString()} → {s.ongoing ? 'now (ongoing)' : new Date(s.end).toLocaleString()} ·{' '}
                {ago(s.end - s.start)}
              </title>
            </rect>
          )
        })}
        {/* Axis ticks. */}
        {ticks.map((tk, i) => (
          <g key={i}>
            <line x1={x(tk.at)} y1={H - 6} x2={x(tk.at)} y2={H} stroke="var(--border)" />
            <text
              x={Math.min(W - 2, Math.max(2, x(tk.at)))}
              y={H + 16}
              fontSize="12"
              fill="var(--muted)"
              textAnchor={i === 0 ? 'start' : i === count ? 'end' : 'middle'}
            >
              {tk.label}
            </text>
          </g>
        ))}
      </svg>
      {spans.length === 0 && (
        <p className="muted small" style={{ marginTop: 4 }}>
          No drops in this range — connected throughout.
        </p>
      )}
    </div>
  )
}

/** "45s" / "12m" / "3h 20m" for a duration in ms. */
function ago(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** "0m" / "8m" / "2h 5m" for a whole number of minutes. */
function minutes(m: number): string {
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function tickLabel(t: number, range: Window): string {
  const d = new Date(t)
  if (range === 'hour' || range === 'day') {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { weekday: 'short' })
}
