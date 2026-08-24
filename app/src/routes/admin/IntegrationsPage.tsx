import { useState } from 'react'
import { useOrg } from '../../lib/org'
import ApiKeys from './ApiKeys'
import Integrations, { CUSTOM_SPECS } from './Integrations'

type Tab = 'drive' | 'api' | 'custom'

const TABS: { key: Tab; label: string }[] = [
  { key: 'drive', label: 'Google Drive' },
  { key: 'api', label: 'Print API' },
  { key: 'custom', label: 'Custom Integrations' },
]

/**
 * Everything that connects this kiosk to something outside it.
 *
 * The three are not the same kind of thing, which is why they are separated
 * rather than stacked. Drive and the Print API are product features any
 * organization can turn on for itself. Custom integrations are bespoke work we
 * do by hand and charge for, so that tab is shown in full only to an org we
 * have actually built one for.
 */
export default function IntegrationsPage() {
  const { org, isAdmin, loading } = useOrg()
  const [tab, setTab] = useState<Tab>('drive')

  if (!isAdmin) return null
  if (loading) return <p className="muted">Loading…</p>

  return (
    <>
      <h1>Integrations</h1>

      <div className="subtabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`subtab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="subtab-panel">
        {tab === 'drive' && (
          <>
            <p className="muted small">
              Visitor selfies are uploaded to Google Drive. Whether one is asked for, and which
              folder it lands in, are set under Settings → Visitor selfie.
            </p>
            <Integrations />
          </>
        )}

        {tab === 'api' && (
          <>
            <p className="muted small">
              Keys for printing a badge from another system. Each is shown once and can be
              revoked without affecting the others.
            </p>
            <ApiKeys />
          </>
        )}

        {tab === 'custom' && <Custom name={org?.organization.name ?? ''} granted={Boolean(org?.organization.custom_integrations)} />}
      </div>
    </>
  )
}

/**
 * Pushing sign-ins into an organization's own systems.
 *
 * Neither of these uses a credential — both replicate a browser submitting a
 * public form. What they need is a particular congregation's form address and
 * its field ids, which someone has to read off that form and keep up with when
 * it changes. That is work done by hand, per customer, so an org sees the
 * settings only once it has been done for them.
 *
 * The grant lives on the organization and a database trigger enforces it, not
 * this component.
 */
function Custom({ name, granted }: { name: string; granted: boolean }) {
  if (!granted) {
    return (
      <section className="card prose">
        <p>
          Sign-ins can be pushed automatically into an existing member tracking system, another
          application, or a spreadsheet, so the contact details people enter at the badge printer
          end up where your office already works.
        </p>
        <p>
          Every system stores its data differently, so each of these is built to fit. If that
          would be useful, contact our support team to talk about a custom integration.
        </p>
      </section>
    )
  }

  return (
    <>
      <p className="muted small">
        Built for {name}. Each of these submits a visitor's details to a form you already have —
        no credentials are involved, only the form's address and the names of its fields.
      </p>
      <Integrations specs={CUSTOM_SPECS} />
    </>
  )
}
