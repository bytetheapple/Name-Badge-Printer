import { Link } from 'react-router-dom'

/** Last substantive change. Shown so a reader can tell whether it has moved. */
const UPDATED = '25 August 2026'

/**
 * The privacy policy.
 *
 * Written against what the code actually does rather than from a template:
 * every category of data named here is one the application really collects,
 * and every destination is one it really sends to. That matters beyond honesty
 * — Google's OAuth review reads this page and compares it to the scopes the
 * application requests.
 */
export default function Privacy() {
  return (
    <main className="page legal">
      <h1>Privacy Policy</h1>
      <p className="muted small">Last updated {UPDATED}</p>

      <section>
        <h2>Who this covers</h2>
        <p>
          Guest Badges is used by organizations — congregations, schools, offices — to sign people
          in at their door. There are two groups of people whose information passes through it:
          <strong> visitors</strong>, who enter their details at a kiosk, and{' '}
          <strong>administrators</strong>, who run the system for their organization.
        </p>
        <p>
          The organization decides what to ask visitors for and what to do with the answers. We
          store and move that information on their behalf. If you signed in at someone's door and
          want your details removed, ask that organization — they can delete them, and they are the
          ones who decided to collect them.
        </p>
      </section>

      <section>
        <h2>What we collect from visitors</h2>
        <p>Only what the kiosk asks for, which the organization chooses:</p>
        <ul>
          <li>First and last name, and the names of anyone signing in with them</li>
          <li>Pronouns, if the organization has turned that on and the visitor fills it in</li>
          <li>Email address and phone number</li>
          <li>Whether they identified as a visitor or a member</li>
          <li>A photograph, if the organization asks for one</li>
          <li>The date and time of the sign-in</li>
        </ul>
        <p>
          We do not use any of this for advertising, we do not sell it, and we do not combine it
          across organizations. There is no tracking of visitors between sites or over time.
        </p>
      </section>

      <section>
        <h2>What we collect from administrators</h2>
        <p>
          An email address and a password, to sign in. Passwords are stored hashed by our
          authentication provider and are never visible to us.
        </p>
      </section>

      <section>
        <h2>Where it goes</h2>
        <p>
          Sign-ins are stored in our hosted database, separated by organization so that one
          organization's records are not reachable from another's account.
        </p>
        <p>Beyond that, information leaves only where the organization has configured it to:</p>
        <ul>
          <li>a Google Form or spreadsheet belonging to that organization</li>
          <li>a membership system such as ShulCloud, submitted to that organization's own form</li>
          <li>a Google Drive folder belonging to that organization, for visitor photographs</li>
          <li>the badge printer on the organization's own premises</li>
        </ul>
        <p>
          We use service providers to host the application, the database, and file storage. They
          process data on our instructions and for no other purpose.
        </p>
      </section>

      <section>
        <h2>Google account data</h2>
        <p>
          An administrator may connect a Google account so that sign-ins and photographs can be
          written to their own Google Drive. When they do, we request only:
        </p>
        <ul>
          <li>
            <strong>Your email address and basic profile</strong> — so the application can show
            which account is connected.
          </li>
          <li>
            <strong>Permission to work with files the application creates</strong> (the{' '}
            <code>drive.file</code> scope) — the narrowest permission Google offers for this. The
            application can see and change only the files and folders it created itself. It cannot
            see, read, or alter anything else in the Drive, including files created before the
            connection was made.
          </li>
        </ul>
        <p>
          The access credential Google issues is stored encrypted and is used only to write the
          sign-ins and photographs described above. It is deleted when the connection is removed.
        </p>
        <p>
          Guest Badges' use of information received from Google APIs adheres to the{' '}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. We do not transfer this data to others except
          as needed to provide the service, we do not use it for advertising, and no human reads it
          except where necessary for security or support, or where the law requires it.
        </p>
        <p>
          You can disconnect at any time in the application's Integrations settings, or revoke it
          directly at{' '}
          <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
            myaccount.google.com/permissions
          </a>
          . Files already written to your Drive are yours and stay where they are.
        </p>
      </section>

      <section>
        <h2>How long it is kept</h2>
        <p>
          Sign-in records are kept until the organization deletes them or closes its account.
          Administrators can delete records at any time. When an account is closed, its data is
          removed.
        </p>
      </section>

      <section>
        <h2>Security</h2>
        <p>
          Traffic is encrypted in transit. Credentials — the connection to a Google account, the
          keys used by the printer on your premises — are stored encrypted and are never displayed
          back after they are set. Access is separated by organization and enforced by the
          database itself, not only by the application.
        </p>
      </section>

      <section>
        <h2>Children</h2>
        <p>
          The service is not directed at children, but an organization may sign in a family, and a
          parent may enter a child's name. That information is treated exactly like any other
          sign-in and is under the control of the organization that collected it.
        </p>
      </section>

      <section>
        <h2>Changes and contact</h2>
        <p>
          If this policy changes materially, the date above changes and organizations using the
          service are told. Questions, or a request about your own information:{' '}
          <a href="mailto:support@guestbadges.com">support@guestbadges.com</a>.
        </p>
      </section>

      <footer className="page-foot">
        <p>
          <Link to="/">Home</Link> · <Link to="/terms">Terms of Service</Link>
        </p>
      </footer>
    </main>
  )
}
