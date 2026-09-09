import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { invokeFn, type FnResult } from '../../lib/functions'
import ActivityLog from './ActivityLog'
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
  const { orgId, org, isOwner, reload: reloadOrgs } = useOrg()

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
  //: Members are the owner's job now — an admin manages the equipment, not
  //: who gets in. So there is no per-row question left to ask.
  const mayManage = (_m: OrgMember) => isOwner

  async function call(
    body: Record<string, unknown>,
    //: A function when the message depends on what actually happened, which
    //: for an invitation it does — see invite() below.
    success: string | ((d: FnResult) => string),
  ) {
    setNotice(null)
    setError(null)
    const data = await invokeFn('invite-member', body)
    if (!data.ok) {
      // `detail` carries what the mail server actually said, which is the only
      // part anyone can act on when an invitation fails to send.
      setError(data.detail ? `${data.error} — ${data.detail}` : (data.error ?? 'Something went wrong.'))
      return false
    }
    // Only when there is something to say. A green banner announcing that the
    // thing you just watched happen has happened is noise, and the reload
    // clears it before it can be read anyway — the list itself is the
    // confirmation. An invitation that sent no email is the exception: that
    // is news, not confirmation.
    const said = typeof success === 'function' ? success(data) : success
    setNotice(said || null)
    await load()
    await reloadOrgs()
    return true
  }

  //: A sign-up link for somebody whose invitation never arrived, shown once
  //: and copyable. Kept in state rather than opened: the owner is going to
  //: send it by some other means, which means they need to hold it.
  const [handover, setHandover] = useState<{ email: string; link: string } | null>(null)

  async function makeLink(m: OrgMember) {
    setNotice(null)
    setError(null)
    setHandover(null)
    setBusy(m.user_id)
    const data = await invokeFn('invite-member', {
      org_id: orgId,
      action: 'link',
      user_id: m.user_id,
    })
    setBusy(null)
    if (!data.ok) {
      setError((data.error as string) ?? 'Could not make a link.')
      return
    }
    setHandover({ email: String(data.email ?? m.email), link: String(data.link) })
  }

  async function invite(e: FormEvent) {
    e.preventDefault()
    if (!orgId) return
    setBusy('invite')
    const address = email.trim().toLowerCase()
    // Which of the two things happened, rather than a promise of an email.
    // Someone who already has an account is simply added and gets nothing —
    // saying "they will get an email" then sends the person who invited them
    // to look for a message that was never sent, and makes a stale account
    // look like a mail failure.
    const ok = await call({ org_id: orgId, email: address, role }, (d) =>
      d.invited
        ? '' // it worked, and the new row in the list says so
        : `${address} already had an account and was added as ${role}. No email was sent — ` +
          `they sign in with their existing password.`,
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
      '', // the row's own role changed in front of you
    )
    setBusy(null)
  }

  async function remove(m: OrgMember) {
    // Plainly what it is. Whether the login survives depends on whether they
    // belong to another organization, and that is not a distinction an owner
    // should have to hold in their head to answer this question.
    if (!window.confirm(`Delete ${m.email}?`)) return
    setBusy(m.user_id)
    await call({ action: 'remove', org_id: orgId, user_id: m.user_id }, '')
    setBusy(null)
  }

  if (!isOwner) {
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

      {/* Shown until it is dismissed, not for a few seconds: whoever asked for
          it is about to paste it into something else, and a message that
          clears itself would take the link with it. */}
      {handover && (
        <div className="notice">
          <p style={{ margin: '0 0 8px' }}>
            A sign-up link for <strong>{handover.email}</strong>. It works once and is not
            sent anywhere — pass it on however reaches them.
          </p>
          <input
            readOnly
            value={handover.link}
            onFocus={(e) => e.currentTarget.select()}
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }}
          />
          <div className="modal-actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="secondary btn-sm"
              onClick={() => void navigator.clipboard?.writeText(handover.link)}
            >
              Copy
            </button>
            <button type="button" className="secondary btn-sm" onClick={() => setHandover(null)}>
              Done
            </button>
          </div>
        </div>
      )}

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
                    {/* Never on your own row. Owners remove other owners; the
                        last one leaves when the operations team closes the
                        account. The database refuses it either way. */}
                    {mayManage(m) && m.user_id !== session?.user.id && (
                      <>
                        {/* For an invitation that never arrived. The function
                            refuses for an account that has signed in before,
                            and says why — so this is offered on every row
                            rather than guessing from data this list does not
                            have. */}
                        <button
                          className="secondary btn-sm"
                          disabled={busy === m.user_id}
                          onClick={() => void makeLink(m)}
                          style={{ marginRight: 8 }}
                        >
                          Sign-up link
                        </button>
                        <button
                          className="secondary btn-sm danger"
                          disabled={busy === m.user_id}
                          onClick={() => void remove(m)}
                        >
                          Delete
                        </button>
                      </>
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
          Deleting someone removes their access here, and their account too if this was their
          only organization. You cannot delete yourself — another owner can. The last owner
          cannot be demoted; promote someone else first.
        </p>
      </section>
    
      <ActivityLog />
    </>
  )
}
