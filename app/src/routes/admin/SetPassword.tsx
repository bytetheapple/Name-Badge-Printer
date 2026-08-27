import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

/**
 * Landing page for invitation / password-recovery email links.
 * supabase-js parses the token from the URL hash on load and establishes a
 * session; the user then sets a password and is signed in.
 */
export default function SetPassword() {
  const [ready, setReady] = useState(false)
  //: Why the link did not work, taken from the URL hash. Without this the page
  //: waits forever for a session that is never coming.
  const [linkError, setLinkError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    // A rejected link comes back as error parameters in the hash, and
    // supabase-js simply never produces a session — no throw, no event. The
    // reason is sitting in the URL, so read it rather than waiting on
    // something that will not arrive.
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const code = hash.get('error_code')
    const description = hash.get('error_description')
    if (code || description) {
      setLinkError(
        code === 'otp_expired'
          ? 'This link has already been used or has expired. Invitation and ' +
            'password links work only once — ask for a new one.'
          : (description ?? 'That link could not be used.'),
      )
    }

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) setReady(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

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
    navigate('/admin', { replace: true })
  }

  if (linkError) {
    return (
      <main className="page">
        <h1>That link did not work</h1>
        <div className="error">{linkError}</div>
        <p className="muted">
          Some mail apps open links in the background to check them, which uses the link up
          before you get to it. Asking for a fresh one and opening it straight away usually
          works.
        </p>
        <a href="/admin/login">Go to sign in</a>
      </main>
    )
  }

  if (!ready) {
    return (
      <main className="page">
        <h1>Set your password</h1>
        <p className="muted">
          Open this page from the link in your invitation email. Waiting for a valid invite session…
        </p>
      </main>
    )
  }

  return (
    <main className="page">
      <h1>Set your password</h1>
      <form onSubmit={onSubmit} className="form">
        <label>
          New password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set password & sign in'}
        </button>
      </form>
    </main>
  )
}
