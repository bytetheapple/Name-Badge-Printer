import { Link } from 'react-router-dom'
import { SiteFooter, SiteHeader } from './SiteChrome'

/**
 * What it costs.
 *
 * The figures come from the hardware bill of materials in
 * docs/marketing-onepager.html, except the print server, which is $150 here
 * against $125 there — it is the one item bought from us rather than from a
 * supplier, so it is a price rather than an estimate. Two further departures
 * from that document:
 *
 *   * It listed cloud hosting at $10/month as a cost to the congregation. That
 *     was written when a congregation would run the whole thing itself. As a
 *     service, hosting is our cost, not theirs, and listing it here would be
 *     charging twice for the same thing.
 *   * The subscription price is not stated, because it has not been decided.
 *     "Contact us" is an ordinary thing for a page like this to say; inventing
 *     a number would not be.
 */
export default function Pricing() {
  return (
    <>
      <div className="mk">
        <SiteHeader />
      </div>

      <div className="mk-hero">
        <div className="mk-hero-inner">
          <p className="mk-eyebrow">Pricing</p>
          <h1>Buy the hardware once.</h1>
          <p className="mk-lede">
            The printer and the labels are ordinary stock items you buy from whoever you like. The
            print server comes from us, configured and managed. All of it lives in your building,
            and the hardware is yours.
          </p>
        </div>
      </div>

      <main className="mk">
        <section>
          <h2>Equipment</h2>
          <p className="mk-sub">
            One print server covers your whole campus. Everything after that is per kiosk — per
            door where you want badges to come out.
          </p>

          <table className="mk-price">
            <caption>One-time, per campus</caption>
            <tbody>
              <tr>
                <td>
                  Print server
                  <span className="mk-item-note">
                    A computer the size of a deck of playing cards that sits in your wiring closet,
                    drives the printers, and talks to the service. We provide it fully configured
                    and manage it remotely. It arrives ready to plug into your network. Bought from
                    Guest Badges.
                  </span>
                </td>
                <td>$150</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td>Per campus</td>
                <td>$150</td>
              </tr>
            </tfoot>
          </table>

          <table className="mk-price">
            <caption>One-time, per kiosk</caption>
            <tbody>
              <tr>
                <td>
                  Label printer
                  <span className="mk-item-note">
                    Brother QL-820NWB. It joins your wi-fi, so the only cable it needs is power and
                    it can go wherever the badges should come out.
                  </span>
                </td>
                <td>$250*</td>
              </tr>
              <tr>
                <td>
                  Wall-mount bracket
                  <span className="mk-item-note">Optional, for a tidy lobby installation.</span>
                </td>
                <td>$100*</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td>Per kiosk</td>
                <td>$350*</td>
              </tr>
            </tfoot>
          </table>

          <p className="mk-fine">
            * Equipment prices are approximate, in US dollars. We do not sell the printer or the
            labels, so you will pay whatever your supplier charges. The printer and labels are
            broadly available stock Brother items, and if you ever stop using the service the
            hardware is still yours.
          </p>

          <p className="mk-sub">
            So the initial deployment is about <strong>$500</strong> to set up with a single
            printer kiosk. Additional printer kiosks cost <strong>$200–$400</strong> depending on
            how you configure them.
          </p>
        </section>

        <section>
          <h2>Labels</h2>
          <table className="mk-price">
            <tbody>
              <tr>
                <td>
                  Roll of name badges
                  <span className="mk-item-note">
                    250 die-cut badges per roll, about 10¢ a badge. Bought from any supplier —
                    they are a standard Brother size.
                  </span>
                </td>
                <td>$25</td>
              </tr>
            </tbody>
          </table>
          <p className="mk-sub">
            A congregation printing 60 badges a Shabbat morning goes through roughly a roll a
            month.
          </p>
        </section>

        <section className="mk-panel">
          <h2>The service</h2>
          <p>
            A subscription per congregation, whatever number of kiosks you run. It covers the
            hosting, the sign-in pages, the admin console, the integrations with your membership
            system, and keeping the print servers updated and watched.
          </p>
          <p>
            <strong>Talk to us about the price.</strong> We are onboarding our first congregations
            now and would rather quote you honestly than publish a number that does not fit your
            size.
          </p>
          <div className="mk-actions" style={{ marginTop: 18 }}>
            <a className="mk-btn" href="mailto:support@guestbadges.com">
              Ask for a quote
            </a>
          </div>
        </section>

        <section>
          <h2>Not sure how many kiosks you need?</h2>
          <p className="mk-sub">
            <Link to="/#how">Look at how it works</Link>, then tell us how many doors people arrive
            through and we will help you work it out.
          </p>
        </section>

        <SiteFooter />
      </main>
    </>
  )
}
