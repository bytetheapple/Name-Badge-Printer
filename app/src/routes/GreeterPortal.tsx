import { useCallback, useEffect, useRef, useState } from 'react'
import { useOrg } from '../lib/org'
import { greeterFeed, greeterCheckIn, fetchVisitorImage, type GreeterVisitor } from '../lib/greeter'

const REFRESH_MS = 8000

// One fetch per image for the life of the page: a blob URL cached by entry+kind,
// so the 8-second refresh and the tap-through never re-hit Drive for an image we
// already have. Object URLs live for the page's lifetime (a desk screen).
const imageCache = new Map<string, Promise<string | null>>()
function cachedImage(entryId: string, kind: 'selfie' | 'license') {
  const key = `${entryId}:${kind}`
  let p = imageCache.get(key)
  if (!p) {
    p = fetchVisitorImage(entryId, kind)
    imageCache.set(key, p)
  }
  return p
}

function VisitorImage({
  entryId,
  kind,
  available,
  big,
}: {
  entryId: string
  kind: 'selfie' | 'license'
  available: boolean
  big?: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(available)
  useEffect(() => {
    if (!available) {
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    void cachedImage(entryId, kind).then((u) => {
      if (active) {
        setUrl(u)
        setLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [entryId, kind, available])

  const cls = `gp-img${big ? ' gp-img-big' : ''}`
  const noun = kind === 'selfie' ? 'photo' : 'license'
  if (!available) return <div className={`${cls} gp-img-none`}>No {noun}</div>
  if (loading)
    return (
      <div className={`${cls} gp-img-loading`}>
        <span className="spinner-dot" aria-hidden="true" />
      </div>
    )
  if (!url) return <div className={`${cls} gp-img-none`}>Unavailable</div>
  return <img className={cls} src={url} alt={`Visitor ${noun}`} />
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  return `${hrs} hr${hrs > 1 ? 's' : ''} ago`
}

export default function GreeterPortal() {
  const { orgId } = useOrg()
  const [visitors, setVisitors] = useState<GreeterVisitor[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    if (!orgId) return
    try {
      const { visitors } = await greeterFeed(orgId)
      setVisitors(visitors)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoaded(true)
    }
  }, [orgId])

  useEffect(() => {
    void load()
    timer.current = window.setInterval(() => void load(), REFRESH_MS)
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [load])

  async function toggleCheckIn(entryId: string, next: boolean) {
    setVisitors((vs) => vs.map((v) => (v.id === entryId ? { ...v, checked_in: next } : v)))
    try {
      await greeterCheckIn(entryId, next)
    } catch (e) {
      setVisitors((vs) => vs.map((v) => (v.id === entryId ? { ...v, checked_in: !next } : v)))
      setError((e as Error).message)
    }
  }

  const index = selected ? visitors.findIndex((v) => v.id === selected) : -1
  const current = index >= 0 ? visitors[index] : null

  // ---- zoom-in view: a full-screen, mobile-first overlay --------------------
  if (current) {
    return (
      <div className="gp-zoom" role="dialog" aria-modal="true">
        <div className="gp-zoom-top">
          <div className="gp-zoom-controls">
            <button className="secondary btn-sm" onClick={() => setSelected(null)}>
              ← Back
            </button>
            <div className="gp-nav-arrows">
              <button
                className="secondary btn-sm"
                disabled={index <= 0}
                onClick={() => setSelected(visitors[index - 1]?.id ?? null)}
              >
                ‹ Prev
              </button>
              <button
                className="secondary btn-sm"
                disabled={index >= visitors.length - 1}
                onClick={() => setSelected(visitors[index + 1]?.id ?? null)}
              >
                Next ›
              </button>
            </div>
          </div>
          <h1 className="gp-zoom-name">
            {current.first_name} {current.last_name}
          </h1>
        </div>

        <div className="gp-zoom-body">
          <VisitorImage entryId={current.id} kind="selfie" available={current.has_selfie} big />
          <VisitorImage entryId={current.id} kind="license" available={current.has_license} big />
        </div>

        <div className="gp-zoom-foot">
          <label className="gp-checkin">
            <input
              type="checkbox"
              checked={current.checked_in}
              onChange={(e) => void toggleCheckIn(current.id, e.target.checked)}
            />
            Confirmed
          </label>
        </div>
      </div>
    )
  }

  // ---- list view ------------------------------------------------------------
  return (
    <>
      <h1>Greeter desk</h1>
      <p className="muted">Recent guest sign-ins — tap a guest to verify before handing out a badge.</p>

      {error && <div className="error">{error}</div>}

      {loaded && visitors.length === 0 && !error && (
        <p className="muted gp-empty">No recent sign-ins yet.</p>
      )}

      <div className="gp-list">
        {visitors.map((v) => (
          <button key={v.id} className="gp-row" onClick={() => setSelected(v.id)}>
            <div className="gp-thumbs">
              <VisitorImage entryId={v.id} kind="selfie" available={v.has_selfie} />
              <VisitorImage entryId={v.id} kind="license" available={v.has_license} />
            </div>
            <div className="gp-row-text">
              <span className="gp-row-name">
                {v.first_name} {v.last_name}
              </span>
              <span className="muted small">{timeAgo(v.created_at)}</span>
            </div>
            {v.checked_in && <span className="gp-checked">✓ Checked in</span>}
          </button>
        ))}
      </div>
    </>
  )
}
