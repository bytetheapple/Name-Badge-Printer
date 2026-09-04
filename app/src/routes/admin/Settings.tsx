import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import OrgLogo from './OrgLogo'

type SelfieMode = 'off' | 'optional' | 'required'

export default function Settings() {
  const { orgId, isAdmin } = useOrg()
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

      {/* The column, so the panes line up. Every control on this page writes
          itself on change — there is nothing left to submit. */}
      <div className="config-form">
        <section className="card">
          <h2>Selfie (visitors only)</h2>
          {/* Said before the control rather than after it, because it is the
              reason the control is unavailable. */}
          {!driveConnected && (
            <p className="muted small" style={{ marginBottom: 12 }}>
              Visitor photos are stored in your congregation's Google Drive, so a Google account
              has to be connected before they can be collected. An owner can do that under{' '}
              <strong>Integrations → Google account</strong>. Until then the only option here is
              no selfie.
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
                if (next !== 'off' && !driveConnected) {
                  setError(
                    'Connect a Google account under Integrations before collecting visitor ' +
                      'photos.',
                  )
                  return
                }
                setError(null)
                void chooseSelfieMode(next)
              }}
            >
              <option value="off">No selfie</option>
              <option value="optional" disabled={!driveConnected}>
                Optional selfie
              </option>
              <option value="required" disabled={!driveConnected}>
                Required selfie
              </option>
            </select>
          </label>

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
