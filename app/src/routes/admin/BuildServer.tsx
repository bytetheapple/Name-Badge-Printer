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
          once, so do not close this until step 3 is done.
        </p>

        <ol className="build-steps">
          <li>
            <strong>Burn the card</strong> with Raspberry Pi Imager, choosing{' '}
            <em>Raspberry Pi OS Lite (64-bit)</em>. Open its OS customisation settings before
            writing, and work down them:
            <ul>
              <li>
                <strong>Hostname</strong> — <code>{built.serial}</code>. This is how the device
                identifies itself on a network and in Connect, and it matches its row here.
              </li>
              <li>
                <strong>Locale settings</strong> — set the time zone to{' '}
                <strong>where the printer will live</strong>, not where you are building it. The
                Pi sets the printer's own clock from its local time, so a device built in one
                zone for a congregation in another gets it wrong, and nobody notices until a
                badge is timestamped.
              </li>
              <li>
                <strong>Username and password</strong> — use the same username on every device
                so support is predictable; something like <code>gbadmin</code>. The password is
                not for logging in — you will use your SSH key for that — but{' '}
                <strong>sudo asks for it</strong>, including in step 3 below and any time you
                need it later.
                <br />
                <strong>Record it.</strong> Put the password in your own password manager against
                this serial. It is deliberately not stored here: a fleet of sudo passwords in a
                database would make this app a skeleton key for every customer's network.
              </li>
              <li>
                <strong>Wireless LAN</strong> — leave it blank. The device ships on Ethernet, and
                the customer's wireless is a separate decision made at their site.
              </li>
              <li>
                <strong>Enable SSH</strong> — "Allow public-key authentication only", and paste
                your public key.
              </li>
              <li>
                <strong>Enable Raspberry Pi Connect</strong> — click{' '}
                <em>Launch Raspberry Pi Connect</em>, sign in, and the auth token fills itself in
                after a moment. It is single-use and short-lived, which is why it is generated
                here rather than in advance.
              </li>
            </ul>
            Then write the image.
          </li>
          <li>
            <strong>Eject the card, put it in the Pi, and boot it on your Ethernet.</strong> It
            appears at{' '}
            <a href="https://connect.raspberrypi.com" target="_blank" rel="noreferrer">
              connect.raspberrypi.com
            </a>{' '}
            after a minute or two — the first boot resizes the filesystem and reboots itself, so
            give it longer than you expect.
          </li>
          <li>
            <strong>Open a shell on it</strong> from Connect, and run this. It claims this
            device's credential, installs the bridge, and starts it.
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
            <br />
            <span className="muted small">
              sudo will ask for the password you set in step 1.
            </span>
          </li>
          <li>
            <strong>Confirm it.</strong> The script waits for the service to report in and says
            so. The device then shows in the list above as online with no printers, which is the
            state to ship in.
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
