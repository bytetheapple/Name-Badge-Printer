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

type Level = 'red' | 'yellow' | 'green'

// How each match level reads on the row and in the alert. Red/yellow mean
// "verify before admitting"; green means "probably a different person, but
// here's the data to confirm". Never an automatic block.
const LEVEL_UI: Record<Level, { badge: string; alertTitle: string }> = {
  // `badge` is the short list-row pill (room is tight beside two thumbnails);
  // `alertTitle` is the full heading in the zoom view.
  red: { badge: '⚠ Prohibited', alertTitle: '⚠ Prohibited visitor' },
  yellow: { badge: '⚠ Possible', alertTitle: '⚠ Possible match — verify' },
  green: { badge: 'Name on list', alertTitle: 'Name on the list — likely a different person' },
}

/** Plain-language reason, e.g. "phone number and email address", or "name". */
function matchedOnText(on: string[]): string {
  const words = on.map((k) =>
    k === 'phone' ? 'phone number' : k === 'email' ? 'email address' : 'name',
  )
  if (words.length <= 1) return words[0] ?? 'name'
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

function alertText(level: Level, on: string[]): string {
  if (level === 'red')
    return `The ${matchedOnText(on)} on this sign-in matches the prohibited-visitors list. Verify against the photo and licence — do not hand over a badge if this is the listed person.`
  if (level === 'yellow')
    return 'This name matches the prohibited-visitors list and nothing on the sign-in rules it out. Verify identity against the photo and licence before admitting.'
  return 'This name matches the list, but a phone number or email the guest gave does not match the listed one — so this is probably someone else. Check the details below to be sure.'
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
        {/* Flat banner: a grid places Back, the name and the nav arrows. On a
            phone/portrait it's Back + arrows on one row with the name below; in
            landscape the name is centred with the arrows centred beneath it. */}
        <div className="gp-zoom-top">
          <button className="gp-zoom-back secondary btn-sm" onClick={() => setSelected(null)}>
            ← Back
          </button>
          <div className="gp-nav-arrows">
            {/* The feed is newest-first, so the sign-in chronologically BEFORE
                this one (older) sits at the next index, and the one after
                (newer) at the previous index. */}
            <button
              className="secondary btn-sm"
              disabled={index >= visitors.length - 1}
              onClick={() => setSelected(visitors[index + 1]?.id ?? null)}
            >
              ‹ Previous
            </button>
            <button
              className="secondary btn-sm"
              disabled={index <= 0}
              onClick={() => setSelected(visitors[index - 1]?.id ?? null)}
            >
              Next ›
            </button>
          </div>
          <h1 className="gp-zoom-name">
            {current.first_name} {current.last_name}
          </h1>
        </div>

        <div className="gp-zoom-body">
          {current.prohibited_level && current.prohibited_info && (
            <div className={`gp-alert gp-alert-${current.prohibited_level}`}>
              <div className="gp-alert-title">{LEVEL_UI[current.prohibited_level].alertTitle}</div>
              <p className="gp-alert-text">
                {alertText(current.prohibited_level, current.prohibited_info.matched_on)}
              </p>
              <dl className="gp-alert-facts">
                {current.prohibited_info.matched_name && (
                  <>
                    <dt>Listed name</dt>
                    <dd>{current.prohibited_info.matched_name}</dd>
                  </>
                )}
                {current.prohibited_info.dl_number && (
                  <>
                    <dt>License #</dt>
                    <dd>{current.prohibited_info.dl_number}</dd>
                  </>
                )}
                {current.prohibited_info.birthdate && (
                  <>
                    <dt>Birthdate</dt>
                    <dd>{current.prohibited_info.birthdate}</dd>
                  </>
                )}
                {current.prohibited_info.phone && (
                  <>
                    <dt>Listed phone</dt>
                    <dd>{current.prohibited_info.phone}</dd>
                  </>
                )}
                {current.prohibited_info.email && (
                  <>
                    <dt>Listed email</dt>
                    <dd>{current.prohibited_info.email}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
          <div className="gp-zoom-media">
            <VisitorImage entryId={current.id} kind="selfie" available={current.has_selfie} big />
            <VisitorImage entryId={current.id} kind="license" available={current.has_license} big />
          </div>
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
          <button
            key={v.id}
            className={`gp-row${v.prohibited_level ? ` gp-row-${v.prohibited_level}` : ''}`}
            onClick={() => setSelected(v.id)}
          >
            <div className="gp-thumbs">
              <VisitorImage entryId={v.id} kind="selfie" available={v.has_selfie} />
              <VisitorImage entryId={v.id} kind="license" available={v.has_license} />
            </div>
            <div className="gp-row-text">
              <span className="gp-row-name">
                {v.first_name} {v.last_name}
              </span>
              <span className="gp-row-time muted small">{timeAgo(v.created_at)}</span>
              {/* The flag sits under the name, where it has room to fit — on the
                  right it collided with the name beside two thumbnails. */}
              {v.prohibited_level && (
                <span className={`gp-prohibited-badge gp-badge-${v.prohibited_level}`}>
                  {LEVEL_UI[v.prohibited_level].badge}
                </span>
              )}
            </div>
            {/* A bold green check in the corner, not a full-width pill that
                crowds the name and wraps the time on a narrow screen. */}
            {v.checked_in && (
              <span className="gp-check-corner" aria-label="Checked in" title="Checked in">
                ✓
              </span>
            )}
          </button>
        ))}
      </div>
    </>
  )
}
