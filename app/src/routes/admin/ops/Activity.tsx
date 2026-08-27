import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { describeActivity } from '../../../lib/activity'
import type { ActivityEntry } from '../../../lib/types'

const SHOWN = 200

/**
 * Everything anyone did, across every customer.
 *
 * The counterpart to the Activity panel an org's owner sees: they get their own
 * organization's rows, this gets all of them plus the platform-level ones —
 * operators, releases, and organizations that no longer exist to own a row.
 *
 * Nothing here is editable by anyone, including whoever is reading it. The
 * table grants no INSERT, UPDATE or DELETE to any Data API role, and every
 * entry is written by a trigger or a SECURITY DEFINER function.
 */
export default function Activity() {
  const [rows, setRows] = useState<ActivityEntry[]>([])
  const [orgNames, setOrgNames] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  //: Platform-only, org-only, or everything. The two audiences read this for
  //: different reasons and the mix buries both.
  const [scope, setScope] = useState<'all' | 'platform' | 'orgs'>('all')

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('activity_log')
      .select('id, at, org_id, actor_email, action, subject, detail')
      .order('at', { ascending: false })
      .limit(SHOWN)
    if (error) setError(error.message)
    else setRows((data ?? []) as ActivityEntry[])

    const { data: orgs } = await supabase.from('organizations').select('id, name')
    setOrgNames(new Map((orgs ?? []).map((o) => [o.id as string, o.name as string])))
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <p className="muted">Loading…</p>

  const shown = rows.filter((e) =>
    scope === 'all' ? true : scope === 'platform' ? e.org_id === null : e.org_id !== null,
  )

  return (
    <>
      <h1>Activity</h1>
      <p className="muted small">
        The last {SHOWN} things that happened, across every customer. An organization's owner sees
        their own rows on their Members tab; the platform rows are only visible here.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        <label className="field">
          Show
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="all">Everything</option>
            <option value="orgs">Customer organizations</option>
            <option value="platform">Platform only</option>
          </select>
        </label>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Where</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id}>
                <td className="small">{new Date(e.at).toLocaleString()}</td>
                <td className="small">
                  {/* Null when it came from the SQL editor or a background job,
                      which is worth seeing rather than hiding. */}
                  {e.actor_email ?? <span className="muted">no signed-in user</span>}
                </td>
                <td className="small">
                  {e.org_id ? (
                    (orgNames.get(e.org_id) ?? <span className="muted">deleted org</span>)
                  ) : (
                    <span className="muted">Guest Badges</span>
                  )}
                </td>
                <td className="small">{describeActivity(e)}</td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={4} className="muted">
                  Nothing recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
