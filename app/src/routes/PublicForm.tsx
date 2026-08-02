import { useEffect, useRef, useState, type FormEvent } from 'react'
import { getJobStatus, submitBadge } from '../lib/api'

type Stage = 'form' | 'submitting' | 'printing' | 'done' | 'error'

const POLL_MS = 1500
const TIMEOUT_MS = 30000

/** Progressively format digits as (xxx)yyy-zzzz while typing. */
function formatPhone(input: string): string {
  const d = input.replace(/\D/g, '').slice(0, 10)
  if (d.length < 4) return d ? `(${d}` : ''
  if (d.length < 7) return `(${d.slice(0, 3)})${d.slice(3)}`
  return `(${d.slice(0, 3)})${d.slice(3, 6)}-${d.slice(6)}`
}

export default function PublicForm() {
  const [stage, setStage] = useState<Stage>('form')
  const [visitorType, setVisitorType] = useState<'member' | 'visitor' | ''>('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  function stopPolling() {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }
  useEffect(() => stopPolling, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (visitorType === '') return
    setStage('submitting')
    setMessage(null)
    try {
      const { job_id } = await submitBadge({
        visitor_type: visitorType,
        first_name: firstName,
        last_name: lastName,
        phone,
        email,
      })
      setStage('printing')
      startPolling(job_id)
    } catch (err) {
      setMessage((err as Error).message)
      setStage('error')
    }
  }

  function startPolling(jobId: string) {
    const started = Date.now()
    pollRef.current = window.setInterval(async () => {
      try {
        const { status, error } = await getJobStatus(jobId)
        if (status === 'printed') {
          stopPolling()
          setStage('done')
        } else if (status === 'failed') {
          stopPolling()
          setMessage(error ?? 'Printing failed. Please see the attendant.')
          setStage('error')
        } else if (Date.now() - started > TIMEOUT_MS) {
          stopPolling()
          setMessage('This is taking longer than expected. Please see the attendant.')
          setStage('error')
        }
      } catch {
        // transient — keep polling until the timeout above
      }
    }, POLL_MS)
  }

  function reset() {
    stopPolling()
    setVisitorType('')
    setFirstName('')
    setLastName('')
    setPhone('')
    setEmail('')
    setMessage(null)
    setStage('form')
  }

  if (stage === 'printing' || stage === 'submitting') {
    return (
      <main className="page">
        <h1>Shir Hadash</h1>
        <div className="spinner" />
        <p className="big">Printing your badge…</p>
        <p className="muted">One moment — your name badge is on its way.</p>
      </main>
    )
  }

  if (stage === 'done') {
    return (
      <main className="page">
        <h1>Shir Hadash</h1>
        <p className="status-icon">✓</p>
        <p className="big">Your badge is printing!</p>
        <p className="muted">Please collect it from the printer. Welcome!</p>
        <button onClick={reset}>Print another</button>
      </main>
    )
  }

  if (stage === 'error') {
    return (
      <main className="page">
        <h1>Shir Hadash</h1>
        <p className="status-icon">⚠️</p>
        <p className="big">{message ?? 'Something went wrong.'}</p>
        <button onClick={reset}>Try again</button>
      </main>
    )
  }

  return (
    <main className="page">
      <h1>Welcome to Shir Hadash</h1>
      <p className="muted">Enter your details and tap Print to get your name badge.</p>
      <form onSubmit={onSubmit} className="form">
        <div className="field">
          <span>I am a…</span>
          <div className="segment">
            <button
              type="button"
              className={visitorType === 'member' ? 'seg active' : 'seg'}
              aria-pressed={visitorType === 'member'}
              onClick={() => setVisitorType('member')}
            >
              Member
            </button>
            <button
              type="button"
              className={visitorType === 'visitor' ? 'seg active' : 'seg'}
              aria-pressed={visitorType === 'visitor'}
              onClick={() => setVisitorType('visitor')}
            >
              Visitor
            </button>
          </div>
        </div>
        <label>
          First name
          <input
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
            autoComplete="given-name"
            autoFocus
          />
        </label>
        <label>
          Last name
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
          />
        </label>
        <label>
          Phone
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(formatPhone(e.target.value))}
            placeholder="(123)456-7890"
            inputMode="tel"
            pattern="\(\d{3}\)\d{3}-\d{4}"
            title="Format: (123)456-7890"
            autoComplete="tel"
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <button type="submit" disabled={visitorType === ''}>
          Print my badge
        </button>
      </form>
    </main>
  )
}
