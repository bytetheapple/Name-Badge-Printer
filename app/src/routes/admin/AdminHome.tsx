import { Link } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { ConnectionBanner } from '../../components/ConnectionBanner'

/** Admin console home (protected). Config/entries/status arrive in Phases 4-5. */
export default function AdminHome() {
  const { session, signOut } = useAuth()

  return (
    <main className="page">
      <h1>Admin Console</h1>
      <p className="muted">Signed in as {session?.user.email}</p>
      <ConnectionBanner />
      <p className="muted">Printer config, entries table, and status panel arrive in Phases 4-5.</p>
      <div className="actions">
        <button className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
        <Link to="/">← Public form</Link>
      </div>
    </main>
  )
}
