import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { getJobStatus, getPublicConfig, submitBadge, uploadSelfie, type SelfieMode } from '../lib/api'
import { SelfieCapture } from '../components/SelfieCapture'

type Stage = 'choose' | 'form' | 'selfie' | 'submitting' | 'printing' | 'done' | 'error'

const POLL_MS = 1500
const TIMEOUT_MS = 30000

/** Progressively format digits as (xxx)yyy-zzzz while typing. */
function formatPhone(input: string): string {
  // Swallow a leading "1" (US country code): NANP area codes never start with
  // 1, so a first-digit 1 is always the country code and would shift the number.
  const d = input.replace(/\D/g, '').replace(/^1/, '').slice(0, 10)
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
  const [pronouns, setPronouns] = useState('')
  const [people, setPeople] = useState<Array<{ first: string; last: string; pronouns: string }>>([])
  const [printCount, setPrintCount] = useState(1)
  const [message, setMessage] = useState<string | null>(null)
  const [selfieMode, setSelfieMode] = useState<SelfieMode>('off')
  const [pronounsEnabled, setPronounsEnabled] = useState(false)
  const pollRef = useRef<number | null>(null)

  const MAX_PEOPLE = 8

  function addPerson() {
    setPeople((p) => (p.length >= MAX_PEOPLE ? p : [...p, { first: '', last: '', pronouns: '' }]))
  }
  function updatePerson(i: number, field: 'first' | 'last' | 'pronouns', value: string) {
    setPeople((p) => p.map((q, idx) => (idx === i ? { ...q, [field]: value } : q)))
  }
  function removePerson(i: number) {
    setPeople((p) => p.filter((_, idx) => idx !== i))
  }
  const [searchParams] = useSearchParams()
  const printerId = searchParams.get('printer')

  useEffect(() => {
    void getPublicConfig().then((c) => {
      setSelfieMode(c.selfie_mode)
      setPronounsEnabled(c.pronouns_enabled)
    })
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
      // Only include additional people with both names filled in.
      const additional = people
        .filter((p) => p.first.trim() && p.last.trim())
        .map((p) => ({ first_name: p.first.trim(), last_name: p.last.trim(), pronouns: p.pronouns.trim() }))
      const { entry_id, job_ids } = await submitBadge({
        visitor_type: visitorType,
        first_name: firstName,
        last_name: lastName,
        pronouns,
        phone,
        email,
        printer_id: printerId,
        additional,
      })
      setPrintCount(job_ids.length)
      // Upload the primary's selfie in the background — never block the badges.
      if (selfie) {
        void uploadSelfie({
          entry_id,
          first_name: firstName,
          last_name: lastName,
          image: selfie,
        }).catch(() => {})
      }
      setStage('printing')
      startPolling(job_ids)
    } catch (err) {
      setMessage((err as Error).message)
      setStage('error')
    }
  }

  function startPolling(jobIds: string[]) {
    const started = Date.now()
    // Give a bigger batch more time to work through the print queue.
    const timeout = TIMEOUT_MS + Math.max(0, jobIds.length - 1) * 10000
    pollRef.current = window.setInterval(async () => {
      try {
        const statuses = await Promise.all(
          jobIds.map((id) => getJobStatus(id).then((s) => s.status).catch(() => 'queued')),
        )
        if (statuses.every((s) => s === 'printed')) {
          stopPolling()
          setStage('done')
        } else if (statuses.some((s) => s === 'failed')) {
          stopPolling()
          setMessage(
            jobIds.length > 1
              ? 'One or more badges failed to print. Please see the attendant.'
              : 'Printing failed. Please see the attendant.',
          )
          setStage('error')
        } else if (Date.now() - started > timeout) {
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
    setPronouns('')
    setPhone('')
    setEmail('')
    setPeople([])
    setPrintCount(1)
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
        <p className="big">{printCount > 1 ? `Printing ${printCount} badges…` : 'Printing your badge…'}</p>
        <p className="muted">
          One moment — your {printCount > 1 ? 'name badges are' : 'name badge is'} on the way.
        </p>
      </main>
    )
  }

  if (stage === 'done') {
    return (
      <main className="page">
        <h1>Shir Hadash</h1>
        <p className="status-icon">✓</p>
        <p className="big">{printCount > 1 ? `${printCount} badges are printing!` : 'Your badge is printing!'}</p>
        <p className="muted">
          Please collect {printCount > 1 ? 'them' : 'it'} from the printer. Welcome!
        </p>
        <button onClick={reset}>Print more</button>
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
  const badgeCount = 1 + people.filter((p) => p.first.trim() && p.last.trim()).length
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
        {pronounsEnabled && (
          <label>
            Pronouns (optional)
            <input
              type="text"
              value={pronouns}
              onChange={(e) => setPronouns(e.target.value)}
              placeholder="e.g. she/her, they/them"
              list="pronoun-options"
              maxLength={40}
              autoComplete="off"
            />
            <datalist id="pronoun-options">
              <option value="she/her" />
              <option value="he/him" />
              <option value="they/them" />
              <option value="she/they" />
              <option value="he/they" />
              <option value="ze/zir" />
            </datalist>
          </label>
        )}
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

        <div className="family">
          <p className="family-head muted">
            Signing in as a couple or family? Add a badge for each person — only your
            name{visitorType === 'visitor' ? ', contact info' : ''} above is needed for the group.
          </p>
          {people.map((p, i) => (
            <div className="family-row" key={i}>
              <div className="family-row-head">
                <span className="family-row-title">Additional badge {i + 1}</span>
                <button type="button" className="linklike" onClick={() => removePerson(i)}>
                  Remove
                </button>
              </div>
              <label>
                First name *
                <input
                  type="text"
                  value={p.first}
                  onChange={(e) => updatePerson(i, 'first', e.target.value)}
                  required
                  autoComplete="off"
                />
              </label>
              <label>
                Last name *
                <input
                  type="text"
                  value={p.last}
                  onChange={(e) => updatePerson(i, 'last', e.target.value)}
                  required
                  autoComplete="off"
                />
              </label>
              {pronounsEnabled && (
                <label>
                  Pronouns (optional)
                  <input
                    type="text"
                    value={p.pronouns}
                    onChange={(e) => updatePerson(i, 'pronouns', e.target.value)}
                    placeholder="e.g. she/her, they/them"
                    list="pronoun-options"
                    maxLength={40}
                    autoComplete="off"
                  />
                </label>
              )}
            </div>
          ))}
          {people.length < MAX_PEOPLE && (
            <button type="button" className="secondary add-person" onClick={addPerson}>
              + Add another person
            </button>
          )}
        </div>

        <button type="submit">
          {visitorType === 'visitor' && selfieMode !== 'off'
            ? 'Continue'
            : badgeCount > 1
              ? `Print ${badgeCount} badges`
              : 'Print my badge'}
        </button>
      </form>
    </main>
  )
}
