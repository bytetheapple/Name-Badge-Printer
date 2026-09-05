import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { getEventConfig, getJobStatus, registerForEvent } from '../lib/api'

/**
 * Registering at an event desk.
 *
 * A deliberately shorter form than the lobby sign-in. There is no selfie, no
 * member-or-visitor choice, and no additional people: everyone here is
 * registering for one event, and the desk has a queue.
 *
 * Cell phone and email are both required, unlike the sign-in form. The
 * organizer may not have collected either when people registered in advance,
 * so the pre-registration list can be thin on both — which is precisely why
 * the person standing here should be asked for both. Whichever the list has is
 * then the one that matches.
 *
 * Nothing on this page says whether somebody was on the list. That is the
 * desk's business rather than the guest's: the badge carries the mark, and an
 * administrator decides what happens next.
 */

const POLL_MS = 1500
const TIMEOUT_MS = 30000

/** Progressively format digits as (xxx)yyy-zzzz while typing. */
function formatPhone(input: string): string {
  const d = input.replace(/\D/g, '').replace(/^1/, '').slice(0, 10)
  if (d.length < 4) return d ? `(${d}` : ''
  if (d.length < 7) return `(${d.slice(0, 3)})${d.slice(3)}`
  return `(${d.slice(0, 3)})${d.slice(3, 6)}-${d.slice(6)}`
}

type Stage = 'loading' | 'closed' | 'form' | 'submitting' | 'printing' | 'done' | 'error'

export default function EventForm() {
  const { token = '' } = useParams()
  const [stage, setStage] = useState<Stage>('loading')
  const [eventName, setEventName] = useState('')
  const [orgName, setOrgName] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [wantsFollowup, setWantsFollowup] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      const cfg = await getEventConfig(token)
      if (!live) return
      if (!cfg) {
        setStage('closed')
        return
      }
      setEventName(cfg.event_name)
      setOrgName(cfg.org_name)
      setStage('form')
    })()
    return () => {
      live = false
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [token])

  // The title the organizer named the event, followed by the word that says
  // what this page is for. Set on the document too, because a phone's tab
  // strip is the only chrome this page has.
  useEffect(() => {
    if (eventName) document.title = `${eventName} Registration`
  }, [eventName])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setMessage(null)
    setStage('submitting')
    try {
      const result = await registerForEvent({
        token,
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        phone: phone.trim(),
        email: email.trim(),
        wants_followup: wantsFollowup,
      })
      // A spreadsheet that could not be written is the desk's problem, not the
      // guest's, and the badge is already printing. Said quietly, and only
      // because nobody would otherwise know the record is missing.
      if (result.sheet_error) {
        setMessage('Your badge is printing. Please mention at the desk that the list did not update.')
      }
      setStage('printing')
      watchJob(result.job_ids[0])
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setStage('error')
    }
  }

  function watchJob(jobId: string | undefined) {
    if (!jobId) {
      setStage('done')
      return
    }
    const started = Date.now()
    pollRef.current = window.setInterval(async () => {
      if (Date.now() - started > TIMEOUT_MS) {
        window.clearInterval(pollRef.current!)
        setStage('done')
        return
      }
      const status = await getJobStatus(jobId, { event_token: token }).catch(() => null)
      if (status?.status === 'printed') {
        window.clearInterval(pollRef.current!)
        setStage('done')
      } else if (status?.status === 'failed') {
        window.clearInterval(pollRef.current!)
        setMessage('The badge did not print. Please see someone at the desk.')
        setStage('error')
      }
    }, POLL_MS)
  }

  if (stage === 'loading') {
    return (
      <main className="kiosk">
        <p className="muted">Loading…</p>
      </main>
    )
  }

  if (stage === 'closed') {
    return (
      <main className="kiosk">
        <h1>Registration is not open</h1>
        <p className="muted">
          This code is not accepting registrations. Please see someone at the desk.
        </p>
      </main>
    )
  }

  if (stage === 'printing' || stage === 'done') {
    return (
      <main className="kiosk">
        <h1>{stage === 'done' ? 'You are registered' : 'Printing your badge…'}</h1>
        <p className="muted">
          {stage === 'done'
            ? 'Please collect your badge from the desk.'
            : 'This takes a few seconds.'}
        </p>
        {message && <p className="muted small">{message}</p>}
      </main>
    )
  }

  return (
    <main className="kiosk">
      <h1>
        <strong>{eventName}</strong> Registration
      </h1>
      {orgName && <p className="muted">{orgName}</p>}

      <form onSubmit={submit}>
        <label className="field">
          First name
          <input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoComplete="given-name"
            required
          />
        </label>
        <label className="field">
          Last name
          <input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
            required
          />
        </label>
        <label className="field">
          Cell phone
          <input
            value={phone}
            onChange={(e) => setPhone(formatPhone(e.target.value))}
            inputMode="tel"
            autoComplete="tel"
            placeholder="(555)123-4567"
            required
          />
        </label>
        <label className="field">
          Email
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            inputMode="email"
            autoComplete="email"
            required
          />
        </label>

        {/* The same question the lobby form asks, named after the
            organization for the same reason: "learn more about us" is a worse
            question than one with the name in it. */}
        <label className="check">
          <input
            type="checkbox"
            checked={wantsFollowup}
            onChange={(e) => setWantsFollowup(e.target.checked)}
          />
          Interested in learning more{orgName ? ` about ${orgName}` : ''}?
        </label>

        {message && <p className="error">{message}</p>}
        <button type="submit" disabled={stage === 'submitting'}>
          {stage === 'submitting' ? 'Registering…' : 'Print my badge'}
        </button>
      </form>
    </main>
  )
}
