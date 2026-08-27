import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import type { ActivityEntry } from '../../lib/types'

const SHOWN = 50

/** Plain English for one entry. The action names are stable identifiers meant
 *  for querying; this is the part a person reads. */
function describe(e: ActivityEntry): string {
  const d = e.detail ?? {}
  switch (e.action) {
    case 'member.add':
      return d.invited
        ? `invited ${e.subject} as ${d.role}`
        : `added ${e.subject} as ${d.role} (existing account, no email sent)`
    case 'member.role':
      return `changed ${e.subject} from ${d.from} to ${d.to}`
    case 'member.remove':
      return d.account_deleted
        ? `deleted ${e.subject} — their account was removed as well`
        : `removed ${e.subject} from this organization`
    default:
      return `${e.action} ${e.subject ?? ''}`.trim()
  }
}

/**
 * Who changed what, for one organization.
 *
 * Readable by the org's owner and by nobody else in the org, and writable
 * through the Data API by nobody at all — entries arrive via the service_role.
 * A log its own subject can edit would be decoration.
 */
export default function ActivityLog() {
  const { orgId, isOwner } = useOrg()
  const [rows, setRows] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!orgId) return
    const { data, error } = await supabase
      .from('activity_log')
      .select('id, at, org_id, actor_email, action, subject, detail')
      .eq('org_id', orgId)
      .order('at', { ascending: false })
      .limit(SHOWN)
    if (error) setError(error.message)
    else setRows((data ?? []) as ActivityEntry[])
    setLoading(false)
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  if (!isOwner || loading) return null

  return (
    <section style={{ marginTop: 36 }}>
      <h2>Activity</h2>
      <p className="muted small">
        Changes to who has access to this organization. Recorded automatically and not editable
        by anyone, including you.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="small">{new Date(e.at).toLocaleString()}</td>
                <td className="small">{e.actor_email ?? <span className="muted">—</span>}</td>
                <td className="small">{describe(e)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={3} className="muted">
                  Nothing recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
