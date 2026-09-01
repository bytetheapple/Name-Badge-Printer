import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import type { ProvisioningCandidate, ProvisioningSession } from '../../lib/types'

const COLUMNS =
  'id, org_id, state, printer_name, location, ssid, candidates, wired_ip, model, ' +
  'serial, firmware, visible_networks, wireless_mac, wireless_ip, printer_id, ' +
  'task_started_at, log, ' +
  'error, created_at, updated_at'

/** States where we are waiting on the print server rather than on the operator. */
const BRIDGE_STATES = new Set(['discover', 'configure', 'wifi', 'rediscover'])

const WAITING_LABEL: Record<string, string> = {
  discover: 'Step 4 of 8 — looking for the printer on the wired network…',
  configure: 'Step 5 of 8 — configuring the printer you chose…',
  wifi: 'Step 6 of 8 — writing the wireless settings…',
  rediscover: 'Step 8 of 8 — looking for the printer on the wireless network…',
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
  //: Which session we have already announced, so the printer list is reloaded
  //: once rather than on every poll.
  const announced = useRef<string | null>(null)

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

  // The printer row is created the moment the last step reports done — by the
  // server, not by this page — so the tab for it exists before anyone presses
  // Finish. Waiting for that press left the page showing a printer list from
  // before the setup, which reads as the setup having failed.
  useEffect(() => {
    if (session?.state === 'done' && session.printer_id && announced.current !== session.id) {
      announced.current = session.id
      onFinished()
    }
  }, [session, onFinished])

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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    if (!name.trim()) return setError('Give the printer a name.')

    setSaving(true)
    setError(null)
    const { data, error } = await supabase
      .from('provisioning_sessions')
      .insert({
        org_id: orgId,
        state: 'reset',
        printer_name: name.trim(),
        location: location.trim() || null,
      })
      .select('id')
      .maybeSingle()
    if (error || !data) {
      setSaving(false)
      setError(error?.message ?? 'Could not start the setup.')
      return
    }

    // Neither secret is asked for here. The printer's own code comes once a
    // printer has been chosen — each has a different one on its label, so
    // asking before we know which printer produces the wrong answer. The WiFi
    // password comes at step 5, once the printer can say which networks it can
    // see.
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
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        Location
        <input value={location} onChange={(e) => setLocation(e.target.value)} />
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

/**
 * Name the printer's wireless address, when the sweep cannot reach it.
 *
 * Wireless clients often land on a different subnet from the wired side, and
 * neither a /24 sweep nor mDNS crosses one — so a printer that joined the
 * network perfectly well can still be invisible from the print server. The
 * address is on the printer's own screen, which is faster than debugging it.
 *
 * Skips straight to done: reaching this step means the WiFi settings applied,
 * and the address given is the proof the operator has.
 */
function ManualWireless({
  session,
  busy,
  advance,
}: {
  session: ProvisioningSession
  busy: boolean
  advance: (state: string, extra?: Record<string, unknown>) => Promise<void>
}) {
  const { orgId } = useOrg()
  const [open, setOpen] = useState(false)
  const [ip, setIp] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The printer row is normally created server-side when the bridge reports
  // the last step done. This path never reaches the bridge, so it has to do
  // the same work — otherwise the wizard finishes and adds no printer.
  async function finishHere(address: string) {
    if (!orgId) return
    setSaving(true)
    const { data, error } = await supabase
      .from('printers')
      .insert({
        org_id: orgId,
        name: session.printer_name?.trim() || 'New Printer',
        location: session.location ?? null,
        printer_ip: address,
        port: 9100,
      })
      .select('id')
      .maybeSingle()
    setSaving(false)
    if (error) {
      setError(error.message)
      return
    }
    await advance('done', { wireless_ip: address, printer_id: data?.id ?? null })
  }

  if (!open) {
    return (
      <p className="muted small" style={{ marginTop: 16 }}>
        Print server on a different network from the printer?{' '}
        <button className="linkish btn-sm" onClick={() => setOpen(true)}>
          Enter the wireless address yourself
        </button>
      </p>
    )
  }

  return (
    <div className="manual-address">
      {error && <div className="error">{error}</div>}
      <label className="field">
        Wireless address
        <input
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="192.168.1.127"
          autoFocus
        />
        <span className="muted small">
          On the printer: Menu → Information → WLAN. This is the address it took on the wireless
          network, which is not the one it had on the cable.
        </span>
      </label>
      <div className="modal-actions">
        <button className="secondary" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button
          onClick={() => {
            const value = ip.trim()
            if (!value || /\s/.test(value)) return setError('That does not look like an address.')
            void finishHere(value)
          }}
          disabled={busy || saving}
        >
          {saving ? 'Adding…' : 'Use this address'}
        </button>
      </div>
    </div>
  )
}

/** The way in when a scan cannot see the printer. Tucked away, since it is the
 *  exception — but on every screen where someone might need it. */
function Manual({
  busy,
  advance,
}: {
  busy: boolean
  advance: (state: string, extra?: Record<string, unknown>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <p className="muted small" style={{ marginTop: 16 }}>
        Printer not showing up?{' '}
        <button className="linkish btn-sm" onClick={() => setOpen(true)}>
          Enter its address yourself
        </button>
      </p>
    )
  }
  return <ManualAddress busy={busy} advance={advance} onCancel={() => setOpen(false)} />
}

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
  password: 'select',
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
          <Manual busy={busy} advance={advance} />
        </div>
      )

    case 'select': {
      const candidates = (session.candidates ?? []) as ProvisioningCandidate[]
      const fresh = candidates.filter((c) => !c.configured_as)
      return (
        <div className="provision-step">
          <h3>4. Which printer do you want to configure?</h3>
          {candidates.length === 0 ? (
            <>
              <p>Nothing was found on the wired network.</p>
              <button onClick={() => void advance('discover')} disabled={busy}>
                Look again
              </button>
              <Manual busy={busy} advance={advance} />
            </>
          ) : (
            <>
              <p className="muted small">
                {fresh.length === 0
                  ? 'Only printers already in service answered — none of these is the one you are setting up.'
                  : fresh.length === 1
                    ? 'One new printer answered.'
                    : `${fresh.length} new printers answered.`}
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
                    <tr key={c.ip} style={c.configured_as ? { opacity: 0.6 } : undefined}>
                      <td>
                        <code>{c.ip}</code>
                      </td>
                      <td>
                        <code>{c.mac ?? '—'}</code>
                      </td>
                      <td>{c.model ?? 'unknown'}</td>
                      <td>
                        {/* A printer already in service is shown so the list
                            makes sense, but never offered as a target: setting
                            it up again would rewrite a working printer. */}
                        {c.configured_as ? (
                          <span className="muted small">Already set up as {c.configured_as}</span>
                        ) : (
                          <button
                            className="btn-sm"
                            disabled={busy}
                            onClick={() =>
                              void advance('password', { wired_ip: c.ip, model: c.model ?? null })
                            }
                          >
                            This one
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="secondary btn-sm" onClick={() => void advance('discover')} disabled={busy}>
                Look again
              </button>
              <Manual busy={busy} advance={advance} />
            </>
          )}
        </div>
      )
    }

    case 'password':
      return <PrinterPassword session={session} busy={busy} advance={advance} />

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
          <ManualWireless session={session} busy={busy} advance={advance} />
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

/**
 * Choose the network and give its password — the point of no return.
 *
 * The list comes from the printer's own site survey, taken while it was being
 * configured. That matters more than convenience: this model is 2.4GHz only,
 * so a list from a phone or from the print server can offer a 5GHz network it
 * is physically unable to join, and there is no way back from that but a
 * factory reset.
 *
 * A survey is not the last word, though. Printers are often set up at a desk
 * and installed somewhere else, so naming a network that is not in the list
 * has to stay just as easy.
 */
/**
 * Name the printer's address directly.
 *
 * Discovery sweeps the print server's own /24 for port 9100, which misses a
 * printer on another subnet, and skips one whose print service has not started
 * — a freshly reset printer answers a ping long before it answers anything
 * else. Neither is worth debugging with a printer in your hands and an address
 * you can read off its own screen.
 */
function ManualAddress({
  busy,
  advance,
  onCancel,
}: {
  busy: boolean
  advance: (state: string, extra?: Record<string, unknown>) => Promise<void>
  onCancel?: () => void
}) {
  const [ip, setIp] = useState('')
  const [error, setError] = useState<string | null>(null)

  function go() {
    const value = ip.trim()
    // Deliberately loose: a hostname is a legitimate answer too, and the next
    // step fails clearly enough if nothing is there.
    if (!value) return setError("Enter the printer's address.")
    if (/\s/.test(value)) return setError('That does not look like an address.')
    void advance('password', { wired_ip: value, model: null })
  }

  return (
    <div className="manual-address">
      {error && <div className="error">{error}</div>}
      <label className="field">
        Printer address
        <input
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="192.168.1.50"
          autoFocus
        />
        <span className="muted small">
          On the printer: Menu → Information → check the wired address. Its print service must be
          running, which means the first-run language and date screens are finished.
        </span>
      </label>
      <div className="modal-actions">
        {onCancel && (
          <button className="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button onClick={go} disabled={busy}>
          Use this address
        </button>
      </div>
    </div>
  )
}

/**
 * The code out of what someone typed off the label.
 *
 * The label prints "Pwd:" and then the code, so the whole line is what gets
 * typed — copying only the part after the colon is a thing you do once you
 * know it matters. Rejecting that would be pedantry, and worse, the failure
 * would arrive minutes later as a refused login.
 *
 * No real code as an example here, deliberately: one belonging to an actual
 * printer was used once and lived in this comment for a while.
 *
 * The colon is required before anything is stripped. Without that guard a code
 * that happened to begin with those three letters would be quietly mangled,
 * which is a far worse failure than not helping.
 */
function printerCode(input: string): string {
  return input.replace(/^\s*pwd\s*:\s*/i, '').trim()
}

/**
 * The code on the chosen printer's own label.
 *
 * Asked here rather than at the start because each printer has a different
 * one, and until a printer has been chosen there is no right answer to give.
 * Asking up front looked tidier and, in the field, produced a session holding
 * one printer's code while the wizard talked to another.
 */
function PrinterPassword({
  session,
  busy,
  advance,
}: {
  session: ProvisioningSession
  busy: boolean
  advance: (state: string, extra?: Record<string, unknown>) => Promise<void>
}) {
  const [code, setCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function go() {
    const secret = printerCode(code)
    if (!secret) return setError('Enter the code from the printer.')
    setSaving(true)
    const { error } = await supabase.rpc('set_provisioning_secret', {
      p_session: session.id,
      p_kind: 'web_password',
      p_secret: secret,
    })
    setSaving(false)
    if (error) return setError(error.message)
    await advance('configure')
  }

  return (
    <div className="provision-step">
      <h3>Enter the printer's Password (Pwd:)</h3>
      <p>
        Setting up the printer at <code>{session.wired_ip}</code>
        {session.model ? ` — ${session.model}` : ''}.
      </p>
      <p className="muted small">
        Look on the back of the printer. Below the bar code, find the line starting
        &ldquo;Pwd:&rdquo; and enter everything after it. The code is eight characters and
        mixes capitals, small letters, digits and symbols such as{' '}
        <code>#</code>, <code>%</code> and <code>-</code>. If it begins with{' '}
        <code>#</code>, that character is part of the code — type it too.
      </p>

      {error && <div className="error">{error}</div>}

      <label className="field">
        <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoFocus />
      </label>

      <button onClick={() => void go()} disabled={busy || saving}>
        {saving ? 'Saving…' : 'Configure this printer'}
      </button>
    </div>
  )
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
  const seen = (session.visible_networks ?? []).filter(Boolean)
  const [choice, setChoice] = useState(session.ssid ?? '')
  const [manual, setManual] = useState(seen.length === 0)
  const [typed, setTyped] = useState(session.ssid ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [passphrase2, setPassphrase2] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ssid = manual ? typed.trim() : choice

  async function apply() {
    if (!ssid) return setError('Choose the network the printer should join.')
    if (!passphrase) return setError('Enter the WiFi password.')
    if (passphrase !== passphrase2) return setError('The two WiFi passwords do not match.')

    setSaving(true)
    const { error } = await supabase.rpc('set_provisioning_secret', {
      p_session: session.id,
      p_kind: 'wifi_passphrase',
      p_secret: passphrase,
    })
    setSaving(false)
    if (error) return setError(error.message)
    await advance('wifi', { ssid })
  }

  return (
    <div className="provision-step">
      <h3>5. Join the WiFi network</h3>
      <p>
        The printer is configured. The last thing to do over the cable is tell it which wireless
        network to join once the cable comes out.
      </p>

      <p className="warn">
        Check the network and password before applying them. Once the printer switches to wireless
        it stops answering on Ethernet and does not fall back on its own, so if either is wrong the
        printer becomes unreachable and the only way forward is a factory reset and starting this
        walkthrough again.
      </p>

      {error && <div className="error">{error}</div>}

      <fieldset className="subform">
        <legend>WiFi credentials for the printer to use</legend>

        {seen.length > 0 && (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              Networks the printer itself can see from where it is now.
            </p>
            <ul className="network-list">
              {seen.map((network) => (
                <li key={network}>
                  <label>
                    <input
                      type="radio"
                      name="ssid"
                      checked={!manual && choice === network}
                      onChange={() => {
                        setManual(false)
                        setChoice(network)
                      }}
                    />
                    {network}
                  </label>
                </li>
              ))}
              <li>
                <label>
                  <input type="radio" name="ssid" checked={manual} onChange={() => setManual(true)} />
                  Another network, not listed here
                </label>
              </li>
            </ul>
          </>
        )}

        {manual && (
          <label className="field">
            WiFi network
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus={seen.length > 0} />
            <span className="muted small">
              {seen.length > 0
                ? 'Use this for the network where the printer will actually live, if it is out of range from here.'
                : 'The printer reported no networks it can see, so this one has to be typed. It can only use 2.4GHz networks.'}
            </span>
          </label>
        )}

        {/* Typed twice rather than shown back: there is no way to check a WiFi
            password after it has been used, only to discover it was wrong. */}
        <label className="field">
          WiFi password
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="field">
          WiFi password again
          <input
            type="password"
            value={passphrase2}
            onChange={(e) => setPassphrase2(e.target.value)}
            autoComplete="new-password"
          />
        </label>
      </fieldset>

      <button onClick={() => void apply()} disabled={busy || saving}>
        {saving ? 'Saving…' : 'Apply the wireless settings'}
      </button>
    </div>
  )
}
