import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { useOrg } from '../../lib/org'

/** The switcher's value for the Operations context. Not a real org id, and
 *  deliberately not shaped like one. */
const OPS = '__operations__'

const OPS_HOME = '/admin/ops/organizations'

export default function AdminLayout() {
  const { session, signOut } = useAuth()
  const {
    orgs, org, orgId, role, isAdmin, isOwner, isPlatformAdmin, isMember, loading, error, switchOrg,
  } = useOrg()
  const location = useLocation()
  const navigate = useNavigate()

  // Which "place" the admin is in, taken from the route rather than held in
  // state — so a refresh, a bookmark and the back button all agree.
  const inOps = location.pathname.startsWith('/admin/ops')

  // Inside a customer's organization on operator authority rather than a
  // membership of your own. Not shown in Operations — that is the operator's
  // own space — and not shown to someone who genuinely belongs here, which is
  // why it asks about membership rather than about being an operator.
  const operating = isPlatformAdmin && !inOps && !isMember

  function choose(value: string) {
    if (value === OPS) {
      navigate(OPS_HOME)
      return
    }
    switchOrg(value)
    // Leaving Operations needs somewhere to land: its routes belong to no
    // organization, so staying put would show cross-tenant data under one
    // org's name.
    if (inOps) navigate('/admin/entries')
  }

  if (loading) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    )
  }

  // Presentation rather than access control — platform_overview() returns
  // nothing to anyone else, so reaching these by URL would show empty tables
  // rather than another org's data. But Operations hides the org nav, and
  // someone who typed the URL would be left with nothing to click.
  if (inOps && !isPlatformAdmin) {
    return <Navigate to="/admin/entries" replace />
  }

  // Below here an organization is required — but Operations belongs to none,
  // and an operator holds no memberships at all, which is the entire point of
  // them. So this whole branch is skipped in Operations. Without that, an
  // operator standing on OPS_HOME with no memberships is redirected to
  // OPS_HOME, which returns a redirect instead of the layout, and the page
  // renders nothing at all — no header, no nav, forever.
  if (!orgId && !inOps) {
    // Handing an organization over means promoting the real owner and removing
    // yourself, so belonging to nothing is where that flow ends. An operator
    // goes to Operations rather than being locked out of their own app.
    if (isPlatformAdmin) {
      return <Navigate to={OPS_HOME} replace />
    }

    // Signed in but a member of nothing: an invited account whose membership
    // has not been created yet, or one that was removed.
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
    <div className={`admin${operating ? ' operating' : ''}`}>
      {operating && (
        <div className="op-banner">
          ⚠ You are in <strong>{org?.organization.name}</strong> as Guest Badges operations. Changes
          here affect a customer.
          <button onClick={() => navigate(OPS_HOME)}>Back to Operations</button>
        </div>
      )}
      <header className="admin-header">
        <div className="admin-brand">
          {inOps ? 'Operations' : (org?.organization.name ?? 'Name Badge Admin')}
          {/* Shown for an operator even with a single organization —
              otherwise Operations would have no way in. */}
          {(orgs.length > 1 || isPlatformAdmin) && (
            <select
              className="org-switcher"
              value={inOps ? OPS : (orgId ?? '')}
              onChange={(e) => choose(e.target.value)}
              aria-label="Switch organization"
            >
              {/* Grouped only for an operator, for whom the list holds two
                  kinds of thing. A customer sees a plain list of their own
                  organizations and no headings to wonder about. */}
              {isPlatformAdmin ? (
                <>
                  {/* Omitted entirely when empty, which is the normal state
                      for an operator: they hold no memberships, and an empty
                      group heading reads as something failing to load. */}
                  {orgs.length > 0 && (
                    <optgroup label="Customer organizations">
                      {orgs.map((m) => (
                        <option key={m.org_id} value={m.org_id}>
                          {m.organization.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Guest Badges">
                    <option value={OPS}>Operations</option>
                  </optgroup>
                </>
              ) : (
                orgs.map((m) => (
                  <option key={m.org_id} value={m.org_id}>
                    {m.organization.name}
                  </option>
                ))
              )}
            </select>
          )}
        </div>
        {/* Two navs, never both: the org tabs are all scoped to one
            organization and mean nothing in Operations, and vice versa. */}
        <nav className="admin-nav">
          {inOps ? (
            <>
              <NavLink to={OPS_HOME}>Organizations</NavLink>
              <NavLink to="/admin/ops/fleet">Fleet</NavLink>
              <NavLink to="/admin/ops/operators">Operators</NavLink>
              <NavLink to="/admin/ops/activity">Activity</NavLink>
            </>
          ) : (
            <>
              <NavLink to="/admin/entries">Entries</NavLink>
              <NavLink to="/admin/status">Print Server</NavLink>
              {isAdmin && <NavLink to="/admin/config">Printers</NavLink>}
              {isAdmin && <NavLink to="/admin/settings">Settings</NavLink>}
              {/* Owner, not admin: both hand out a way in. Printers and
                  Settings stay with admin — the equipment. */}
              {isOwner && <NavLink to="/admin/integrations">Integrations</NavLink>}
              {isOwner && <NavLink to="/admin/members">Members</NavLink>}
            </>
          )}
        </nav>
        <div className="admin-user">
          <span className="muted">
            {session?.user.email}
            {role && !inOps && <span className="role-badge">{role}</span>}
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
