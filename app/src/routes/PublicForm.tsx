import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import {
  getJobStatus,
  getPublicConfig,
  submitBadge,
  uploadSelfie,
  uploadLicense,
  type SelfieMode,
  type CaptureMode,
} from '../lib/api'
import { defaultFieldConfig, type FieldConfig } from '../lib/formConfig'
import { PhotoButton } from '../components/PhotoButton'

type Stage = 'choose' | 'form' | 'photos' | 'waiver' | 'submitting' | 'printing' | 'done' | 'error'

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
  const [people, setPeople] = useState<
    Array<{ first: string; last: string; pronouns: string; relationship: string }>
  >([])
  const [printCount, setPrintCount] = useState(1)
  const [message, setMessage] = useState<string | null>(null)
  const [selfieMode, setSelfieMode] = useState<SelfieMode>('off')
  const [licenseMode, setLicenseMode] = useState<CaptureMode>('off')
  //: Each photo, taken on the one hub screen before printing.
  const [selfieImage, setSelfieImage] = useState<string | undefined>(undefined)
  const [licenseImage, setLicenseImage] = useState<string | undefined>(undefined)
  //: An optional external form (e.g. a guest waiver) the visitor is sent to
  //: before the badge prints. Empty when the org has not configured one.
  const [waiverUrl, setWaiverUrl] = useState<string | null>(null)
  const [waiverLabel, setWaiverLabel] = useState<string | null>(null)
  const [fieldConfig, setFieldConfig] = useState<FieldConfig>(() => defaultFieldConfig(false))
  //: Asked of visitors only, and named after the congregation — "learn more
  //: about us" is a worse question than one with the name in it.
  const [wantsFollowup, setWantsFollowup] = useState(false)
  const [orgName, setOrgName] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  const MAX_PEOPLE = 8
  //: One choice per person — someone cannot be both your child and your
  //: parent. Kept here rather than in the database so the words can change
  //: without a migration; the column is plain text.
  const RELATIONSHIPS = ['Partner', 'Child', 'Parent', 'Other']

  function addPerson() {
    setPeople((p) =>
      p.length >= MAX_PEOPLE ? p : [...p, { first: '', last: '', pronouns: '', relationship: '' }],
    )
  }
  function updatePerson(
    i: number,
    field: 'first' | 'last' | 'pronouns' | 'relationship',
    value: string,
  ) {
    setPeople((p) => p.map((q, idx) => (idx === i ? { ...q, [field]: value } : q)))
  }
  function removePerson(i: number) {
    setPeople((p) => p.filter((_, idx) => idx !== i))
  }
  // /k/<kiosk_token> is the current form; ?printer=<uuid> is the older link,
  // still honoured so QR codes already hanging in a lobby keep working.
  const { token } = useParams()
  const [searchParams] = useSearchParams()
  const kiosk = useMemo(
    () => ({ kiosk_token: token ?? null, printer_id: searchParams.get('printer') }),
    [token, searchParams],
  )

  useEffect(() => {
    void getPublicConfig(kiosk).then((c) => {
      setSelfieMode(c.selfie_mode)
      setLicenseMode(c.license_mode)
      setFieldConfig(c.field_config)
      setOrgName(c.org_name ?? null)
      setWaiverUrl(c.waiver_url)
      setWaiverLabel(c.waiver_label)
    })
  }, [kiosk])

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

  // The primary plus any additional people with both names — used for the print
  // button's wording on both the form and the photo hub.
  const badgeCount = 1 + people.filter((p) => p.first.trim() && p.last.trim()).length

  // The visitor steps that may sit between the form and printing, in order:
  // photos, then an external form (e.g. a waiver). Each is skipped when off.
  function afterForm() {
    if (visitorType === 'visitor') {
      if (selfieMode !== 'off' || licenseMode !== 'off') return setStage('photos')
      if (waiverUrl) return setStage('waiver')
    }
    void doSubmit()
  }
  function afterPhotos() {
    if (waiverUrl) return setStage('waiver')
    void doSubmit(selfieImage, licenseImage)
  }

  function onFormSubmit(e: FormEvent) {
    e.preventDefault()
    afterForm()
  }

  async function doSubmit(
    selfie?: string,
    license?: string,
    opts?: { redirectTo?: string; waiverAck?: boolean },
  ) {
    setStage('submitting')
    setMessage(null)
    try {
      // Only include additional people with both names filled in.
      const additional = people
        .filter((p) => p.first.trim() && p.last.trim())
        .map((p) => ({
          first_name: p.first.trim(),
          last_name: p.last.trim(),
          pronouns: p.pronouns.trim(),
          relationship: p.relationship,
        }))
      const { entry_id, job_ids } = await submitBadge({
        visitor_type: visitorType,
        first_name: firstName,
        last_name: lastName,
        pronouns,
        phone,
        email,
        wants_followup: wantsFollowup,
        waiver_ack: opts?.waiverAck === true,
        ...kiosk,
        additional,
      })
      setPrintCount(job_ids.length)
      // The photos. Normally fire-and-forget so a slow upload never holds up a
      // badge — but when we are about to hand this window to another site, wait
      // for them, or navigating away would cancel them mid-flight.
      const uploads: Promise<void>[] = []
      if (selfie) {
        uploads.push(
          uploadSelfie({ entry_id, first_name: firstName, last_name: lastName, image: selfie }).catch(
            () => {},
          ),
        )
      }
      if (license) {
        uploads.push(
          uploadLicense({ entry_id, first_name: firstName, last_name: lastName, image: license }).catch(
            () => {},
          ),
        )
      }

      if (opts?.redirectTo) {
        // The badge is queued and will print at the desk; send this same window
        // on to the external form as the final step. No return trip is needed.
        await Promise.all(uploads)
        window.location.assign(opts.redirectTo)
        return
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
          jobIds.map((id) => getJobStatus(id, kiosk).then((s) => s.status).catch(() => 'queued')),
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
    setSelfieImage(undefined)
    setLicenseImage(undefined)
    setStage('choose')
  }

  // Step 1 — what the QR code lands on.
  if (stage === 'choose') {
    return (
      <main className="page">
        <h1>{orgName ? `Welcome to ${orgName}` : 'Welcome'}</h1>
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

  if (stage === 'photos') {
    const needSelfie = selfieMode === 'required' && !selfieImage
    const needLicense = licenseMode === 'required' && !licenseImage
    const canPrint = !needSelfie && !needLicense
    return (
      <main className="page">
        <h1>{orgName ?? 'Guest Badges'}</h1>
        <p className="big">A couple of photos before your badge</p>

        <div className="capture-hub">
          {selfieMode !== 'off' && (
            <PhotoButton
              label="Take a selfie"
              retakeLabel="Retake selfie"
              capture="user"
              value={selfieImage}
              onCapture={setSelfieImage}
              required={selfieMode === 'required'}
            />
          )}
          {licenseMode !== 'off' && (
            <PhotoButton
              label="Take a picture of your driver's license"
              retakeLabel="Retake driver's license"
              capture="environment"
              value={licenseImage}
              onCapture={setLicenseImage}
              required={licenseMode === 'required'}
            />
          )}
        </div>

        <div className="actions">
          <button disabled={!canPrint} onClick={afterPhotos}>
            {waiverUrl
              ? 'Continue'
              : badgeCount > 1
                ? `Print ${badgeCount} badges`
                : 'Print my badge'}
          </button>
          <button className="secondary" onClick={() => setStage('form')}>
            Back
          </button>
        </div>

        {!canPrint && (
          <p className="muted small">
            {needSelfie && needLicense
              ? 'A selfie and a driver’s license photo are required before printing.'
              : needSelfie
                ? 'A selfie is required before printing.'
                : 'A driver’s license photo is required before printing.'}
          </p>
        )}
        <p className="muted small">
          Your photos will be saved by {orgName ?? 'this congregation'}.
        </p>
      </main>
    )
  }

  if (stage === 'waiver') {
    const label = waiverLabel?.trim() || 'guest form'
    // Back to the photo hub if there was one, otherwise the form.
    const back = selfieMode !== 'off' || licenseMode !== 'off' ? 'photos' : 'form'
    return (
      <main className="page">
        <h1>{orgName ?? 'Guest Badges'}</h1>
        <p className="big">One last step — the {label}</p>
        <p className="muted">
          Your {badgeCount > 1 ? 'badges print' : 'badge prints'} at the desk, then this screen
          continues to {orgName ? `${orgName}'s` : 'the'} {label}. Please complete it to finish
          checking in.
        </p>

        <div className="actions">
          <button
            onClick={() =>
              void doSubmit(selfieImage, licenseImage, {
                redirectTo: waiverUrl ?? undefined,
                waiverAck: true,
              })
            }
          >
            {badgeCount > 1
              ? `Print ${badgeCount} badges & open the ${label}`
              : `Print my badge & open the ${label}`}
          </button>
          <button className="secondary" onClick={() => setStage(back)}>
            Back
          </button>
        </div>
      </main>
    )
  }

  if (stage === 'printing' || stage === 'submitting') {
    return (
      <main className="page">
        <h1>{orgName ?? 'Guest Badges'}</h1>
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
        <h1>{orgName ?? 'Guest Badges'}</h1>
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
        <h1>{orgName ?? 'Guest Badges'}</h1>
        <p className="status-icon">⚠️</p>
        <p className="big">{message ?? 'Something went wrong.'}</p>
        <button onClick={reset}>Try again</button>
      </main>
    )
  }

  // Step 2 — details form. Which optional fields appear, and which are
  // required, is the organization's own choice, per audience.
  const fc = fieldConfig[visitorType]
  const suffix = (state: 'hidden' | 'optional' | 'required') =>
    state === 'required' ? ' *' : ' (optional)'
  return (
    <main className="page">
      {/* The congregation's own name, not the one this was first built for.
          Falls back to a bare welcome rather than guessing. */}
      <h1>{orgName ? `Welcome to ${orgName}` : 'Welcome'}</h1>
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
        {fc.pronouns !== 'hidden' && (
          <label>
            Pronouns{suffix(fc.pronouns)}
            <input
              type="text"
              value={pronouns}
              onChange={(e) => setPronouns(e.target.value)}
              placeholder="e.g. she/her, they/them"
              list="pronoun-options"
              maxLength={40}
              required={fc.pronouns === 'required'}
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
        {fc.phone !== 'hidden' && (
          <label>
            Phone{suffix(fc.phone)}
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(formatPhone(e.target.value))}
              placeholder="(123)456-7890"
              inputMode="tel"
              pattern="\(\d{3}\)\d{3}-\d{4}"
              title="Format: (123)456-7890"
              required={fc.phone === 'required'}
              autoComplete="tel"
            />
          </label>
        )}
        {fc.email !== 'hidden' && (
          <label>
            Email{suffix(fc.email)}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required={fc.email === 'required'}
              autoComplete="email"
            />
          </label>
        )}

        {/* Visitors only: a member has already said yes to hearing from their
            own congregation. Unticked is a no rather than an unknown, which is
            why nothing about it is required. */}
        {visitorType === 'visitor' && (
          <label className="checkline">
            <input
              type="checkbox"
              checked={wantsFollowup}
              onChange={(e) => setWantsFollowup(e.target.checked)}
            />
            <span>I want to learn more about {orgName ?? 'this congregation'}</span>
          </label>
        )}

        <div className="family">
          <p className="family-head muted">
            Signing in as a couple or family? Add a badge for each person — only your
            name{fc.phone === 'required' || fc.email === 'required' ? ' and contact info' : ''} above
            is needed for the group.
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
              <label>
                Relationship to you (optional)
                <select
                  value={p.relationship}
                  onChange={(e) => updatePerson(i, 'relationship', e.target.value)}
                >
                  <option value="">Prefer not to say</option>
                  {RELATIONSHIPS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              {/* Additional people are name-only; their pronouns follow the
                  same on/off as the primary's, but are never required — a
                  child's pronouns are not a gate on a parent's badge. */}
              {fc.pronouns !== 'hidden' && (
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
          {visitorType === 'visitor' && (selfieMode !== 'off' || licenseMode !== 'off')
            ? 'Continue'
            : badgeCount > 1
              ? `Print ${badgeCount} badges`
              : 'Print my badge'}
        </button>
      </form>
    </main>
  )
}
