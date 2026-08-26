import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { PlatformOrg } from '../../lib/types'

/**
 * Building a print server, from a blank card to a device ready to ship.
 *
 * Skippable, and every step is something a person does at a bench — the app
 * cannot reach a Pi on your desk any more than it can reach a printer on a
 * customer's LAN. What it can do is allocate the identity, tell you exactly
 * what to type, and then watch for the device to appear.
 *
 * Nothing sensitive is written to the card except a claim code that is spent
 * the moment it is used, and a Connect key that expires within hours.
 */
export default function BuildServer({
  orgs,
  onDone,
}: {
  orgs: PlatformOrg[]
  onDone: () => void
}) {
  const [orgId, setOrgId] = useState('')
  const [customer, setCustomer] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [built, setBuilt] = useState<{ serial: string; claim_code: string } | null>(null)

  async function allocate() {
    if (!orgId) {
      setError('Choose which organization this server is for.')
      return
    }
    setBusy(true)
    setError(null)
    const { data, error } = await supabase.rpc('allocate_pi_device', {
      p_org: orgId,
      p_customer: customer.trim() || orgs.find((o) => o.org_id === orgId)?.name || null,
      p_notes: notes.trim() || null,
    })
    setBusy(false)
    if (error || !data) {
      setError(error?.message ?? 'Nothing was allocated.')
      return
    }
    setBuilt(data as { serial: string; claim_code: string })
    onDone()
  }

  if (built) {
    return (
      <div className="build-server">
        <h3>{built.serial}</h3>
        <p className="muted small">
          Allocated and recorded. Work through these at the bench — the claim code is shown only
          once, so finish before you close this.
        </p>

        <ol className="build-steps">
          <li>
            <strong>Get a Raspberry Pi Connect auth key.</strong> At{' '}
            <a href="https://connect.raspberrypi.com" target="_blank" rel="noreferrer">
              connect.raspberrypi.com
            </a>
            , create a device auth key. It is single-use and{' '}
            <strong>expires in six hours</strong>, so do this now rather than in advance.
          </li>
          <li>
            <strong>Burn the card</strong> with Raspberry Pi Imager — <em>Raspberry Pi OS Lite
            (64-bit)</em>. In its customisation settings:
            <ul>
              <li>
                Hostname: <code>{built.serial}</code>
              </li>
              <li>Enable SSH, with your public key — not a password</li>
              <li>
                <strong>Leave WiFi blank.</strong> It ships on Ethernet, and the customer's
                wireless is configured at their site.
              </li>
              <li>Set your username, and paste the Connect auth key</li>
            </ul>
          </li>
          <li>
            <strong>Boot it on your Ethernet</strong> and wait for it to appear at
            connect.raspberrypi.com. From a factory image this takes a minute or two.
          </li>
          <li>
            <strong>Open a shell on it</strong> through Connect, and run this. It installs the
            bridge, claims this device's own credential, and starts the service.
            <pre className="token-secret">
              curl -sSL https://guestbadges.com/pi.sh | sudo bash -s -- {built.claim_code}
            </pre>
            <button
              className="secondary btn-sm"
              onClick={() =>
                void navigator.clipboard?.writeText(
                  `curl -sSL https://guestbadges.com/pi.sh | sudo bash -s -- ${built.claim_code}`,
                )
              }
            >
              Copy the command
            </button>
          </li>
          <li>
            <strong>Confirm it.</strong> The script waits for the service to report in and says so.
            This device will then show in the Platform list as online with no printers, which is
            the state to ship in.
          </li>
        </ol>

        <p className="muted small">
          The credential written by that script is replaced by the device itself on its first
          poll, so the value on the card is already stale by the time it reaches a customer.
        </p>

        <button onClick={() => setBuilt(null)}>Done</button>
      </div>
    )
  }

  return (
    <div className="build-server">
      <h3>Build a print server</h3>
      <p className="muted small">
        Allocates the next serial number and a one-time claim code, then walks through imaging the
        card. Skip this if you are not building hardware.
      </p>

      {error && <div className="error">{error}</div>}

      <label className="field">
        For which organization
        <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          <option value="">Choose…</option>
          {orgs.map((o) => (
            <option key={o.org_id} value={o.org_id}>
              {o.name}
            </option>
          ))}
        </select>
        <span className="muted small">
          The device claims a credential scoped to this organization, so it has to be decided
          before the card is written.
        </span>
      </label>

      <label className="field">
        Customer name for the record
        <input
          value={customer}
          onChange={(e) => setCustomer(e.target.value)}
          placeholder="defaults to the organization's name"
        />
        <span className="muted small">
          Kept even if the organization is later renamed or deleted — "what did I ship them"
          outlives both.
        </span>
      </label>

      <label className="field">
        Notes
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
      </label>

      <button onClick={() => void allocate()} disabled={busy}>
        {busy ? 'Allocating…' : 'Allocate a serial and claim code'}
      </button>
    </div>
  )
}
