import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { useOrg } from '../../lib/org'

export default function AdminLayout() {
  const { session, signOut } = useAuth()
  const { orgs, org, orgId, role, isAdmin, loading, error, switchOrg } = useOrg()

  if (loading) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    )
  }

  // Signed in, but not a member of anything: an invited account whose
  // membership has not been created yet, or one that was removed.
  if (!orgId) {
    return (
      <main className="page">
        <h1>No organization</h1>
        {error && <div className="error">{error}</div>}
        <p className="muted">
          {session?.user.email} is signed in but does not belong to an organization yet. Ask an
          owner to add you.
        </p>
        <button className="secondary btn-sm" onClick={() => void signOut()}>
          Sign out
        </button>
      </main>
    )
  }

  return (
    <div className="admin">
      <header className="admin-header">
        <div className="admin-brand">
          {org?.organization.name ?? 'Name Badge Admin'}
          {orgs.length > 1 && (
            <select
              className="org-switcher"
              value={orgId}
              onChange={(e) => switchOrg(e.target.value)}
              aria-label="Switch organization"
            >
              {orgs.map((m) => (
                <option key={m.org_id} value={m.org_id}>
                  {m.organization.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <nav className="admin-nav">
          <NavLink to="/admin/entries">Entries</NavLink>
          <NavLink to="/admin/status">Print Server</NavLink>
          {isAdmin && <NavLink to="/admin/config">Printers</NavLink>}
          <NavLink to="/admin/qr">QR Code</NavLink>
          {isAdmin && <NavLink to="/admin/settings">Settings</NavLink>}
          {isAdmin && <NavLink to="/admin/members">Members</NavLink>}
        </nav>
        <div className="admin-user">
          <span className="muted">
            {session?.user.email}
            {role && <span className="role-badge">{role}</span>}
          </span>
          <button className="secondary btn-sm" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  )
}
