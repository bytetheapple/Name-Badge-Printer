import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { BRIDGE_FRESH_MS } from '../../../lib/bridge'
import type { PlatformOrg, ServerNetwork } from '../../../lib/types'

/**
 * On-demand connectivity debugging for one installation.
 *
 * Diagnosing a flaky site used to mean SSH-ing to the Pi and hand-running ping
 * and `nc` loops. This arms a time-boxed diagnostics session on a chosen org:
 * the bridge then pings the cloud and each printer and connects to each
 * printer's port 9100 every few seconds, and the samples draw a live timeline
 * here — the pass/fail strips the operator used to read off a terminal, plus
 * the current network and printer status. Nothing runs unless a session is on.
 */

type PrinterLite = {
  id: string
  name: string
  location: string | null
  printer_ip: string | null
  reachable: boolean | null
  unreachable_reason: string | null
}
type StatusRow = {
  bridge_last_seen: string | null
  network: ServerNetwork | null
  diagnostics_until: string | null
}
type Sample = {
  at: string
  kind: 'cloud' | 'printer_ping' | 'printer_tcp'
  printer_id: string | null
  ok: boolean
  latency_ms: number | null
  detail: string | null
}

type Range = '5m' | '15m' | '1h'
const RANGE_MS: Record<Range, number> = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000 }
const RANGE_LABEL: Record<Range, string> = { '5m': '5 min', '15m': '15 min', '1h': '1 hour' }
const SESSION_MINUTES = [5, 10, 20, 60]

export default function OpsLinkDebug() {
  const [orgs, setOrgs] = useState<PlatformOrg[]>([])
  const [org, setOrg] = useState('')
  const [minutes, setMinutes] = useState(10)
  const [status, setStatus] = useState<StatusRow | null>(null)
  const [printers, setPrinters] = useState<PrinterLite[]>([])
  const [samples, setSamples] = useState<Sample[]>([])
  const [range, setRange] = useState<Range>('15m')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const loadOrgs = useCallback(async () => {
    const { data } = await supabase.rpc('platform_overview')
    const rows = ((data as PlatformOrg[] | null) ?? []).sort((a, b) =>
      (a.internal_name ?? a.name).localeCompare(b.internal_name ?? b.name),
    )
    setOrgs(rows)
    setOrg((o) => o || rows[0]?.org_id || '')
    setLoading(false)
  }, [])

  const loadStatus = useCallback(async (orgId: string) => {
    if (!orgId) return
    const [st, pr] = await Promise.all([
      supabase
        .from('printer_status')
        .select('bridge_last_seen, network, diagnostics_until')
        .eq('org_id', orgId)
        .maybeSingle(),
      supabase
        .from('printers')
        .select('id, name, location, printer_ip, reachable, unreachable_reason')
        .eq('org_id', orgId)
        .order('created_at', { ascending: true }),
    ])
    setStatus((st.data as StatusRow | null) ?? null)
    setPrinters(((pr.data as PrinterLite[] | null) ?? []))
  }, [])

  const loadSamples = useCallback(
    async (orgId: string, since: number) => {
      if (!orgId) return
      const { data } = await supabase
        .from('link_samples')
        .select('at, kind, printer_id, ok, latency_ms, detail')
        .eq('org_id', orgId)
        .gte('at', new Date(since).toISOString())
        .order('at', { ascending: true })
        .limit(4000)
      setSamples(((data as Sample[] | null) ?? []))
    },
    [],
  )

  useEffect(() => {
    void loadOrgs()
  }, [loadOrgs])

  useEffect(() => {
    if (!org) return
    void loadStatus(org)
    void loadSamples(org, Date.now() - RANGE_MS[range])
  }, [org, range, loadStatus, loadSamples])

  const untilMs = status?.diagnostics_until ? new Date(status.diagnostics_until).getTime() : null
  const sessionActive = untilMs !== null && untilMs > now

  // While a session is live, tick fast and re-read often so the timeline fills
  // in front of the operator; otherwise idle.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    const poll = window.setInterval(() => {
      if (!org) return
      void loadStatus(org)
      if (sessionActive) void loadSamples(org, Date.now() - RANGE_MS[range])
    }, sessionActive ? 3000 : 15000)
    return () => {
      window.clearInterval(t)
      window.clearInterval(poll)
    }
  }, [org, range, sessionActive, loadStatus, loadSamples])

  async function start() {
    if (!org) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.rpc('start_link_diagnostics', { p_org: org, p_minutes: minutes })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    void loadStatus(org)
  }

  async function stop() {
    if (!org) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.rpc('stop_link_diagnostics', { p_org: org })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    void loadStatus(org)
  }

  const bridgeLastSeen = status?.bridge_last_seen ? new Date(status.bridge_last_seen).getTime() : null
  const bridgeOnline = bridgeLastSeen !== null && now - bridgeLastSeen < BRIDGE_FRESH_MS

  const windowStart = now - RANGE_MS[range]

  // One timeline row per link: cloud, then each printer's ping and 9100.
  const rows = useMemo(() => {
    const out: { key: string; label: string; samples: Sample[] }[] = []
    out.push({ key: 'cloud', label: 'Cloud (check-in path)', samples: samples.filter((s) => s.kind === 'cloud') })
    for (const p of printers) {
      out.push({
        key: `ping:${p.id}`,
        label: `${p.name} · ping`,
        samples: samples.filter((s) => s.kind === 'printer_ping' && s.printer_id === p.id),
      })
      out.push({
        key: `tcp:${p.id}`,
        label: `${p.name} · port 9100`,
        samples: samples.filter((s) => s.kind === 'printer_tcp' && s.printer_id === p.id),
      })
    }
    return out
  }, [samples, printers])

  if (loading) return <p className="muted">Loading…</p>

  return (
    <>
      <h1>Link debug</h1>
      <p className="muted small">
        Have an installation's print server run live link tests — ping the cloud and each printer, and
        connect to each printer's port 9100 — and watch the results as a timeline. Collection runs only
        while a session is active, then stops on its own.
      </p>

      {error && <div className="error">{error}</div>}

      {orgs.length === 0 ? (
        <p className="muted">No installations yet.</p>
      ) : (
        <>
          <div className="release-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label className="field">
              <span>Installation</span>
              <select value={org} onChange={(e) => setOrg(e.target.value)}>
                {orgs.map((o) => (
                  <option key={o.org_id} value={o.org_id}>
                    {o.internal_name || o.name}
                  </option>
                ))}
              </select>
            </label>

            <span className="muted small" style={{ marginBottom: 6 }}>
              <span className={`tab-dot ${bridgeOnline ? 'ok' : 'bad'}`} aria-hidden="true" />{' '}
              {bridgeLastSeen === null
                ? 'never connected'
                : bridgeOnline
                  ? 'server online'
                  : `server offline — last seen ${timeAgo(now - bridgeLastSeen)} ago`}
            </span>
          </div>

          <div className="release-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {sessionActive ? (
              <>
                <span className="pill pill-printing">
                  Session running — {timeAgo(untilMs! - now)} left
                </span>
                <button className="secondary btn-sm" onClick={() => void stop()} disabled={busy}>
                  Stop
                </button>
              </>
            ) : (
              <>
                <label className="field">
                  <span>Run for</span>
                  <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                    {SESSION_MINUTES.map((m) => (
                      <option key={m} value={m}>
                        {m} min
                      </option>
                    ))}
                  </select>
                </label>
                <button className="primary" onClick={() => void start()} disabled={busy || !bridgeOnline}>
                  {busy ? 'Starting…' : 'Start diagnostics'}
                </button>
                {!bridgeOnline && (
                  <span className="muted small" style={{ marginBottom: 6 }}>
                    The server must be online to start a session.
                  </span>
                )}
              </>
            )}
          </div>

          {/* Current networks + printer status, same as the customer's console. */}
          {status?.network?.interfaces?.length ? (
            <div className="status-row" style={{ marginTop: 12 }}>
              {status.network.interfaces.map((i) => (
                <div key={i.name} className={`status-card ${i.ip ? 'ok' : ''}`}>
                  <div className="status-label">
                    {i.kind === 'wifi' ? 'WiFi' : i.kind === 'wired' ? 'Wired' : 'Network'}
                    {i.name !== 'default' && <span className="muted"> · {i.name}</span>}
                  </div>
                  <div className="status-value">{i.ip ?? 'No address'}</div>
                  {i.ssid && <div className="muted small">{i.ssid}{typeof i.signal === 'number' ? ` · ${i.signal}%` : ''}</div>}
                </div>
              ))}
            </div>
          ) : null}

          {printers.length > 0 && (
            <div className="status-row" style={{ marginTop: 12 }}>
              {printers.map((p) => {
                const state = !bridgeOnline ? 'bad' : p.reachable === true ? 'ok' : p.reachable === false ? 'bad' : ''
                return (
                  <div key={p.id} className={`status-card ${state}`}>
                    <div className="status-label">
                      {p.name}
                      {p.location && <span className="muted"> · {p.location}</span>}
                    </div>
                    <div className="status-value">
                      {state === 'ok' ? 'Ready' : state === 'bad' ? 'Unreachable' : 'Not checked'}
                    </div>
                    {p.printer_ip && <div className="muted small">{p.printer_ip}</div>}
                    {p.reachable === false && p.unreachable_reason && bridgeOnline && (
                      <div className="muted small">{p.unreachable_reason}</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* The timeline. */}
          <div className="release-row" style={{ alignItems: 'flex-end', marginTop: 16 }}>
            <div className="seg" role="group" aria-label="Time range">
              {(['5m', '15m', '1h'] as Range[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`seg-btn${range === r ? ' active' : ''}`}
                  aria-pressed={range === r}
                  onClick={() => setRange(r)}
                >
                  {RANGE_LABEL[r]}
                </button>
              ))}
            </div>
          </div>

          {samples.length === 0 ? (
            <p className="muted small" style={{ marginTop: 12 }}>
              {sessionActive
                ? 'Waiting for the first samples…'
                : 'No samples in this range. Start a diagnostics session to collect them.'}
            </p>
          ) : (
            <div style={{ marginTop: 12 }}>
              {rows.map((row) => (
                <div key={row.key} className="linkdebug-row">
                  <div className="linkdebug-label muted small">{row.label}</div>
                  <SampleStrip samples={row.samples} windowStart={windowStart} now={now} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}

/** A pass/fail strip for one link over the window — a tick per sample, green
 *  when it answered, red when it did not, latency in the tooltip. */
function SampleStrip({ samples, windowStart, now }: { samples: Sample[]; windowStart: number; now: number }) {
  const W = 1000
  const H = 22
  const total = Math.max(1, now - windowStart)
  const x = (t: number) => ((t - windowStart) / total) * W
  return (
    <div className="graph-wrap linkdebug-strip">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none" role="img">
        <rect x="0" y="2" width={W} height={H - 4} rx="3" fill="var(--pending-bg, #f3f4f6)" />
        {samples.map((s, i) => {
          const t = new Date(s.at).getTime()
          if (t < windowStart) return null
          return (
            <rect
              key={i}
              x={Math.max(0, x(t) - 1.25)}
              y="2"
              width="2.5"
              height={H - 4}
              fill={s.ok ? 'var(--ok-text, #065f46)' : 'var(--err-text, #991b1b)'}
            >
              <title>
                {new Date(t).toLocaleTimeString()} ·{' '}
                {s.ok
                  ? `ok${s.latency_ms != null ? ` · ${s.latency_ms} ms` : ''}`
                  : `fail${s.detail ? ` · ${s.detail}` : ''}`}
              </title>
            </rect>
          )
        })}
      </svg>
    </div>
  )
}

/** "45s" / "12m" / "3h 20m" for a duration in ms. */
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
