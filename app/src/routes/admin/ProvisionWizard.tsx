import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import type { ProvisioningCandidate, ProvisioningSession } from '../../lib/types'

const COLUMNS =
  'id, org_id, state, printer_name, location, ssid, candidates, wired_ip, model, ' +
  'serial, firmware, wireless_mac, wireless_ip, printer_id, task_started_at, log, ' +
  'error, created_at, updated_at'

/** States where we are waiting on the print server rather than on the operator. */
const BRIDGE_STATES = new Set(['discover', 'configure', 'wifi', 'rediscover'])

const WAITING_LABEL: Record<string, string> = {
  discover: 'Looking for the printer on the wired network…',
  configure: 'Configuring the printer…',
  wifi: 'Writing the wireless settings…',
  rediscover: 'Looking for the printer on the wireless network…',
}

/** Rough worst case per step, so the wait can say something honest. */
const WAITING_HINT: Record<string, string> = {
  discover: 'From a factory reset this usually takes around 90 seconds.',
  configure: 'This takes a few seconds.',
  wifi: 'This takes a few seconds.',
  rediscover: 'This can take a minute or two.',
}

const POLL_MS = 3000

/**
 * Set up a printer from the admin, instead of from a terminal.
 *
 * The walkthrough needs two parties and neither can do it alone: the physical
 * steps need someone standing at the printer, and the rest needs to reach the
 * printer's network, which only the print server can do. So this page owns the
 * human steps and hands the others to the print server, one at a time.
 *
 * Everything lives in the session row, which means an operator can close this
 * tab in the middle of a factory reset — several minutes of standing about —
 * and pick it up again from the same place.
 */
export default function ProvisionWizard({ onFinished }: { onFinished: () => void }) {
  const { orgId, isAdmin } = useOrg()
  const [session, setSession] = useState<ProvisioningSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    if (!orgId) return
    const { data, error } = await supabase
      .from('provisioning_sessions')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .not('state', 'eq', 'done')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    setLoading(false)
    if (error) {
      setError(error.message)
      return
    }
    setSession((data as unknown as ProvisioningSession) ?? null)
  }, [orgId])

  // A finished session is still worth showing — it carries the hand-over
  // instructions — so once one is on screen we keep following it by id.
  const refresh = useCallback(async () => {
    if (!orgId) return
    if (!session) return void load()
    const { data } = await supabase
      .from('provisioning_sessions')
      .select(COLUMNS)
      .eq('id', session.id)
      .maybeSingle()
    setSession((data as unknown as ProvisioningSession) ?? null)
  }, [orgId, session, load])

  useEffect(() => {
    void load()
  }, [load])

  // Poll only while the print server has the ball. The rest of the time the
  // only thing that changes this row is the operator, in this tab.
  useEffect(() => {
    if (!session || !BRIDGE_STATES.has(session.state)) return
    timer.current = window.setInterval(() => void refresh(), POLL_MS)
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [session, refresh])

  async function advance(state: string, extra: Record<string, unknown> = {}) {
    if (!session) return
    setBusy(true)
    setError(null)
    const { error } = await supabase
      .from('provisioning_sessions')
      .update({ state, error: null, ...extra })
      .eq('id', session.id)
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    await refresh()
  }

  async function cancel() {
    if (!session) return
    setBusy(true)
    // Deleting takes the operator's secrets out of the vault with it.
    const { error } = await supabase.from('provisioning_sessions').delete().eq('id', session.id)
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    setSession(null)
    setShowLog(false)
  }

  async function finish() {
    await cancel()
    onFinished()
  }

  if (!isAdmin || loading) return null

  if (!session) {
    return starting ? (
      <StartForm
        orgId={orgId!}
        onCancel={() => setStarting(false)}
        onStarted={async () => {
          setStarting(false)
          await load()
        }}
      />
    ) : (
      <div className="provision-intro">
        <button type="button" onClick={() => setStarting(true)}>
          Set up a new printer
        </button>
        <p className="muted small">
          Walks a printer from the box to the wireless network. You will need to be at the
          printer — some of the steps are buttons on the printer itself.
        </p>
      </div>
    )
  }

  const waiting = BRIDGE_STATES.has(session.state)

  return (
    <div className="provision">
      <div className="provision-head">
        <strong>Setting up {session.printer_name || 'a printer'}</strong>
        <button className="secondary btn-sm" onClick={() => void cancel()} disabled={busy}>
          {session.state === 'done' ? 'Close' : 'Cancel setup'}
        </button>
      </div>

      <Progress state={session.state} />

      {session.error && (
        <div className="error">
          {session.error}
          <div className="muted small" style={{ marginTop: 6 }}>
            Nothing was lost — fix what it describes and use the button below to try that step
            again.
          </div>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {waiting ? (
        <div className="provision-step">
          <p className="provision-waiting">
            <span className="spinner" aria-hidden="true" /> {WAITING_LABEL[session.state]}
          </p>
          <p className="muted small">{WAITING_HINT[session.state]}</p>
        </div>
      ) : (
        <Step session={session} busy={busy} advance={advance} finish={finish} />
      )}

      {Array.isArray(session.log) && session.log.length > 0 && (
        <div className="provision-log">
          <button className="linkish btn-sm" onClick={() => setShowLog(!showLog)}>
            {showLog ? 'Hide' : 'Show'} what the print server reported
          </button>
          {showLog && (
            <pre>
              {session.log
                .map((e) => `${e.ok ? '' : 'FAILED '}${e.step}\n${e.text}`)
                .join('\n\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ start */

function StartForm({
  orgId,
  onCancel,
  onStarted,
}: {
  orgId: string
  onCancel: () => void
  onStarted: () => void
}) {
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [ssid, setSsid] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [webPassword, setWebPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    if (!name.trim()) return setError('Give the printer a name.')
    if (!ssid.trim()) return setError('Enter the name of the WiFi network it should join.')
    if (!passphrase) return setError('Enter the WiFi password.')
    if (!webPassword.trim()) return setError("Enter the code from the back of the printer.")

    setSaving(true)
    setError(null)
    const { data, error } = await supabase
      .from('provisioning_sessions')
      .insert({
        org_id: orgId,
        state: 'reset',
        printer_name: name.trim(),
        location: location.trim() || null,
        ssid: ssid.trim(),
      })
      .select('id')
      .maybeSingle()
    if (error || !data) {
      setSaving(false)
      setError(error?.message ?? 'Could not start the setup.')
      return
    }

    // Straight into the vault, never into a column. They are deleted again as
    // soon as the printer is on the network.
    for (const [kind, secret] of [
      ['web_password', webPassword],
      ['wifi_passphrase', passphrase],
    ]) {
      const { error: secretError } = await supabase.rpc('set_provisioning_secret', {
        p_session: data.id,
        p_kind: kind,
        p_secret: secret,
      })
      if (secretError) {
        // Do not leave a half-built session lying about with one secret in it.
        await supabase.from('provisioning_sessions').delete().eq('id', data.id)
        setSaving(false)
        setError(secretError.message)
        return
      }
    }
    setSaving(false)
    onStarted()
  }

  return (
    <div className="provision">
      <div className="provision-head">
        <strong>Set up a new printer</strong>
      </div>
      {error && <div className="error">{error}</div>}

      <label className="field">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Lobby Printer" autoFocus />
      </label>
      <label className="field">
        Location
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Front desk" />
      </label>
      <label className="field">
        WiFi network
        <input value={ssid} onChange={(e) => setSsid(e.target.value)} placeholder="Lobby-WiFi" />
        <span className="muted small">
          The printer can only see 2.4GHz networks. If your WiFi has a separate 5GHz name, use
          the 2.4GHz one.
        </span>
      </label>
      <label className="field">
        WiFi password
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="off"
        />
        <span className="muted small">
          You will be shown this again to check before it is used. Held only until the printer is
          on the network, then deleted.
        </span>
      </label>
      <label className="field">
        Code from the back of the printer
        <input value={webPassword} onChange={(e) => setWebPassword(e.target.value)} placeholder="aguQreSK" />
        <span className="muted small">
          A short code on the printer's label — this is what it wants after a factory reset.
        </span>
      </label>

      <div className="modal-actions">
        <button className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button onClick={() => void start()} disabled={saving}>
          {saving ? 'Starting…' : 'Start'}
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- steps */

const ORDER = [
  { key: 'reset', label: 'Reset' },
  { key: 'first_run', label: 'Setup screens' },
  { key: 'cable', label: 'Ethernet' },
  { key: 'select', label: 'Find it' },
  { key: 'wifi_confirm', label: 'Configure' },
  { key: 'power_cycle', label: 'WiFi' },
  { key: 'done', label: 'Done' },
]

/** Which marker each state sits under, including the ones the print server owns. */
const UNDER: Record<string, string> = {
  reset: 'reset',
  first_run: 'first_run',
  cable: 'cable',
  discover: 'select',
  select: 'select',
  configure: 'wifi_confirm',
  wifi_confirm: 'wifi_confirm',
  wifi: 'power_cycle',
  power_cycle: 'power_cycle',
  rediscover: 'done',
  done: 'done',
}

function Progress({ state }: { state: string }) {
  const at = ORDER.findIndex((s) => s.key === UNDER[state])
  return (
    <ol className="provision-progress">
      {ORDER.map((s, i) => (
        <li key={s.key} className={i < at ? 'past' : i === at ? 'now' : ''}>
          {s.label}
        </li>
      ))}
    </ol>
  )
}

function Step({
  session,
  busy,
  advance,
  finish,
}: {
  session: ProvisioningSession
  busy: boolean
  advance: (state: string, extra?: Record<string, unknown>) => Promise<void>
  finish: () => Promise<void>
}) {
  switch (session.state) {
    case 'reset':
      return (
        <div className="provision-step">
          <h3>1. Factory-reset the printer</h3>
          <p>
            This is required, and it comes <em>before</em> the Ethernet cable goes in. A printer
            that has been used before carries hundreds of settings we cannot see, and if a previous
            owner changed its password, resetting is the only way back in.
          </p>
          <p className="muted small">Leave the Ethernet cable unplugged for now.</p>
          <p>On the printer's own screen:</p>
          <ol className="provision-keys">
            <li>Menu</li>
            <li>Up / Down until you reach Administration</li>
            <li>OK</li>
            <li>Up / Down until you reach Reset</li>
            <li>OK</li>
            <li>OK to choose Factory Reset</li>
            <li>OK again to confirm</li>
          </ol>
          <p className="warn">Do not switch the printer off while it is resetting.</p>
          <button onClick={() => void advance('first_run')} disabled={busy}>
            I have reset the printer
          </button>
        </div>
      )

    case 'first_run':
      return (
        <div className="provision-step">
          <h3>2. Work through the setup screens</h3>
          <p>
            The printer comes back up asking for a language, then a date and time. Work all the way
            through: choose the language, then press OK through the date and time. They will show
            2017 — that is fine, the clock gets set later.
          </p>
          <p className="warn">
            This has to be finished now. Switching the printer off and on returns to the same
            screen, and until it is done the printer cannot be used — and finishing it overwrites
            the clock, which is why it cannot wait until after we configure anything.
          </p>
          <button onClick={() => void advance('cable')} disabled={busy}>
            I have finished the setup screens
          </button>
        </div>
      )

    case 'cable':
      return (
        <div className="provision-step">
          <h3>3. Connect it to the wired network</h3>
          <p>
            Plug in the Ethernet cable and make sure the printer is switched on. A reset printer has
            no network settings, so it takes an address from the cable and becomes visible to the
            print server.
          </p>
          <button onClick={() => void advance('discover')} disabled={busy}>
            The cable is in and the printer is on
          </button>
        </div>
      )

    case 'select': {
      const candidates = (session.candidates ?? []) as ProvisioningCandidate[]
      return (
        <div className="provision-step">
          <h3>4. Which printer is this?</h3>
          {candidates.length === 0 ? (
            <>
              <p>Nothing was found on the wired network.</p>
              <button onClick={() => void advance('discover')} disabled={busy}>
                Look again
              </button>
            </>
          ) : (
            <>
              <p className="muted small">
                {candidates.length === 1
                  ? 'One printer answered.'
                  : `${candidates.length} printers answered.`}
              </p>
              <table className="data">
                <thead>
                  <tr>
                    <th>IP Address</th>
                    <th>MAC Address</th>
                    <th>Model</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.ip}>
                      <td>
                        <code>{c.ip}</code>
                      </td>
                      <td>
                        <code>{c.mac ?? '—'}</code>
                      </td>
                      <td>{c.model ?? 'unknown'}</td>
                      <td>
                        <button
                          className="btn-sm"
                          disabled={busy}
                          onClick={() =>
                            void advance('configure', { wired_ip: c.ip, model: c.model ?? null })
                          }
                        >
                          This one
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="secondary btn-sm" onClick={() => void advance('discover')} disabled={busy}>
                Look again
              </button>
            </>
          )}
        </div>
      )
    }

    case 'wifi_confirm':
      return <WifiConfirm session={session} busy={busy} advance={advance} />

    case 'power_cycle':
      return (
        <div className="provision-step">
          <h3>6. Turn the printer off and then on again</h3>
          <p>
            Use the power button, not the cable — auto power on does not work while Ethernet is
            connected, so pulling the cord would leave it off.
          </p>
          <p>
            Then watch the WiFi icon on the printer's own screen and wait for it to become{' '}
            <strong>solid</strong>. That can take up to 30 seconds.
          </p>
          <p className="muted small">
            That icon is the only reliable signal here: the printer's own web pages report the
            settings as fine whether or not the radio ever joins the network.
          </p>
          <button onClick={() => void advance('rediscover')} disabled={busy}>
            The WiFi icon is solid
          </button>
        </div>
      )

    case 'done':
      return (
        <div className="provision-step">
          <h3>Done — {session.printer_name} is ready</h3>
          <dl className="provision-facts">
            <dt>Model</dt>
            <dd>{session.model ?? 'unknown'}</dd>
            <dt>Address</dt>
            <dd>
              <code>{session.wireless_ip}</code>
            </dd>
            <dt>Wireless MAC</dt>
            <dd>
              <code>{session.wireless_mac}</code>
            </dd>
          </dl>
          <p>
            It is on the wireless network and answering there with the Ethernet cable still
            connected, so there is nothing further to check before it comes out. To install it:
          </p>
          <ol>
            <li>Unplug the Ethernet cable</li>
            <li>Unplug the power</li>
            <li>Move the printer to where it will live and plug the power back in</li>
          </ol>
          <p className="muted small">It rejoins the wireless network on its own when it powers up.</p>
          <button onClick={() => void finish()} disabled={busy}>
            Finish
          </button>
        </div>
      )

    default:
      return null
  }
}

function WifiConfirm({
  session,
  busy,
  advance,
}: {
  session: ProvisioningSession
  busy: boolean
  advance: (state: string, extra?: Record<string, unknown>) => Promise<void>
}) {
  const [passphrase, setPassphrase] = useState('')
  const [changing, setChanging] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function apply() {
    if (changing) {
      if (!passphrase) return setError('Enter the WiFi password.')
      setSaving(true)
      const { error } = await supabase.rpc('set_provisioning_secret', {
        p_session: session.id,
        p_kind: 'wifi_passphrase',
        p_secret: passphrase,
      })
      setSaving(false)
      if (error) return setError(error.message)
    }
    await advance('wifi')
  }

  return (
    <div className="provision-step">
      <h3>5. Join the WiFi network</h3>
      <p>
        The printer is configured. The last thing to do over the cable is give it the wireless
        network — <strong>{session.ssid}</strong>.
      </p>

      <p className="warn">
        Check the WiFi password before applying it. Once the printer switches to wireless it stops
        answering on Ethernet and does not fall back on its own, so if the password is wrong the
        printer becomes unreachable and the only way forward is a factory reset and starting this
        walkthrough again.
      </p>

      {error && <div className="error">{error}</div>}

      {changing ? (
        <label className="field">
          WiFi password
          <input
            type="text"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="off"
            autoFocus
          />
          <span className="muted small">Shown as you type, so you can check it.</span>
        </label>
      ) : (
        <p className="muted small">
          Using the password you entered at the start.{' '}
          <button className="linkish btn-sm" onClick={() => setChanging(true)}>
            Re-enter it
          </button>
        </p>
      )}

      <button onClick={() => void apply()} disabled={busy || saving}>
        {saving ? 'Saving…' : 'Apply the wireless settings'}
      </button>
    </div>
  )
}
