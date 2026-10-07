import { useCallback, useEffect, useRef, useState } from 'react'
import { useOrg } from '../lib/org'
import { greeterFeed, fetchVisitorImage, type GreeterVisitor } from '../lib/greeter'

const REFRESH_MS = 8000

// One fetch per image for the life of the page: a blob URL cached by entry+kind,
// so the 8-second refresh and the tap-through never re-hit Drive for an image we
// already have. Object URLs are left to the page's lifetime (a desk screen),
// which is simpler than reference-counting a handful of small images.
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
  const { orgId, isGreeter, isAdmin, loading: orgLoading } = useOrg()
  const [orgName, setOrgName] = useState<string | null>(null)
  const [visitors, setVisitors] = useState<GreeterVisitor[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    if (!orgId) return
    try {
      const { org_name, visitors } = await greeterFeed(orgId)
      setOrgName(org_name)
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

  if (orgLoading) return <main className="page" />
  if (!isGreeter && !isAdmin) {
    return (
      <main className="page">
        <h1>Greeter desk</h1>
        <p className="muted">This page is for the greeter desk.</p>
      </main>
    )
  }

  const current = visitors.find((v) => v.id === selected) ?? null

  // ---- detail view ----------------------------------------------------------
  if (current) {
    return (
      <main className="page gp-detail">
        <button className="secondary gp-back" onClick={() => setSelected(null)}>
          ← Back to list
        </button>
        <h1 className="gp-name">
          {current.first_name} {current.last_name}
        </h1>
        <div className="gp-detail-images">
          <div className="gp-detail-block">
            <div className="gp-label">Selfie</div>
            <VisitorImage entryId={current.id} kind="selfie" available={current.has_selfie} big />
          </div>
          <div className="gp-detail-block">
            <div className="gp-label">Driver's license</div>
            <VisitorImage entryId={current.id} kind="license" available={current.has_license} big />
          </div>
        </div>
        <p className="muted small">Signed in {timeAgo(current.created_at)}.</p>
      </main>
    )
  }

  // ---- list view ------------------------------------------------------------
  return (
    <main className="page gp-list-page">
      <div className="gp-head">
        <h1>{orgName ?? 'Greeter desk'}</h1>
        <span className="muted small">Recent guest sign-ins</span>
      </div>

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
          </button>
        ))}
      </div>
    </main>
  )
}
