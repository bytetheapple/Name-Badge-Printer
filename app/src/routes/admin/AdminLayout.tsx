import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../../lib/auth'

export default function AdminLayout() {
  const { session, signOut } = useAuth()

  return (
    <div className="admin">
      <header className="admin-header">
        <div className="admin-brand">Name Badge Admin</div>
        <nav className="admin-nav">
          <NavLink to="/admin/entries">Entries</NavLink>
          <NavLink to="/admin/status">Status</NavLink>
          <NavLink to="/admin/config">Printer</NavLink>
          <NavLink to="/admin/qr">QR Code</NavLink>
          <NavLink to="/admin/settings">Settings</NavLink>
        </nav>
        <div className="admin-user">
          <span className="muted">{session?.user.email}</span>
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
