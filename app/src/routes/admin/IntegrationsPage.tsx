import { useCallback, useEffect, useState } from 'react'
import { useOrg } from '../../lib/org'
import { supabase } from '../../lib/supabase'
import ApiKeys from './ApiKeys'
import Integrations, { CUSTOM_SPECS, EVENT_SPECS, PLATFORM_SPECS } from './Integrations'

type Tab = 'destinations' | 'api'

const TABS: { key: Tab; label: string }[] = [
  { key: 'destinations', label: 'Destinations' },
  { key: 'api', label: 'Print API' },
]

/**
 * Everything that connects this kiosk to something outside it.
 *
 * Two directions, which is why there are two tabs rather than three. A
 * destination is somewhere a sign-in goes; the Print API is how something
 * else reaches in to print a badge. Splitting Drive from the form syncs made
 * sense while an organization had one of each, and stopped making sense once
 * it could have several of any of them.
 *
 * The form syncs are still bespoke work we do by hand and charge for, so those
 * kinds are offered only to an org we have built one for. The grant lives on
 * the organization and a database trigger enforces it, not this component.
 */
export default function IntegrationsPage() {
  const { org, orgId, isAdmin, loading } = useOrg()
  const [tab, setTab] = useState<Tab>('destinations')

  // Entitlements, kept locally so they can be re-read without disturbing
  // anything else.
  //
  // The org context loads once at sign-in and its reload() raises the global
  // loading flag, which blanks the whole admin shell -- fine when switching
  // organizations, wrong for answering "has Events been switched on since I
  // opened this page". So this asks that one question on its own: two
  // booleans, one row, no spinner.
  const [events, setEvents] = useState(false)
  const [custom, setCustom] = useState(false)

  useEffect(() => {
    setEvents(Boolean(org?.organization.events_enabled))
    setCustom(Boolean(org?.organization.custom_integrations))
  }, [org])

  const refreshEntitlements = useCallback(async () => {
    if (!orgId) return
    const { data } = await supabase
      .from('organizations')
      .select('custom_integrations, events_enabled')
      .eq('id', orgId)
      .maybeSingle()
    if (!data) return
    setEvents(Boolean(data.events_enabled))
    setCustom(Boolean(data.custom_integrations))
  }, [orgId])

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
        {tab === 'destinations' && (
          <>
            <Integrations
              // Events are always described, so an event a customer already
              // has never disappears from the page when the entitlement
              // lapses; `unavailable` then stops it running and says why.
              //
              // Custom integrations keep their existing behaviour of being
              // absent entirely without the grant. Two entitlements,
              // deliberately not folded together: a customer may have bespoke
              // syncs without events or events without bespoke syncs, and they
              // are billed differently.
              specs={
                custom
                  ? [...PLATFORM_SPECS, ...EVENT_SPECS, ...CUSTOM_SPECS]
                  : [...PLATFORM_SPECS, ...EVENT_SPECS]
              }
              unavailable={events ? [] : ['event']}
              onOfferKinds={refreshEntitlements}
            />
            {!custom && <CustomOffer />}
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

      </div>
    </>
  )
}

/**
 * The pitch, for an organization that has not bought a form sync.
 *
 * Neither of those uses a credential — both replicate a browser submitting a
 * public form. What they need is a particular congregation's form address and
 * its field ids, which someone has to read off that form and keep up with when
 * it changes. That is work done by hand, per customer, so an org sees the
 * settings only once it has been done for them.
 */
function CustomOffer() {
  return (
    <section className="card prose">
      <h2>Somewhere else?</h2>
      <p>
        Sign-ins can also be pushed automatically into an existing member tracking system, another
        application, or a spreadsheet, so the contact details people enter at the badge printer end
        up where your office already works.
      </p>
      <p>
        Every system stores its data differently, so each of these is built to fit. If that would
        be useful, contact our support team to talk about a custom integration.
      </p>
    </section>
  )
}
