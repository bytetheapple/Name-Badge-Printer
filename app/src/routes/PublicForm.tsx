import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getJobStatus, getPublicConfig, submitBadge, uploadSelfie, type SelfieMode } from '../lib/api'
import { SelfieCapture } from '../components/SelfieCapture'

type Stage = 'choose' | 'form' | 'selfie' | 'submitting' | 'printing' | 'done' | 'error'

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
  const [stage, setStage] = useState<Stage>('choose')
  const [visitorType, setVisitorType] = useState<'member' | 'visitor'>('visitor')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [selfieMode, setSelfieMode] = useState<SelfieMode>('off')
  const pollRef = useRef<number | null>(null)
  const [searchParams] = useSearchParams()
  const printerId = searchParams.get('printer')

  useEffect(() => {
    void getPublicConfig().then((c) => setSelfieMode(c.selfie_mode))
  }, [])

  function stopPolling() {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }
  useEffect(() => stopPolling, [])

  function choose(type: 'member' | 'visitor') {
    setVisitorType(type)
    setMessage(null)
    setStage('form')
  }

  function onFormSubmit(e: FormEvent) {
    e.preventDefault()
    // Visitors get the selfie step (when enabled); members always print directly.
    if (visitorType === 'visitor' && selfieMode !== 'off') {
      setStage('selfie')
    } else {
      void doSubmit()
    }
  }

  async function doSubmit(selfie?: string) {
    setStage('submitting')
    setMessage(null)
    try {
      const { job_id, entry_id } = await submitBadge({
        visitor_type: visitorType,
        first_name: firstName,
        last_name: lastName,
        phone,
        email,
        printer_id: printerId,
      })
      // Upload the selfie in the background — never block or delay the badge.
      if (selfie) {
        void uploadSelfie({
          entry_id,
          first_name: firstName,
          last_name: lastName,
          image: selfie,
        }).catch(() => {})
      }
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
    setFirstName('')
    setLastName('')
    setPhone('')
    setEmail('')
    setMessage(null)
    setStage('choose')
  }

  // Step 1 — what the QR code lands on.
  if (stage === 'choose') {
    return (
      <main className="page">
        <h1>Welcome to Shir Hadash</h1>
        <p className="big">Are you a member or a visitor?</p>
        <div className="choice">
          <button className="choice-btn" onClick={() => choose('member')}>
            I am a Member
          </button>
          <button className="choice-btn" onClick={() => choose('visitor')}>
            I am a Visitor
          </button>
        </div>
      </main>
    )
  }

  if (stage === 'selfie') {
    return (
      <SelfieCapture
        optional={selfieMode === 'optional'}
        onAccept={(img) => void doSubmit(img)}
        onSkip={() => void doSubmit()}
        onBack={() => setStage('form')}
      />
    )
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

  // Step 2 — details form.
  return (
    <main className="page">
      <h1>Welcome to Shir Hadash</h1>
      <p className="muted">
        Signing in as <strong>{visitorType === 'member' ? 'Member' : 'Visitor'}</strong> ·{' '}
        <button type="button" className="linklike" onClick={() => setStage('choose')}>
          change
        </button>
      </p>
      <form onSubmit={onFormSubmit} className="form">
        <label>
          First name *
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
          Last name *
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
            autoComplete="family-name"
          />
        </label>
        <label>
          Phone{visitorType === 'visitor' ? ' *' : ''}
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(formatPhone(e.target.value))}
            placeholder="(123)456-7890"
            inputMode="tel"
            pattern="\(\d{3}\)\d{3}-\d{4}"
            title="Format: (123)456-7890"
            required={visitorType === 'visitor'}
            autoComplete="tel"
          />
        </label>
        <label>
          Email{visitorType === 'visitor' ? ' *' : ''}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required={visitorType === 'visitor'}
            autoComplete="email"
          />
        </label>
        <button type="submit">
          {visitorType === 'visitor' && selfieMode !== 'off' ? 'Continue' : 'Print my badge'}
        </button>
      </form>
    </main>
  )
}
