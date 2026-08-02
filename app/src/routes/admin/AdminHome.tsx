import { Link } from 'react-router-dom'
import { ConnectionBanner } from '../../components/ConnectionBanner'

/** Placeholder for the admin console (login in Phase 1; config/entries/status in Phases 4-5). */
export default function AdminHome() {
  return (
    <main className="page">
      <h1>Admin Console</h1>
      <p className="muted">
        Login arrives in Phase 1; printer config, entries table, and status panel in Phases 4-5.
      </p>
      <ConnectionBanner />
      <p className="links">
        <Link to="/">← Public form</Link>
      </p>
    </main>
  )
}
