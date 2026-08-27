import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import type { Operator, OperatorRole } from '../../../lib/types'

/**
 * The people who run the service, as opposed to the people who use it.
 *
 * An operator holds no membership anywhere, which is what keeps them off every
 * customer's Members tab — a fact rather than a filter, because a filtered
 * list is a lie the customer cannot detect.
 *
 * `platform_admins` yields only your own row to a direct query, so that it
 * cannot become a list of who to attack; list_operators() is the only way to
 * see the whole of it, and returns nothing to anyone who is not an operator.
 */
export default function Operators() {
  const { session } = useAuth()
  const [operators, setOperators] = useState<Operator[]>([])
  //: Whether *you* may change this list. Fetched rather than assumed: the
  //: database refuses either way, and a button that fails on click is worse
  //: than one that was never offered.
  const [isOwner, setIsOwner] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OperatorRole>('support')

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('list_operators')
    if (error) setError(error.message)
    else setOperators((data ?? []) as Operator[])
    const { data: owner } = await supabase.rpc('is_platform_owner')
    setIsOwner(Boolean(owner))
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function invite() {
    if (!email.trim()) {
      setError('Enter an email address.')
      return
    }
    setBusy('invite')
    setNotice(null)
    setError(null)
    const { data, error } = await supabase.functions.invoke('invite-operator', {
      body: { email: email.trim(), role },
    })
    setBusy(null)
    if (error || !data?.ok) {
      setError(data?.error ?? error?.message ?? 'Something went wrong.')
      return
    }
    setNotice(
      data.invited
        ? `Invitation sent to ${data.email}. They choose a password from the email.`
        : `${data.email} already had an account and is now an operator.`,
    )
    setEmail('')
    setRole('support')
    setInviting(false)
    await load()
  }

  async function changeRole(op: Operator, next: OperatorRole) {
    setBusy(op.user_id)
    setNotice(null)
    setError(null)
    const { data, error } = await supabase.rpc('set_operator_role', {
      p_user: op.user_id,
      p_role: next,
    })
    setBusy(null)
    if (error) {
      setError(error.message)
      return
    }
    setNotice(`${data ?? op.email} is now ${next === 'owner' ? 'an owner' : 'support'}.`)
    await load()
  }

  async function remove(op: Operator) {
    const self = op.user_id === session?.user.id
    if (
      !window.confirm(
        self
          ? `Step down as an operator? You lose access to every customer immediately, and ` +
            `another owner would have to add you back.`
          : `Remove ${op.email} as an operator? Their account and any congregation ` +
            `membership they hold are untouched.`,
      )
    ) {
      return
    }
    setBusy(op.user_id)
    setNotice(null)
    setError(null)
    const { data, error } = await supabase.rpc('remove_operator', { p_user: op.user_id })
    setBusy(null)
    if (error) {
      setError(error.message)
      return
    }
    setNotice(`${data ?? op.email} is no longer an operator.`)
    await load()
  }

  if (loading) return <p className="muted">Loading…</p>

  const owners = operators.filter((o) => o.role === 'owner').length

  return (
    <>
      <h1>Operators</h1>
      <p className="muted small">
        Guest Badges staff, who can reach every customer's organization. Separate from a
        customer's own Members tab, and never listed there.
      </p>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      {!isOwner && (
        <p className="muted small">
          You are support, so this list is read-only. Adding, removing and re-roling an operator
          is an owner's job.
        </p>
      )}

      <div className="table-wrap">
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
            {operators.map((op) => {
              const self = op.user_id === session?.user.id
              //: The lockout guard, mirrored here so the control is disabled
              //: rather than failing on click. The database enforces it too.
              const lastOwner = op.role === 'owner' && owners === 1
              return (
                <tr key={op.user_id}>
                  <td>
                    {op.email}
                    {self && <span className="muted small"> · you</span>}
                  </td>
                  <td>
                    {isOwner && !lastOwner ? (
                      <select
                        value={op.role}
                        disabled={busy === op.user_id}
                        onChange={(e) => void changeRole(op, e.target.value as OperatorRole)}
                        aria-label={`Role for ${op.email}`}
                      >
                        <option value="owner">owner</option>
                        <option value="support">support</option>
                      </select>
                    ) : (
                      <>
                        <span className="role-badge">{op.role}</span>
                        {lastOwner && <div className="muted small">the only owner</div>}
                      </>
                    )}
                  </td>
                  <td className="small">{new Date(op.created_at).toLocaleDateString()}</td>
                  <td className="actions-cell">
                    <button
                      className="secondary btn-sm danger"
                      disabled={!isOwner || lastOwner || busy === op.user_id}
                      onClick={() => void remove(op)}
                    >
                      {self ? 'Step down' : 'Remove'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <section className="card" style={{ marginTop: 24 }}>
        <h2>What the roles mean</h2>
        <p className="muted small">
          An <strong>owner</strong> may do the irreversible and may change who has access:
          deleting a customer's organization, and adding, removing or re-roling an operator.
        </p>
        <p className="muted small">
          <strong>Support</strong> may do everything else — see every customer, onboard one,
          issue a print-server credential, manage the fleet, and suspend an organization, which
          is reversible in one click.
        </p>
      </section>

      {isOwner && (
        <div className="add-by-hand">
          {inviting ? (
            <div className="manual-address">
              <label className="field">
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="someone@guestbadges.com"
                  autoFocus
                  autoComplete="off"
                />
                <span className="muted small">
                  If they have no account yet they get an invitation email. Someone who already
                  signs in — including as a member of a congregation — is simply added, and keeps
                  that membership.
                </span>
              </label>
              <label className="field">
                Role
                <select value={role} onChange={(e) => setRole(e.target.value as OperatorRole)}>
                  <option value="support">support</option>
                  <option value="owner">owner</option>
                </select>
              </label>
              <div className="modal-actions">
                <button
                  className="secondary"
                  onClick={() => setInviting(false)}
                  disabled={busy === 'invite'}
                >
                  Cancel
                </button>
                <button onClick={() => void invite()} disabled={busy === 'invite'}>
                  {busy === 'invite' ? 'Adding…' : 'Add operator'}
                </button>
              </div>
            </div>
          ) : (
            <button className="secondary btn-sm" onClick={() => setInviting(true)}>
              + Add an operator
            </button>
          )}
        </div>
      )}
    </>
  )
}
