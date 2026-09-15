import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import { invokeFn } from '../../lib/functions'
import OrgLogo from './OrgLogo'
import {
  defaultFieldConfig,
  resolveFieldConfig,
  type Audience,
  type ConfigField,
  type FieldConfig,
  type FieldState,
} from '../../lib/formConfig'

type SelfieMode = 'off' | 'optional' | 'required'

const STATE_LABEL: Record<FieldState, string> = {
  hidden: 'Hidden',
  optional: 'Optional',
  required: 'Required',
}

/** A hidden / optional / required picker for one field. Locked rows (first and
 *  last name) render the same control disabled, so the "always required" rule
 *  is shown the same way it is set everywhere else. */
function StateControl({
  value,
  onChange,
  disabled,
}: {
  value: FieldState
  onChange?: (s: FieldState) => void
  disabled?: boolean
}) {
  return (
    <div className="seg" role="group">
      {(['hidden', 'optional', 'required'] as FieldState[]).map((s) => (
        <button
          key={s}
          type="button"
          className={`seg-btn${value === s ? ' active' : ''}`}
          aria-pressed={value === s}
          disabled={disabled || !onChange}
          onClick={() => onChange?.(s)}
        >
          {STATE_LABEL[s]}
        </button>
      ))}
    </div>
  )
}

function FieldRow({
  label,
  hint,
  value,
  onChange,
  locked,
}: {
  label: string
  hint?: string
  value: FieldState
  onChange?: (s: FieldState) => void
  locked?: boolean
}) {
  return (
    <div className="field-row">
      <div className="field-row-label">
        {label}
        {hint && <span className="muted small"> · {hint}</span>}
      </div>
      <StateControl value={value} onChange={onChange} disabled={locked} />
    </div>
  )
}

export default function Settings() {
  const { orgId, isAdmin, isOwner } = useOrg()
  const [selfieMode, setSelfieMode] = useState<SelfieMode>('off')
  //: Whether anything can write to this organization's Drive — a connected
  //: Google account, or the service account that path is replacing. An admin
  //: cannot read the integration itself (it belongs to the owner), so this is
  //: the one fact the database will tell them about it.
  const [driveConnected, setDriveConnected] = useState(false)
  //: The form shape, per audience. The panel's two tabs edit the two halves.
  const [fieldConfig, setFieldConfig] = useState<FieldConfig>(() => defaultFieldConfig(false))
  const [tab, setTab] = useState<Audience>('member')
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
      setSelfieMode(mode)
      // pronouns_enabled seeds only the default for a row that has never been
      // edited; once field_config is set it is the authority.
      setFieldConfig(resolveFieldConfig(data?.field_config, Boolean(data?.pronouns_enabled)))

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

  /** Set one field's state for one audience, written on click like every other
   *  control here. The whole config is written each time — one column, always
   *  complete — so a partial row can never be stored. */
  async function setFieldState(audience: Audience, field: ConfigField, state: FieldState) {
    const before = fieldConfig
    const next: FieldConfig = {
      ...fieldConfig,
      [audience]: { ...fieldConfig[audience], [field]: state },
    }
    setFieldConfig(next)
    setError(null)
    const { error } = await supabase
      .from('app_settings')
      .update({ field_config: next })
      .eq('org_id', orgId)
    if (error) {
      // Back where it was: a control showing a state the database does not hold
      // is worse than the failure.
      setFieldConfig(before)
      setError(error.message)
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
        {/* The sign-in form's shape, for every printer. Two tabs, one per kind
            of person; each question can be required, optional or hidden. First
            and last name are always asked, so they are shown but locked. */}
        <section className="card form-config">
          <h2>Sign-in form</h2>
          <p className="muted small" style={{ marginBottom: 14 }}>
            Which questions each person answers, and whether each is required. First and last name
            are always asked. This applies to every printer.
          </p>

          <div className="printer-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={`printer-tab${tab === 'member' ? ' active' : ''}`}
              onClick={() => setTab('member')}
            >
              Member
            </button>
            <button
              type="button"
              role="tab"
              className={`printer-tab${tab === 'visitor' ? ' active' : ''}`}
              onClick={() => setTab('visitor')}
            >
              Visitor
            </button>
          </div>

          <div className="field-rows">
            <FieldRow label="First name" hint="always asked" value="required" locked />
            <FieldRow label="Last name" hint="always asked" value="required" locked />
            <FieldRow
              label="Pronouns"
              value={fieldConfig[tab].pronouns}
              onChange={(s) => void setFieldState(tab, 'pronouns', s)}
            />
            <FieldRow
              label="Phone"
              value={fieldConfig[tab].phone}
              onChange={(s) => void setFieldState(tab, 'phone', s)}
            />
            <FieldRow
              label="Email"
              value={fieldConfig[tab].email}
              onChange={(s) => void setFieldState(tab, 'email', s)}
            />

            {/* Photo is visitor-only and lives in selfie_mode, not field_config
                — it is tied to the Google Drive the pictures are stored in. On
                the member tab it is simply not offered. */}
            {tab === 'visitor' && (
              <div className="field-row">
                <div className="field-row-label">
                  Photo
                  <span className="muted small"> · stored in your Google Drive</span>
                </div>
                <StateControl
                  value={selfieMode === 'off' ? 'hidden' : selfieMode}
                  disabled={saving}
                  onChange={(s) => {
                    setError(null)
                    // Switching photos on is what asks for the Google connection
                    // and makes the folder; switching them off needs neither.
                    if (s === 'hidden') void chooseSelfieMode('off')
                    else void enableWithDrive(s)
                  }}
                />
              </div>
            )}
          </div>

          {/* Where the photos go. Only on the visitor tab, where Photo lives. */}
          {tab === 'visitor' && (
            <div className="photo-storage">
              {!driveConnected && (
                <p className="muted small">
                  Visitor photos are stored in your congregation's own Google Drive.{' '}
                  {isOwner
                    ? 'Choosing Optional or Required will ask you to connect a Google account, and ' +
                      'the folder is made for you.'
                    : 'An owner needs to connect a Google account first — ask one to choose a ' +
                      'photo requirement here, or to connect Google under Integrations.'}
                </p>
              )}

              {isOwner && connection && (
                <div style={{ marginTop: 12 }}>
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

              {/* Already asking for photos, and Drive has gone away underneath
                  it — the one case where something is actively failing. */}
              {!driveConnected && selfieMode !== 'off' && (
                <p className="warn" style={{ marginTop: 10 }}>
                  Visitors are being asked for a photo, but no Google account is connected, so every
                  upload is failing. Set Photo to <strong>Hidden</strong> here, or ask an owner to
                  connect one under Integrations.
                </p>
              )}
            </div>
          )}
        </section>

      {/* In the column too. Outside it the name mark ran to the full width of
          the page against two narrower panes, and picked up none of the
          column's spacing, so it sat tight under Pronouns. */}
      <OrgLogo />
      </div>

    </>
  )
}
