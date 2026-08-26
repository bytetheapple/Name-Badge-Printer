import { Link } from 'react-router-dom'

/**
 * What guestbadges.com shows to someone who is not standing at a kiosk.
 *
 * It exists because Google's OAuth review wants a home page that explains what
 * the application does, alongside the privacy policy and terms — but it is
 * also simply what the domain should say to anyone who types it in.
 *
 * The kiosk form still owns `/` when a printer is named in the query string,
 * so QR codes already hanging in lobbies are untouched. See Root in main.tsx.
 */
export default function Landing() {
  return (
    <main className="page">
      <header className="page-head">
        <h1>Guest Badges</h1>
        <p className="lede">
          A sign-in kiosk that prints a name badge. Someone arriving at your building types their
          name on a tablet, and a badge comes out of the printer in the lobby.
        </p>
      </header>

      <section>
        <h2>What it does</h2>
        <p>
          A congregation, school, or office puts a tablet by the door with a QR code beside it.
          A visitor scans or taps, enters their name — and, if you ask for them, an email address,
          phone number, or photo — and a printed badge is waiting for them a few seconds later.
        </p>
        <p>
          The details they enter can be sent automatically into the systems you already use: a
          Google Form, a spreadsheet, or a membership system, so your office is not retyping
          anything.
        </p>
      </section>

      <section>
        <h2>How it is put together</h2>
        <p>
          A small computer on your own network drives the printer, so badges keep printing whether
          or not the internet is up at that moment. Each organization's sign-ins are separate from
          every other organization's, and only people you invite can see yours.
        </p>
      </section>

      <section>
        <h2>Connecting a Google account</h2>
        <p>
          If you choose to send sign-ins to Google Sheets or store visitor photos in Google Drive,
          you can connect a Google account instead of setting up credentials by hand. We ask for
          the narrowest permission Google offers for this — the application can only see files it
          created itself, never the rest of your Drive. You can disconnect at any time, from here
          or from your Google account settings.
        </p>
      </section>

      <footer className="page-foot">
        <p>
          <Link to="/privacy">Privacy Policy</Link> · <Link to="/terms">Terms of Service</Link> ·{' '}
          <a href="mailto:support@guestbadges.com">support@guestbadges.com</a>
        </p>
        <p className="muted small">
          Already have an account? <Link to="/admin">Sign in</Link>.
        </p>
      </footer>
    </main>
  )
}
