import { Link } from 'react-router-dom'
import { SiteFooter, SiteHeader } from './SiteChrome'

/**
 * What it costs.
 *
 * The figures come from the hardware bill of materials in
 * docs/marketing-onepager.html. Two deliberate departures from that document:
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
            The equipment is ordinary, off-the-shelf, and yours. You buy it from whoever you like,
            it sits in your building, and nothing about it is locked to us. The only thing you pay
            us for is the service that runs it.
          </p>
        </div>
      </div>

      <main className="mk">
        <section>
          <h2>Equipment</h2>
          <p className="mk-sub">
            One print server covers your whole building. Everything after that is per kiosk — per
            door where you want badges to come out.
          </p>

          <table className="mk-price">
            <caption>One-time, for the building</caption>
            <tbody>
              <tr>
                <td>
                  Print server
                  <span className="mk-item-note">
                    A small computer that drives the printers and talks to the service. We build
                    it, set it up for your congregation, and ship it ready to plug in.
                  </span>
                </td>
                <td>$125</td>
              </tr>
            </tbody>
          </table>

          <table className="mk-price">
            <caption>One-time, per kiosk</caption>
            <tbody>
              <tr>
                <td>
                  Label printer
                  <span className="mk-item-note">
                    Brother QL-820NWB. Widely available, and you buy it yourself.
                  </span>
                </td>
                <td>$250</td>
              </tr>
              <tr>
                <td>
                  Wall-mount bracket
                  <span className="mk-item-note">Optional, for a tidy lobby installation.</span>
                </td>
                <td>$100</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td>Per kiosk</td>
                <td>$350</td>
              </tr>
            </tfoot>
          </table>

          <p className="mk-sub">
            So one door comes to about <strong>$475</strong> to set up, and a second door in the
            same building adds <strong>$350</strong> — the print server is already there.
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
          <h2>The small print</h2>
          <p className="mk-sub">
            Equipment prices are indicative, in US dollars, and move with the market — we do not
            sell the printer or the labels, so you will pay whatever your supplier charges on the
            day. Nothing here is proprietary: the printer is a stock Brother model, the labels are
            a standard size, and if you ever stop using the service the hardware is still yours.
          </p>
          <p className="mk-sub">
            Not sure how many kiosks you need? <Link to="/#how">Look at how it works</Link>, then
            tell us how many doors people arrive through and we will help you work it out.
          </p>
        </section>

        <SiteFooter />
      </main>
    </>
  )
}
