import { Link } from 'react-router-dom'

const UPDATED = '3 September 2026'

/**
 * Terms of service.
 *
 * Deliberately short and readable. The customers are congregation and school
 * offices, not procurement departments, and a page nobody finishes is worse
 * than a page that says less. The bracketed items are the ones only the
 * business can answer — see docs/PUBLIC_PAGES.md.
 */
export default function Terms() {
  return (
    <main className="page legal">
      <h1>Terms of Service</h1>
      <p className="muted small">Last updated {UPDATED}</p>

      <section>
        <h2>The agreement</h2>
        <p>
          These terms are between Guest Badges, a sole proprietorship in California ("we",
          "us"), and the organization that uses Guest Badges ("you"). By setting up an account or
          using the service, you accept them. If you are agreeing on behalf of an organization,
          you are confirming you may do so.
        </p>
      </section>

      <section>
        <h2>What the service is</h2>
        <p>
          Guest Badges lets people sign in at your door and prints them a name badge. It stores
          those sign-ins for you and, where you configure it, passes them into systems you already
          use. We provide the hosted application; badge printing happens on hardware on your own
          premises.
        </p>
      </section>

      <section>
        <h2>Your side of it</h2>
        <ul>
          <li>
            You decide what to ask visitors for and what to do with it. The information belongs to
            you, and so does the responsibility for collecting it lawfully and telling people why.
          </li>
          <li>
            You keep your accounts secure and only invite people who should see your sign-ins.
          </li>
          <li>
            You do not use the service to break the law, to send people things they did not agree
            to receive, or to interfere with how it works for anyone else.
          </li>
        </ul>
      </section>

      <section>
        <h2>Your data</h2>
        <p>
          Your sign-ins remain yours. We use them to run the service for you and for nothing else —
          we do not sell them and we do not use them for advertising. See the{' '}
          <Link to="/privacy">Privacy Policy</Link> for the detail.
        </p>
        <p>
          You can export or delete your records at any time. If you close your account, we remove
          your data.
        </p>
      </section>

      <section>
        <h2>Availability</h2>
        <p>
          We work to keep the service running but do not promise it will never be unavailable.
          Badge printing is driven by equipment on your premises and depends on your network,
          your printer, and having label stock in it.
        </p>
        <p>
          We may change or improve the service over time. If we make a change that materially
          reduces what it does, we will tell you first.
        </p>
      </section>

      <section>
        <h2>Fees</h2>
        <p>
          Some organizations use the service at no charge. Where a fee does apply, it is the one
          agreed with you in writing, and invoices are due 30 days from their date.
        </p>
        <p>
          If an invoice goes unpaid we will contact you. Should it reach 60 days past due we may
          suspend the service, and we will tell you before we do. Should it reach 90 days past due
          we may close the account and delete your sign-in records — we will give you at least 14
          days' written notice first, and you can export everything at any point up to that.
        </p>
      </section>

      <section>
        <h2>Ending it</h2>
        <p>
          You can stop using the service and close your account whenever you like. We may suspend
          or close an account that breaks these terms, or that puts the service or other customers
          at risk — except where something is causing immediate harm, we will tell you first and
          give you a chance to put it right.
        </p>
      </section>

      <section>
        <h2>Warranties and liability</h2>
        <p>
          The service is provided as it is, without warranties beyond those the law does not let us
          exclude. We are not liable for indirect or consequential losses, or for loss of profits
          or goodwill. Where liability cannot be excluded, it is limited to the fees you paid us in
          the twelve months before the claim.
        </p>
        <p>
          Nothing here limits liability for fraud, or for anything else that cannot lawfully be
          limited.
        </p>
      </section>

      <section>
        <h2>Governing law</h2>
        <p>
          These terms are governed by the laws of the State of California, and the courts of
          California are where any dispute about them is decided.
        </p>
      </section>

      <section>
        <h2>Changes and contact</h2>
        <p>
          If these terms change materially, the date above changes and we tell account holders.
          Questions: <a href="mailto:support@guestbadges.com">support@guestbadges.com</a>.
        </p>
        <p>
          Formal notice under these terms should go to{' '}
          <a href="mailto:sales@guestbadges.com">sales@guestbadges.com</a>.
        </p>
      </section>

      <footer className="page-foot">
        <p>
          <Link to="/">Home</Link> · <Link to="/privacy">Privacy Policy</Link>
        </p>
      </footer>
    </main>
  )
}
