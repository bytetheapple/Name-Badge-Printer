import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { invokeFn } from '../../lib/functions'
import { useAuth } from '../../lib/auth'
import { useOrg } from '../../lib/org'
import type { OrgMember, Role } from '../../lib/types'

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including managing owners and renaming the organization.',
  admin: 'Manage printers, settings and staff. Cannot change owners.',
  staff: 'View sign-ins, reprint badges and run test prints.',
}

export default function Members() {
  const { session } = useAuth()
  const { orgId, org, isAdmin, isOwner, reload: reloadOrgs } = useOrg()

  const [members, setMembers] = useState<OrgMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('staff')

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    setError(null)
    const { data, error } = await supabase.rpc('org_members', { p_org: orgId })
    if (error) setError(error.message)
    else setMembers((data ?? []) as OrgMember[])
    setLoading(false)
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  /** Owners manage any role; admins only staff. Mirrors the RLS policies. */
  const mayManage = (m: OrgMember) => isOwner || m.role === 'staff'

  async function call(body: Record<string, unknown>, success: string) {
    setNotice(null)
    setError(null)
    const data = await invokeFn('invite-member', body)
    if (!data.ok) {
      setError(data.error ?? 'Something went wrong.')
      return false
    }
    setNotice(success)
    await load()
    await reloadOrgs()
    return true
  }

  async function invite(e: FormEvent) {
    e.preventDefault()
    if (!orgId) return
    setBusy('invite')
    const address = email.trim().toLowerCase()
    const ok = await call(
      { org_id: orgId, email: address, role },
      `Invited ${address} as ${role}. They will get an email to set a password.`,
    )
    setBusy(null)
    if (ok) {
      setEmail('')
      setRole('staff')
    }
  }

  async function changeRole(m: OrgMember, next: Role) {
    if (next === m.role) return
    setBusy(m.user_id)
    await call(
      { action: 'set_role', org_id: orgId, user_id: m.user_id, role: next },
      `${m.email} is now ${next}.`,
    )
    setBusy(null)
  }

  async function remove(m: OrgMember) {
    const self = m.user_id === session?.user.id
    const question = self
      ? `Remove yourself from ${org?.organization.name}? You will lose access immediately.`
      : `Remove ${m.email} from ${org?.organization.name}?`
    if (!window.confirm(question)) return
    setBusy(m.user_id)
    await call({ action: 'remove', org_id: orgId, user_id: m.user_id }, `Removed ${m.email}.`)
    setBusy(null)
  }

  if (!isAdmin) {
    return (
      <>
        <h1>Members</h1>
        <p className="muted">Only owners and admins can manage members.</p>
      </>
    )
  }

  return (
    <>
      <h1>Members</h1>
      <p className="muted">Who can sign in to {org?.organization.name}.</p>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      <section className="card">
        <h2>Invite someone</h2>
        <form onSubmit={invite} className="grid2">
          <label className="field">
            Email address
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.org"
              required
            />
          </label>
          <label className="field">
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="staff">Staff</option>
              {isOwner && <option value="admin">Admin</option>}
              {isOwner && <option value="owner">Owner</option>}
            </select>
          </label>
          <button type="submit" disabled={busy === 'invite' || !email.trim()}>
            {busy === 'invite' ? 'Inviting…' : 'Send invitation'}
          </button>
        </form>
        <p className="muted small" style={{ marginTop: 8 }}>
          {ROLE_HELP[role]}
          {!isOwner && ' Only an owner can invite admins and owners.'}
        </p>
      </section>

      <section className="card">
        <h2>Current members</h2>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id}>
                  <td>
                    {m.email}
                    {m.user_id === session?.user.id && <span className="muted small"> (you)</span>}
                  </td>
                  <td>
                    {mayManage(m) ? (
                      <select
                        value={m.role}
                        disabled={busy === m.user_id}
                        onChange={(e) => void changeRole(m, e.target.value as Role)}
                      >
                        <option value="staff">Staff</option>
                        {isOwner && <option value="admin">Admin</option>}
                        {isOwner && <option value="owner">Owner</option>}
                      </select>
                    ) : (
                      <span>{m.role}</span>
                    )}
                  </td>
                  <td className="muted small">{new Date(m.created_at).toLocaleDateString()}</td>
                  <td>
                    {mayManage(m) && (
                      <button
                        className="secondary btn-sm"
                        disabled={busy === m.user_id}
                        onClick={() => void remove(m)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!members.length && (
                <tr>
                  <td colSpan={4} className="muted">
                    No members yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <p className="muted small" style={{ marginTop: 8 }}>
          The last owner cannot be removed or demoted — promote someone else first.
        </p>
      </section>
    </>
  )
}
