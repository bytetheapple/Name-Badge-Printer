import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import { invokeFn } from '../../lib/functions'
import OrgLogo from './OrgLogo'

type SelfieMode = 'off' | 'optional' | 'required'

export default function Settings() {
  const { orgId, isAdmin, isOwner } = useOrg()
  const [selfieMode, setSelfieMode] = useState<SelfieMode>('off')
  //: Whether anything can write to this organization's Drive — a connected
  //: Google account, or the service account that path is replacing. An admin
  //: cannot read the integration itself (it belongs to the owner), so this is
  //: the one fact the database will tell them about it.
  const [driveConnected, setDriveConnected] = useState(false)
  const [pronounsEnabled, setPronounsEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  //: The connected Google account, for owners. Admins cannot read the
  //: integration at all — it belongs to the owner — so they see whether
  //: photographs are possible and not whose Drive they land in.
  const [connection, setConnection] = useState<{ id: string; email: string } | null>(null)
  const [testing, setTesting] = useState(false)
  //: What the Google round trip came back saying, if this page started one.
  const [notice, setNotice] = useState<string | null>(null)


  // Back from Google. The selfie requirement is deliberately not applied
  // before the redirect: abandoning the consent screen would otherwise leave
  // photographs switched on with nowhere to store them, which fails in front
  // of a visitor. One more click here, and nothing broken in between.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('connected') === 'google') {
      setNotice('Google connected. Choose a selfie requirement to switch photographs on.')
    } else if (q.get('google_error')) {
      setNotice(null)
      setError(`Google did not complete the connection (${q.get('google_error')}).`)
    } else {
      return
    }
    window.history.replaceState({}, '', window.location.pathname)
  }, [])

  useEffect(() => {
    if (!orgId) return
    void (async () => {
      const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .eq('org_id', orgId)
        .maybeSingle()
      if (error) {
        setError(error.message)
        setLoading(false)
        return
      }
      const mode = (data?.selfie_mode ?? 'off') as SelfieMode
      const pronouns = Boolean(data?.pronouns_enabled)
      setSelfieMode(mode)
      setPronounsEnabled(pronouns)

      // Not filtered on enabled: a revoked connection is exactly the one worth
      // showing, because Reconnect is the way out of it.
      const { data: conn } = await supabase
        .from('integrations')
        .select('id, config')
        .eq('org_id', orgId)
        .eq('kind', 'google_oauth')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      const email = (conn?.config as Record<string, unknown> | null)?.connected_email
      setConnection(conn && typeof email === 'string' ? { id: conn.id as string, email } : null)

      const { data: ready } = await supabase.rpc('integration_ready', {
        p_org: orgId,
        p_kind: 'google_drive',
      })
      setDriveConnected(Boolean(ready))
      setLoading(false)
    })()
  }, [orgId])

  /** Written on click. Nothing else depends on it, so there is nothing for a
   *  Save button to coordinate — only a change to lose by walking away. */
  async function togglePronouns(value: boolean) {
    const before = pronounsEnabled
    setPronounsEnabled(value)
    setError(null)
    const { error } = await supabase
      .from('app_settings')
      .update({ pronouns_enabled: value })
      .eq('org_id', orgId)
    if (error) {
      // Back where it was: a switch showing a state the database does not
      // hold is worse than the failure.
      setPronounsEnabled(before)
      setError(error.message)
      return
    }
  }

  /** Send the owner back to Google, landing here again afterwards. */
  async function reconnect() {
    setSaving(true)
    setError(null)
    const res = await invokeFn('google-oauth-begin', {
      org_id: orgId,
      return_to: '/admin/settings',
    })
    setSaving(false)
    if (!res.ok || typeof res.url !== 'string') {
      setError(res.error ?? 'Could not start the Google connection.')
      return
    }
    window.location.assign(res.url as string)
  }

  /** Spend the refresh token, because nothing else can tell a live credential
   *  from a dead one — the database holds the same row either way. */
  async function testConnection() {
    if (!connection) return
    setTesting(true)
    setError(null)
    setNotice(null)
    const res = await invokeFn('google-oauth-check', {
      org_id: orgId,
      integration_id: connection.id,
    })
    setTesting(false)
    if (!res.ok) {
      setError(res.error ?? 'The connection failed.')
      return
    }
    const mins = Math.round(Number(res.expires_in ?? 0) / 60)
    setNotice(
      `Working. Google issued an access token for ${res.connected_email ?? connection.email}` +
        (mins ? `, good for ${mins} minutes` : '') +
        (res.can_write_files
          ? ', with permission to create files in Drive.'
          : ' — but WITHOUT file access. Reconnect to grant it.'),
    )
  }

  /**
   * Switch photographs on, making whatever that needs.
   *
   * Asking for photographs is the moment an organization needs somewhere to
   * put them, so this is where the Google connection is asked for rather than
   * a prerequisite to be discovered under Integrations. Connecting is an
   * owner's job; an admin is told that rather than sent to a page that will
   * refuse them.
   */
  async function enableWithDrive(next: SelfieMode) {
    if (!isOwner) {
      setError(
        'Photographs need a connected Google account, and connecting one is an owner’s job. ' +
          'Ask an owner of this organization to connect Google, then choose this again.',
      )
      return
    }
    setSaving(true)
    setError(null)
    const res = await invokeFn('google-provision', { org_id: orgId, what: 'drive' })
    setSaving(false)
    if (!res.ok) {
      setError(res.error ?? 'Could not prepare the photographs destination.')
      return
    }
    if (!driveConnected) {
      // Off to Google, and back to this page rather than to Integrations —
      // this is where the question was asked.
      const begin = await invokeFn('google-oauth-begin', {
        org_id: orgId,
        return_to: '/admin/settings',
      })
      if (!begin.ok || typeof begin.url !== 'string') {
        setError(begin.error ?? 'Could not start the Google connection.')
        return
      }
      window.location.assign(begin.url as string)
      return
    }
    void chooseSelfieMode(next)
  }

  /** Written on change, like the pronouns switch. There is nothing left for a
   *  Save button to coordinate: the folder used to be saved alongside this and
   *  had to agree with it, and the folder is now made by the connected account
   *  rather than typed in. */
  async function chooseSelfieMode(next: SelfieMode) {
    const before = selfieMode
    setSelfieMode(next)
    setError(null)
    setSaving(true)
    const { error } = await supabase
      .from('app_settings')
      .update({ selfie_mode: next })
      .eq('org_id', orgId)
    setSaving(false)
    if (error) {
      // Back where it was: a control showing a state the database does not
      // hold is worse than the failure.
      setSelfieMode(before)
      setError(error.message)
      return
    }
  }

  if (loading) return <p className="muted">Loading…</p>
  if (!isAdmin) {
    return (
      <>
        <h1>Settings</h1>
        <p className="muted">Only owners and admins can change settings.</p>
      </>
    )
  }

  return (
    <>
      <h1>Settings</h1>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {/* The column, so the panes line up. Every control on this page writes
          itself on change — there is nothing left to submit. */}
      <div className="config-form">
        <section className="card">
          <h2>Selfie (visitors only)</h2>
          {/* Said before the control rather than after it, because it is the
              reason the control is unavailable. */}
          {!driveConnected && (
            <p className="muted small" style={{ marginBottom: 12 }}>
              Visitor photos are stored in your congregation's own Google Drive.{' '}
              {isOwner
                ? 'Choosing Optional or Required will ask you to connect a Google account, and ' +
                  'the folder is made for you.'
                : 'An owner needs to connect a Google account first — ask one to choose a ' +
                  'selfie requirement here, or to connect Google under Integrations.'}
            </p>
          )}

          <label className="field">
            Selfie requirement
            {/* The control stays live even when Drive is not connected — only
                the two options that need it are unavailable. Disabling the
                whole thing would trap an organization whose Drive was
                disconnected while selfies were switched on: unable to select
                the one value that would stop the failures. */}
            <select
              value={selfieMode}
              disabled={saving}
              onChange={(e) => {
                const next = e.target.value as SelfieMode
                // Belt and braces: the options are disabled, but a keyboard or
                // an older browser can still land here, and silently ignoring
                // the choice would look like the page was broken.
                setError(null)
                // Switching photographs on is what triggers the connection and
                // the destination; switching them off never needs either.
                if (next !== 'off') void enableWithDrive(next)
                else void chooseSelfieMode(next)
              }}
            >
              <option value="off">No selfie</option>
              {/* Not disabled any more. Choosing one is how an owner connects
                  Google — refusing the choice was what made the connection
                  something to go and find first. */}
              <option value="optional">Optional selfie</option>
              <option value="required">Required selfie</option>
            </select>
          </label>

          {/* Whose Drive this is, and the two things worth doing to it. Only
              owners see this: an admin cannot read the integration at all, and
              the address of a congregation's Google account is not theirs to
              hand around. */}
          {isOwner && connection && (
            <div style={{ marginTop: 16 }}>
              <div className="muted small">
                Photographs and sign-ins go to <strong>{connection.email}</strong>.
              </div>
              <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="secondary btn-sm"
                  disabled={saving}
                  onClick={() => void reconnect()}
                >
                  Reconnect Google
                </button>
                <button
                  type="button"
                  className="secondary btn-sm"
                  disabled={testing}
                  onClick={() => void testConnection()}
                >
                  {testing ? 'Asking Google…' : 'Test connection'}
                </button>
              </div>
            </div>
          )}

          {/* Already asking for photos, and Drive has gone away underneath it.
              The urgent case, and the only one where something is actively
              failing in front of visitors. */}
          {!driveConnected && selfieMode !== 'off' && (
            <p className="warn" style={{ marginTop: 8 }}>
              Visitors are being asked for a photo, but no Google account is connected, so every
              upload is failing. Choose <strong>No selfie</strong> here, or ask an owner to
              connect one under Integrations.
            </p>
          )}
        </section>

      <section className="card">
        <h2>Pronouns</h2>
        {/* Takes effect on click, like the integration switches. There is
            nothing to coordinate it with, so making someone press Save for one
            checkbox was only ever a way to lose the change. */}
        <label className="check">
          <input
            type="checkbox"
            checked={pronounsEnabled}
            onChange={(e) => void togglePronouns(e.target.checked)}
          />
          Show an optional pronouns field on the sign-in form
        </label>
      </section>

      {/* In the column too. Outside it the name mark ran to the full width of
          the page against two narrower panes, and picked up none of the
          column's spacing, so it sat tight under Pronouns. */}
      <OrgLogo />
      </div>

    </>
  )
}
