import { Link } from 'react-router-dom'
import { ConnectionBanner } from '../components/ConnectionBanner'

/** Placeholder for the public QR-code badge form (built in Phase 3). */
export default function PublicForm() {
  return (
    <main className="page">
      <h1>Shir Hadash</h1>
      <h2>Name Badge</h2>
      <p className="muted">The public badge form will live here (Phase 3).</p>
      <ConnectionBanner />
      <p className="links">
        <Link to="/admin">Admin console →</Link>
      </p>
    </main>
  )
}
