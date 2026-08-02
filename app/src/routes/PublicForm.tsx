import { useEffect, useRef, useState, type FormEvent } from 'react'
import { getJobStatus, submitBadge } from '../lib/api'

type Stage = 'form' | 'submitting' | 'printing' | 'done' | 'error'

const POLL_MS = 1500
const TIMEOUT_MS = 30000

export default function PublicForm() {
  const [stage, setStage] = useState<Stage>('form')
  const [name, setName] = useState('')
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
    setStage('submitting')
    setMessage(null)
    try {
      const { job_id } = await submitBadge({ name, phone, email })
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
    setName('')
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
        <label>
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoComplete="name"
            autoFocus
          />
        </label>
        <label>
          Phone
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
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
        <button type="submit">Print my badge</button>
      </form>
    </main>
  )
}
