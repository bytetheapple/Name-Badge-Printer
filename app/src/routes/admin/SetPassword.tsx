import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

/**
 * Where somebody sets a password: after an invitation, or after a reset.
 *
 * Two ways in. A link in an email still works — supabase-js takes the token
 * out of the URL hash and establishes a session. And a six-digit code typed
 * in, which is the way that survives real mail systems: a link is a URL, and
 * every scanner, preview generator and messaging app fetches URLs. These
 * tokens work exactly once, so anything that fetches one spends it, and the
 * person clicking gets told it expired. Worse, fetching an invite link
 * completes the sign-in, so an account can look used by someone who never
 * saw this page.
 *
 * A code is not a URL. Nothing in any pipe can spend it in transit.
 */
export default function SetPassword() {
  const [ready, setReady] = useState(false)
  //: Why the link did not work, taken from the URL hash. Without this the page
  //: waits forever for a session that is never coming.
  const [linkError, setLinkError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  //: The typed-code way in, for when the link was eaten before it arrived.
  // Prefilled from the link in the email when it carries one. A code belongs
  // to one address, and asking somebody to retype the address the message was
  // just delivered to is asking for the failure it caused: a customer dropped
  // one letter of their own domain and got "expired" three times, because
  // GoTrue will not say "no such account" to a browser.
  //
  // Not a secret: it is their own address, in their own mailbox.
  const [email, setEmail] = useState(
    () => new URLSearchParams(window.location.search).get('email')?.trim() ?? '',
  )
  const [code, setCode] = useState('')
  const [resent, setResent] = useState(false)
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

  async function useCode(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    // The same code is sent for an invitation and for a reset, and nothing in
    // it says which it was. Recovery first because it is the commoner errand.
    const address = email.trim().toLowerCase()
    const digits = code.replace(/\D/g, '')
    let failed: string | null = null
    for (const type of ['recovery', 'invite'] as const) {
      const { error } = await supabase.auth.verifyOtp({ email: address, token: digits, type })
      if (!error) {
        setBusy(false)
        setLinkError(null)
        setReady(true)
        return
      }
      // The first failure, not the last. Recovery is the likelier type, so its
      // reason is the useful one; overwriting it with the invite attempt's
      // meant every failure read as whatever the second try happened to say.
      failed = failed ?? error.message
    }
    setBusy(false)
    // GoTrue answers a missing account with the same words it uses for a spent
    // code, on purpose: a page that distinguished them would be a way to find
    // out who has an account. Only the server's own log says which, so the
    // message has to name every cause rather than the one it was told.
    //
    // The address is listed first because it is the one nobody suspects. A
    // customer typing the shared mailbox the email arrived in, while the
    // account is registered to something else, reads as "expired" for ever.
    setError(
      `${failed ?? 'That code was not accepted.'} Check that this is the exact ` +
        'address the email was sent to — a code belongs to one address. ' +
        'Otherwise the code has been used already or has timed out, and a new ' +
        'one will work.',
    )
  }

  /** A fresh code, without going back to the sign-in page to ask for one. */
  async function resend() {
    const address = email.trim().toLowerCase()
    if (!address) {
      setError('Enter your email address first.')
      return
    }
    setBusy(true)
    setError(null)
    setResent(false)
    const { error } = await supabase.auth.resetPasswordForEmail(address, {
      redirectTo: `${window.location.origin}/admin/set-password`,
    })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    setCode('')
    setResent(true)
  }

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

  // One screen for both "no session yet" and "the link did not work": in each
  // case the way forward is the same, and it is the code rather than another
  // link. The old page said "waiting for a valid invite session", which is a
  // description of our problem rather than an instruction for theirs.
  if (!ready) {
    return (
      <main className="page">
        <h1>Set your password</h1>
        {linkError && <div className="error">{linkError}</div>}
        <p className="muted">
          {linkError
            ? 'Use the code in the same email instead. Links can be opened by mail ' +
              'systems before you get to them, which uses them up; a code cannot be.'
            : 'Enter the code from your invitation or password-reset email.'}
        </p>
        <form onSubmit={useCode} className="form">
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
            Code from the email
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              inputMode="numeric"
              autoComplete="one-time-code"
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </form>
        {resent && (
          <p className="muted small">
            A new code is on its way to that address. Use the newest one — sending a code
            replaces any earlier one.
          </p>
        )}
        <p className="muted small">
          <button type="button" className="linkish" disabled={busy} onClick={() => void resend()}>
            Send me a new code
          </button>
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
