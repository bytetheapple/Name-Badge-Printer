import { Link } from 'react-router-dom'
import { SiteFooter, SiteHeader } from './SiteChrome'

/**
 * What guestbadges.com shows to someone who is not standing at a kiosk.
 *
 * It began as the page Google's OAuth review requires — a home page that
 * explains what the application does, alongside the privacy policy and terms —
 * and the section on connecting a Google account is still written for that
 * reviewer as much as for a customer. Do not remove it.
 *
 * The kiosk form still owns `/` when a printer is named in the query string,
 * so QR codes already hanging in lobbies are untouched. See Root in main.tsx.
 */
export default function Landing() {
  return (
    <>
      <div className="mk">
        <SiteHeader />
      </div>

      <div className="mk-hero">
        <div className="mk-hero-inner">
          <p className="mk-eyebrow">Sign-in kiosk for congregations</p>
          <h1>Welcome everyone by name.</h1>
          <p className="mk-lede">
            A visitor scans the QR code by your door, types their name on their own phone, and a
            printed name badge is waiting a few seconds later. No volunteer stuck at a table, no
            app to install, no handwriting on sticky labels.
          </p>
          <div className="mk-actions">
            <Link className="mk-btn" to="/pricing">
              What it costs
            </Link>
            <a className="mk-btn ghost" href="mailto:support@guestbadges.com">
              Get in touch
            </a>
          </div>
        </div>
      </div>

      <main className="mk">
        <section id="how">
          <h2>How it works</h2>
          <p className="mk-sub">
            Four steps, and the visitor does the first three on the phone already in their hand.
          </p>
          <div className="mk-steps">
            <div className="mk-step">
              <h3>Scan</h3>
              <p>A QR code by the door opens the sign-in page. Nothing to download.</p>
            </div>
            <div className="mk-step">
              <h3>Member or guest</h3>
              <p>One tap picks the right form, so each is only asked what it needs.</p>
            </div>
            <div className="mk-step">
              <h3>Enter a name</h3>
              <p>
                Just a name, or a whole family at once — plus anything else you have chosen to ask.
              </p>
            </div>
            <div className="mk-step">
              <h3>Badge prints</h3>
              <p>A clean badge with your logo on it comes out of the lobby printer.</p>
            </div>
          </div>
        </section>

        <section id="features">
          <h2>What it does</h2>
          <p className="mk-sub">
            Built for the people who actually run a welcome desk — and for the office that has to
            live with whatever the welcome desk collects.
          </p>
          <div className="mk-features">
            <div className="mk-feature">
              <h3>Simple and self-service</h3>
              <ul>
                <li>Works on any phone through a QR code, with nothing to install</li>
                <li>Separate member and visitor flows, each asking only what it needs</li>
                <li>Family sign-in prints a badge for everyone in the household at once</li>
                <li>Reprints in one tap when a badge comes out wrong</li>
              </ul>
            </div>
            <div className="mk-feature">
              <h3>Warm and inclusive</h3>
              <ul>
                <li>An optional pronouns field you can switch on for Pride or any event</li>
                <li>Your congregation's own logo and wording on every badge</li>
                <li>Optional guest photo, saved to a Drive folder you choose</li>
                <li>Different wording per kiosk — a lobby desk and a social hall can differ</li>
              </ul>
            </div>
            <div className="mk-feature">
              <h3>Easy for the office</h3>
              <ul>
                <li>An attendance log with date filters and one-click export</li>
                <li>Printer status at a glance: online, unreachable, or out of labels</li>
                <li>Several kiosks at once — lobby, religious school, social hall</li>
                <li>Roles, so a volunteer can run the desk without changing settings</li>
              </ul>
            </div>
            <div className="mk-feature">
              <h3>Connects to what you have</h3>
              <ul>
                <li>Sign-ins flow into your membership system automatically</li>
                <li>Google Sheets and Google Drive, if that is where your records live</li>
                <li>A simple API, so another application can print a badge directly</li>
                <li>Nothing to retype at the office on Monday morning</li>
              </ul>
            </div>
          </div>
        </section>

        <section>
          <h2>How it is put together</h2>
          <p className="mk-sub">
            The part that matters on a busy morning: a small print server sits on your own network
            and drives the printer directly, so badges keep coming out whether or not your internet
            is having a good day. We build that server, set it up for your congregation, and ship
            it ready to plug in.
          </p>
          <div className="mk-features">
            <div className="mk-feature">
              <h3>Yours alone</h3>
              <ul>
                <li>Each congregation's sign-ins are separate from every other one's</li>
                <li>Only people you invite can see yours</li>
                <li>You decide what the form asks for, and what it does not</li>
              </ul>
            </div>
            <div className="mk-feature">
              <h3>Looked after</h3>
              <ul>
                <li>The print server updates itself, and puts the old version back if an update
                  misbehaves</li>
                <li>We can see that a printer has gone offline without seeing who signed in</li>
                <li>You buy the printer and labels from anyone you like — nothing is proprietary</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="mk-panel">
          <h2>Connecting a Google account</h2>
          <p>
            If you choose to send sign-ins to Google Sheets or store visitor photos in Google
            Drive, you can connect a Google account instead of setting up credentials by hand. We
            ask for the narrowest permission Google offers for this — the application can only see
            files it created itself, never the rest of your Drive. You can disconnect at any time,
            from here or from your Google account settings.
          </p>
          <p>
            Connecting Google is entirely optional. Everything else works without it.
          </p>
        </section>

        <section>
          <h2>Bring it to your congregation</h2>
          <p className="mk-sub">
            Tell us roughly how many doors you need to cover and we will tell you what it would
            take. There is no commitment in asking.
          </p>
          <div className="mk-actions">
            <a className="mk-btn" href="mailto:support@guestbadges.com">
              Email us
            </a>
            <Link className="mk-btn ghost" to="/pricing">
              See what it costs
            </Link>
          </div>
        </section>

        <SiteFooter />
      </main>
    </>
  )
}
