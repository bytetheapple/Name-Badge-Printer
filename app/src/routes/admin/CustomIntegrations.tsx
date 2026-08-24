import { useOrg } from '../../lib/org'
import Integrations, { CUSTOM_SPECS } from './Integrations'

/**
 * Pushing sign-ins into an organization's own systems.
 *
 * Neither of these is a product feature that can be switched on from here.
 * Both work by replicating a form submission — reading a congregation's own
 * form, copying its field ids across, and keeping up when it changes — which
 * is bespoke work done by hand. So an org sees the settings only once that
 * work has been done for it, and everyone else sees who to ask.
 *
 * The grant lives on the organization and is set by the platform team; an org
 * cannot turn it on for itself, and a database trigger enforces that rather
 * than this page.
 */
export default function CustomIntegrations() {
  const { org, isAdmin, loading } = useOrg()

  if (!isAdmin) return null
  if (loading) return <p className="muted">Loading…</p>

  if (!org?.organization.custom_integrations) {
    return (
      <>
        <h1>Custom Integrations</h1>
        <section className="card prose">
          <p>
            Sign-ins can be pushed automatically into an existing member tracking system,
            another application, or a spreadsheet, so the contact details people enter at the
            badge printer end up where your office already works.
          </p>
          <p>
            Every system stores its data differently, so each of these is built to fit. If that
            would be useful, contact our support team to talk about a custom integration.
          </p>
        </section>
      </>
    )
  }

  return (
    <>
      <h1>Custom Integrations</h1>
      <p className="muted small" style={{ marginTop: -8, marginBottom: 20 }}>
        Built for {org.organization.name}. Each of these submits a visitor's details to a form
        you already have — no credentials are involved, only the form's address and the names of
        its fields.
      </p>
      <Integrations specs={CUSTOM_SPECS} />
    </>
  )
}
