import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  //: Said after a reset is requested. Deliberately the same whether or not
  //: the address has an account: this page is public, and a different answer
  //: for each would turn it into a way to find out who has one.
  const [sent, setSent] = useState(false)
  const navigate = useNavigate()
  const { session } = useAuth()

  // Already signed in? Skip the form.
  useEffect(() => {
    if (session) navigate('/admin', { replace: true })
  }, [session, navigate])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    navigate('/admin', { replace: true })
  }

  async function resetPassword() {
    setError(null)
    setSent(false)
    if (!email.trim()) {
      setError('Enter your email address first, then choose Forgot password.')
      return
    }
    setBusy(true)
    // The same page an invitation lands on: it exists to take a session from a
    // link and set a password, and a recovery link is the same errand.
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/admin/set-password`,
    })
    setBusy(false)
    // An error here is a rate limit or a mail failure, not "no such person" —
    // Supabase does not say, on purpose.
    if (error) {
      setError(error.message)
      return
    }
    setSent(true)
  }

  return (
    <main className="page">
      <h1>Admin Login</h1>
      <form onSubmit={onSubmit} className="form">
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        {error && <p className="error">{error}</p>}
        {sent && (
          <p className="muted small">
            If that address has an account, a link to set a new password is on its way.
            It works once, and it may land in junk.
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {/* Inside the form so it can use the address already typed, but not a
            submit: this page had no way back for somebody who has forgotten a
            password, which left the only route through whoever invited them. */}
        <button type="button" className="linkish" disabled={busy} onClick={() => void resetPassword()}>
          Forgot password?
        </button>
      </form>
    </main>
  )
}
