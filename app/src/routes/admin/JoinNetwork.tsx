import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { ServerInterface, VisibleNetwork } from '../../lib/types'

/**
 * The form for putting a print server onto a wireless network.
 *
 * Only the form: the button that opens it lives in the WiFi card, because
 * that is the thing it is about, and it is only offered when that card has no
 * address. A server already on a network does not need a way to move to
 * another one — that is a bench operation, not a console one.
 *
 * This is the one control in the product that can make a print server
 * unreachable. The server applies the change with a rollback, but a rollback
 * is a recovery rather than a licence, and the warning below is the
 * difference between an operator choosing a risk and being handed one.
 *
 * The passphrase goes to a function that puts it straight into Vault. It is
 * never stored in a column, never read back into a browser, and is destroyed
 * as the bridge collects it.
 */
export default function JoinNetwork({
  orgId,
  interfaces,
  networks,
  onDone,
  onCancel,
}: {
  orgId: string
  interfaces: ServerInterface[]
  /** What the print server's radio can see. Chosen from rather than typed:
   *  getting a name wrong produces "No network with SSID 'x' found", which is
   *  also what a switched-off radio produces, and telling those apart cost an
   *  afternoon on site. Empty when the radio is off or the server is too old
   *  to report a scan, and then the name is typed. */
  networks: VisibleNetwork[]
  onDone: () => void
  onCancel: () => void
}) {
  const [ssid, setSsid] = useState('')
  //: Set when the operator chooses "another network", for one that is hidden
  //: or out of range of the server but not of the person standing near it.
  const [byHand, setByHand] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Losing WiFi costs nothing while a cable is in. Without one, the radio is
  // the only way back to this server, and the rollback is all that stands
  // between a typo and a drive to the site.
  const wiredUp = interfaces.some((i) => i.kind === 'wired' && i.ip)
  // Known only because the scan says so. A network typed by hand could be
  // either, and asking for a passphrase that is not needed is better than
  // silently not asking for one that is.
  const chosen = networks.find((n) => n.ssid === ssid)
  const isOpen = Boolean(chosen && !chosen.secure)

  async function submit() {
    if (!ssid.trim()) {
      setError('Enter the name of the network to join.')
      return
    }
    setBusy(true)
    setError(null)
    const { error } = await supabase.rpc('request_server_network', {
      p_org: orgId,
      p_ssid: ssid.trim(),
      p_passphrase: passphrase,
    })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    // Held no longer than it takes to hand over.
    setPassphrase('')
    setSsid('')
    onDone()
  }

  return (
    <div className="field-group" style={{ maxWidth: 420, marginTop: 12 }}>
      {networks.length > 0 && !byHand ? (
        <label className="field">
          Network
          <select
            value={ssid}
            onChange={(e) => {
              if (e.target.value === '__other') {
                setByHand(true)
                setSsid('')
                return
              }
              setSsid(e.target.value)
            }}
          >
            <option value="">Choose a network…</option>
            {networks.map((n) => (
              <option key={n.ssid} value={n.ssid}>
                {n.ssid} · {n.signal}%{n.secure ? '' : ' · open'}
              </option>
            ))}
            {/* A hidden network broadcasts no name, and one the server cannot
                hear from where it sits may still be the right answer. */}
            <option value="__other">Another network…</option>
          </select>
          <span className="muted small">
            What this print server can see, strongest first.
          </span>
        </label>
      ) : (
        <label className="field">
          Network name
          <input
            value={ssid}
            onChange={(e) => setSsid(e.target.value)}
            placeholder="The SSID exactly as it appears"
            autoComplete="off"
          />
          {networks.length > 0 && (
            <button type="button" className="linkish" onClick={() => setByHand(false)}>
              Choose from the networks it can see
            </button>
          )}
        </label>
      )}
      {isOpen ? (
        <p className="muted small">
          {ssid} is an open network and needs no passphrase.
        </p>
      ) : (
        <label className="field">
          Passphrase
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="new-password"
          />
          <span className="muted small">
            Leave empty for an open network. It is stored encrypted, used once, and
            deleted as the print server takes it.
          </span>
        </label>
      )}
      {/* Said only when it is true. A warning that appears every time is a
          warning nobody reads by the third time. */}
      {!wiredUp && (
        <p className="muted small">
          This print server has no network cable, so its radio is the only way to reach
          it. If the new network does not work it will return to the one it is on now —
          but if that also fails, the server will need attention on site.
        </p>
      )}
      {error && <p className="error small">{error}</p>}
      <div className="modal-actions">
        <button className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button onClick={submit} disabled={busy}>
          {busy ? 'Sending…' : 'Join network'}
        </button>
      </div>
    </div>
  )
}
