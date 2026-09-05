import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { ServerInterface, ServerNetworkRequest } from '../../lib/types'

/**
 * Put the print server onto a wireless network.
 *
 * This is the one control in the product that can make a print server
 * unreachable, so the shape of it is mostly about that. The server applies the
 * change with a rollback — it must prove it can still reach the service on the
 * new network, and goes back to the old one if it cannot — but a rollback is a
 * recovery, not a licence, and the warning below is the difference between an
 * operator choosing a risk and being handed one.
 *
 * The passphrase is posted to a function that puts it straight into Vault. It
 * is never stored in a column, never read back into a browser, and is
 * destroyed as the bridge collects it.
 */
export default function JoinNetwork({
  orgId,
  request,
  interfaces,
  onChanged,
}: {
  orgId: string
  request: ServerNetworkRequest | null
  interfaces: ServerInterface[]
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [ssid, setSsid] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const waiting = request?.state === 'pending' || request?.state === 'sent'
  // Losing WiFi costs nothing while a cable is in. Without one, the radio is
  // the only way back to this server, and the rollback is all that stands
  // between a typo and a visit.
  const wiredUp = interfaces.some((i) => i.kind === 'wired' && i.ip)

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
    setOpen(false)
    onChanged()
  }

  if (waiting) {
    return (
      <p className="muted small">
        Waiting for the print server to join <strong>{request?.ssid}</strong>. It has up to
        a couple of minutes, and will stay on its current network if the new one cannot
        reach us.
      </p>
    )
  }

  return (
    <>
      {request?.state === 'failed' && request.error && (
        <p className="muted small">
          Joining {request.ssid} did not work. {request.error}
        </p>
      )}
      {!open && (
        <button className="secondary" onClick={() => setOpen(true)}>
          Join a wireless network
        </button>
      )}
      {open && (
        <div className="field-group" style={{ maxWidth: 420 }}>
          <label className="field">
            Network name
            <input
              value={ssid}
              onChange={(e) => setSsid(e.target.value)}
              placeholder="The SSID exactly as it appears"
              autoComplete="off"
            />
          </label>
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
          {/* Said only when it is true. A warning that appears every time is a
              warning nobody reads by the third time. */}
          {!wiredUp && (
            <p className="muted small">
              This print server has no network cable, so its radio is the only way to
              reach it. If the new network does not work it will return to the one it is
              on now — but if that also fails, the server will need attention on site.
            </p>
          )}
          {error && <p className="error small">{error}</p>}
          <div className="modal-actions">
            <button className="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button onClick={submit} disabled={busy}>
              {busy ? 'Sending…' : 'Join network'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
