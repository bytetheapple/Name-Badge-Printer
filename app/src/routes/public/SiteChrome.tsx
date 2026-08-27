import { Link } from 'react-router-dom'

/**
 * The header and footer shared by the marketing pages.
 *
 * The legal pages keep their own plain layout and their own footers — they are
 * read by people looking for one clause, and by Google's OAuth reviewers, and
 * neither is helped by a marketing nav.
 */
export function SiteHeader() {
  return (
    <nav className="mk-nav">
      <Link to="/" className="mk-wordmark">
        Guest&nbsp;Badges
      </Link>
      <a href="/#how">How it works</a>
      <a href="/#uses">Use cases</a>
      <Link to="/pricing">Pricing</Link>
      <Link to="/admin">Sign in</Link>
    </nav>
  )
}

export function SiteFooter() {
  return (
    <footer className="mk-foot">
      <span>© Guest Badges</span>
      <Link to="/privacy">Privacy</Link>
      <Link to="/terms">Terms</Link>
      <a href="mailto:support@guestbadges.com">support@guestbadges.com</a>
      <span className="mk-foot-end">
        <Link to="/admin">Sign in</Link>
      </span>
    </footer>
  )
}
