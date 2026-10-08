import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
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
  const { orgId, isGreeter, isAdmin, loading: orgLoading } = useOrg()
  const { signOut } = useAuth()
  const navigate = useNavigate()
  const [orgName, setOrgName] = useState<string | null>(null)
  const [visitors, setVisitors] = useState<GreeterVisitor[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
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

  async function toggleCheckIn(entryId: string, next: boolean) {
    // Optimistic: reflect it at once, revert if the write fails.
    setVisitors((vs) => vs.map((v) => (v.id === entryId ? { ...v, checked_in: next } : v)))
    try {
      await greeterCheckIn(entryId, next)
    } catch (e) {
      setVisitors((vs) => vs.map((v) => (v.id === entryId ? { ...v, checked_in: !next } : v)))
      setError((e as Error).message)
    }
  }

  async function doSignOut() {
    await signOut()
    navigate('/admin/login', { replace: true })
  }

  if (orgLoading) return <main className="page" />
  if (!isGreeter && !isAdmin) {
    return (
      <main className="page">
        <h1>Greeter desk</h1>
        <p className="muted">This page is for the greeter desk.</p>
      </main>
    )
  }

  const index = selected ? visitors.findIndex((v) => v.id === selected) : -1
  const current = index >= 0 ? visitors[index] : null

  // ---- detail view ----------------------------------------------------------
  if (current) {
    return (
      <main className="page gp-detail">
        <div className="gp-nav">
          <button className="secondary gp-back" onClick={() => setSelected(null)}>
            ← Back
          </button>
          <div className="gp-nav-arrows">
            <button
              className="secondary"
              disabled={index <= 0}
              onClick={() => setSelected(visitors[index - 1]?.id ?? null)}
              aria-label="Previous guest"
            >
              ‹ Prev
            </button>
            <button
              className="secondary"
              disabled={index >= visitors.length - 1}
              onClick={() => setSelected(visitors[index + 1]?.id ?? null)}
              aria-label="Next guest"
            >
              Next ›
            </button>
          </div>
        </div>

        <h1 className="gp-name">
          {current.first_name} {current.last_name}
        </h1>

        <label className="gp-checkin">
          <input
            type="checkbox"
            checked={current.checked_in}
            onChange={(e) => void toggleCheckIn(current.id, e.target.checked)}
          />
          I checked this person in
        </label>

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
        <div className="gp-head-titles">
          <h1>{orgName ?? 'Greeter desk'}</h1>
          <span className="muted small">Recent guest sign-ins</span>
        </div>
        <div className="gp-account">
          <button className="secondary btn-sm" onClick={() => setMenuOpen((o) => !o)}>
            Account ▾
          </button>
          {menuOpen && (
            <div className="gp-menu">
              <button
                className="linkish"
                onClick={() => {
                  setMenuOpen(false)
                  setPwOpen(true)
                }}
              >
                Change password
              </button>
              <button className="linkish" onClick={() => void doSignOut()}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>

      {pwOpen && <ChangePassword onClose={() => setPwOpen(false)} />}

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
    </main>
  )
}

/** Set a new password for the signed-in greeter, in place. */
function ChangePassword({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    setDone(true)
  }

  return (
    <div className="gp-pw">
      {done ? (
        <div className="gp-pw-inner">
          <p className="notice">Password changed.</p>
          <button onClick={onClose}>Done</button>
        </div>
      ) : (
        <form className="gp-pw-inner" onSubmit={onSubmit}>
          <label className="field">
            New password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              autoFocus
            />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Set password'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
