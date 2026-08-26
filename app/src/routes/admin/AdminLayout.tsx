import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { useOrg } from '../../lib/org'

/** The switcher's value when the platform console is showing. Not a real org
 *  id, and deliberately not shaped like one. */
const PLATFORM = '__platform__'

export default function AdminLayout() {
  const { session, signOut } = useAuth()
  const { orgs, org, orgId, role, isAdmin, isPlatformAdmin, loading, error, switchOrg } = useOrg()
  const location = useLocation()
  const navigate = useNavigate()

  // Which "place" the admin is in, taken from the route rather than held in
  // state — so a refresh, a bookmark and the back button all agree.
  const inPlatform = location.pathname.startsWith('/admin/platform')

  function choose(value: string) {
    if (value === PLATFORM) {
      navigate('/admin/platform')
      return
    }
    switchOrg(value)
    // Leaving the platform console needs somewhere to land: its route belongs
    // to no organization, so staying put would show platform data under an
    // org's name.
    if (inPlatform) navigate('/admin/entries')
  }

  if (loading) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    )
  }

  // The console returns no rows to anyone else, so this is not the access
  // control — but platform mode hides the org nav, and someone who typed the
  // URL would otherwise be left on an empty page with nothing to click.
  if (inPlatform && !isPlatformAdmin) {
    return <Navigate to="/admin/entries" replace />
  }

  // Signed in, but not a member of anything: an invited account whose
  // membership has not been created yet, or one that was removed.
  //
  // A platform admin lands on the console instead. Handing an organization
  // over means promoting the real owner and removing yourself, so belonging to
  // nothing is where that flow ends — being locked out at that point would be
  // absurd, and every org-scoped route below would render against a null id.
  if (!orgId && isPlatformAdmin) {
    return <Navigate to="/admin/platform" replace />
  }

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
          {inPlatform ? 'Platform' : (org?.organization.name ?? 'Name Badge Admin')}
          {/* Shown for a platform admin even with a single organization —
              otherwise the console would have no way in. */}
          {(orgs.length > 1 || isPlatformAdmin) && (
            <select
              className="org-switcher"
              value={inPlatform ? PLATFORM : orgId}
              onChange={(e) => choose(e.target.value)}
              aria-label="Switch organization"
            >
              {orgs.map((m) => (
                <option key={m.org_id} value={m.org_id}>
                  {m.organization.name}
                </option>
              ))}
              {isPlatformAdmin && (
                <optgroup label="Name Badge Kiosk">
                  <option value={PLATFORM}>Platform</option>
                </optgroup>
              )}
            </select>
          )}
        </div>
        {/* Every one of these is scoped to an organization, so none of them
            means anything while the platform console is showing. */}
        <nav className="admin-nav">
          {!inPlatform && (
            <>
              <NavLink to="/admin/entries">Entries</NavLink>
              <NavLink to="/admin/status">Print Server</NavLink>
              {isAdmin && <NavLink to="/admin/config">Printers</NavLink>}
              {isAdmin && <NavLink to="/admin/settings">Settings</NavLink>}
              {isAdmin && <NavLink to="/admin/integrations">Integrations</NavLink>}
              {isAdmin && <NavLink to="/admin/members">Members</NavLink>}
            </>
          )}
        </nav>
        <div className="admin-user">
          <span className="muted">
            {session?.user.email}
            {role && !inPlatform && <span className="role-badge">{role}</span>}
          </span>
          <button className="secondary btn-sm" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="admin-main">
        <Outlet />
      </main>
      <footer className="admin-footer">
        Badges print on <strong>Brother DK-1234</strong> die-cut name-badge labels (60 × 86 mm).
        That is the only media this system supports.
      </footer>
    </div>
  )
}
