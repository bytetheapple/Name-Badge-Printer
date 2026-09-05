import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import EventPrinters from './EventPrinters'
import { invokeFn } from '../../lib/functions'
import { useOrg } from '../../lib/org'
import type { Integration, IntegrationKind } from '../../lib/types'

export { CUSTOM_SPECS, EVENT_SPECS, PLATFORM_SPECS }

const COLUMNS =
  'id, org_id, kind, name, enabled, default_enabled, config, updated_at, created_at'

/**
 * Where an `opens` link should point, or null if there is nowhere to go.
 *
 * An empty string is not an address. Left unchecked it becomes href="", which
 * a browser resolves to the current page — so the link "worked", opened a new
 * window, and showed the admin console again.
 */
function openHref(
  opens: {
    urlKey: string
    fromId?: { key: string; prefix: string }
    viewable?: (stored: string) => string
  },
  config: Record<string, unknown>,
): string | null {
  const url = String(config[opens.urlKey] ?? '').trim()
  if (url.startsWith('http')) return opens.viewable ? opens.viewable(url) : url
  const id = opens.fromId ? String(config[opens.fromId.key] ?? '').trim() : ''
  return id ? `${opens.fromId!.prefix}${id}/edit` : null
}

/** One control the scan found on the customer's form. */
type ScannedField = { name: string; type: string; label: string }

type Field = {
  key: string
  label: string
  type?: 'text' | 'checkbox' | 'json'
  hint?: string
  placeholder?: string
  /** This field holds a form control's name, so it can be picked from a scan
   *  of the form rather than transcribed out of the page's HTML. */
  mappable?: boolean
}

type Spec = {
  kind: IntegrationKind
  title: string
  blurb?: string
  fields: Field[]
  /** Set when the form itself can be read to list its fields. `urlKey` names
   *  the config entry holding the address to read. */
  scan?: { urlKey: string; fn: string }
  /** Set when this integration is configured by connecting an account rather
   *  than by typing credentials — the card shows a Connect button. */
  /** Named by the application rather than by the operator: there is nothing
   *  to distinguish, because the destination makes its own. */
  autoNamed?: boolean
  /** A destination this integration made for itself, worth offering a way in
   *  to — the config holds the address, but nobody thinks to look there. */
  opens?: {
    urlKey: string
    label: string
    fromId?: { key: string; prefix: string }
    /** Turn what is stored into something a browser can show. A Google Form's
     *  stored address is the endpoint its answers are posted to, which is not
     *  a page. */
    viewable?: (stored: string) => string
  }
  /** Set when this integration also stores a credential in Vault. */
  secret?: { label: string; hint: string }
  /** Not somewhere sign-ins are delivered. An event is its own destination:
   *  registrations go to its attendee list and its badges to the printer whose
   *  code was scanned, so "enabled", "who does it take" and "on by default for
   *  printers" are all answering questions it does not have. */
  notADestination?: boolean
  /** Every control on this kind writes as it is changed, so there is nothing
   *  for a Save button to do. Mixing the two in one panel is worse than
   *  either: adding a printer took effect immediately while the setting
   *  beside it waited for a button, and no label distinguished them. */
  savesItself?: boolean
}

// What each integration needs, in the same shape the Edge Functions read.
//
// Split by who owns the setup rather than by vendor. The two form syncs are
// bespoke work — someone has to read a congregation's own form and copy its
// field ids across — so they live behind the custom-integrations grant. Drive
// is part of the product: any org that wants selfies needs it.
const CUSTOM_SPECS: Spec[] = [
  {
    kind: 'google_form',
    title: 'Google Form',
    opens: {
      urlKey: 'response_url',
      label: 'Open the form',
      // What is stored is where answers are POSTed; the page a person can read
      // is the same address ending in /viewform. Opening the stored one gives
      // a Google error page, which looks like the integration is broken.
      viewable: (u) => u.replace(/\/formResponse\b.*$/, '/viewform'),
    },
    blurb: 'Visitor sign-ins are posted to this form. Members are never sent.',
    fields: [
      {
        key: 'response_url',
        label: 'Form response URL',
        placeholder: 'https://docs.google.com/forms/d/e/…/formResponse',
      },
      { key: 'entry_first', label: 'First name field', placeholder: 'entry.123456' },
      { key: 'entry_last', label: 'Last name field', placeholder: 'entry.123456' },
      { key: 'entry_email', label: 'Email field', placeholder: 'entry.123456' },
      { key: 'entry_phone', label: 'Phone field', placeholder: 'entry.123456' },
      {
        key: 'collect_email',
        label: "Use Google's built-in email capture",
        type: 'checkbox',
        hint:
          'For a form with "Collect email addresses" set to Responder input — that box has no ' +
          'entry id, so it cannot be mapped above. If the form asks for email as an ordinary ' +
          'question, leave this off and fill in the Email field instead.',
      },
      {
        key: 'extra_fields',
        label: 'Fixed answers',
        type: 'json',
        hint: 'JSON of { "entry.123456": "value" } for required questions the kiosk does not ask.',
      },
    ],
  },
  {
    kind: 'shulcloud',
    title: 'ShulCloud',
    opens: { urlKey: 'form_url', label: 'Open the form' },
    blurb: 'Visitors are submitted to your ShulCloud welcome form.',
    scan: { urlKey: 'form_url', fn: 'shulcloud-scan' },
    fields: [
      { key: 'form_url', label: 'Form URL', placeholder: 'https://www.example.org/form/welcome' },
      { key: 'field_first', label: 'First name input', placeholder: 'element_12345678', mappable: true },
      { key: 'field_last', label: 'Last name input', placeholder: 'element_12345678', mappable: true },
      { key: 'field_email', label: 'Email input', placeholder: 'element_12345678', mappable: true },
      { key: 'field_phone', label: 'Phone input', placeholder: 'element_12345678', mappable: true },
      {
        key: 'success_text',
        label: 'Success text',
        hint: 'Text that appears on the page after a successful submission.',
      },
    ],
  },
  {
    kind: 'google_sheet',
    title: 'Google Sheet',
    opens: {
      urlKey: 'spreadsheet_url',
      fromId: { key: 'spreadsheet_id', prefix: 'https://docs.google.com/spreadsheets/d/' },
      label: 'Open the sheet',
    },
    autoNamed: true,
    fields: [],
  },
]

// Note: there is deliberately no card for 'google_oauth' or 'google_drive'.
// The Google account is shown under Settings, beside the photographs it
// exists for — it has no name, no enable switch and no per-printer routing,
// which is most of what a card on this page is.
//
// And for 'google_drive': The row still
// exists — per-printer routing and the delivery record for each photograph
// attach to it — but it holds no settings at all now that the credential lives
// on the Google connection, so it is created when photographs are switched on
// in Settings rather than added by hand here.
const PLATFORM_SPECS: Spec[] = [
]

// Events are charged for and switched on per customer from Operations, so this
// is offered separately rather than sitting in PLATFORM_SPECS. An organization
// without the entitlement never sees the option, and one whose entitlement is
// withdrawn keeps its events on the page — marked unavailable — because a
// billing change should not delete anybody's work.
const EVENT_SPECS: Spec[] = [
  {
    kind: 'event',
    title: 'Event',
    savesItself: true,
    notADestination: true,
    // No `opens` here, though there is a spreadsheet to open. The link lives
    // in the panel instead, next to the sentence that says what to do with it
    // — paste your pre-registered guests into the Pre-registered tab — and a
    // second one in the banner was the same link twice with the useful half
    // missing.
    fields: [],
  },
]

/**
 * An organization's integrations, of which there may be several of a kind.
 *
 * A congregation might feed two ShulCloud forms for two audiences, or add a
 * second Google Form for one event, so an integration is an instance with a
 * name rather than a slot per vendor.
 *
 * Config is ordinary data the org's owners own. The one real credential — a
 * Drive service-account key — is written through a database function into
 * Vault, and no route reads it back, so the field shows only whether one is
 * stored.
 */
export default function Integrations({
  specs = PLATFORM_SPECS,
  unavailable = [],
  onOfferKinds,
}: {
  specs?: Spec[]
  /** Called as somebody reaches for the list of kinds, so what it offers can
   *  be re-read first. Which kinds exist depends on entitlements the platform
   *  team sets, and those change while a customer has this page open. */
  onOfferKinds?: () => void
  /** Kinds this organization may no longer use but may still have. An
   *  entitlement that lapses stops the work without deleting it: the rows stay
   *  on the page, say why they are idle, and come back untouched if it is
   *  granted again. Removing them from `specs` instead would hide them
   *  entirely, which leaves a printed QR code failing with nothing on any
   *  screen to explain it. */
  unavailable?: IntegrationKind[]
} = {}) {
  const { orgId, isOwner } = useOrg()
  const [list, setList] = useState<Integration[]>([])
  //: What the server last told us, so the card can say when the text fields
  //: have been edited but not saved. The switches never appear here as
  //: pending, because they are written the moment they are clicked.
  const [loaded, setLoaded] = useState<Record<string, string>>({})
  const [hasSecret, setHasSecret] = useState<Record<string, boolean>>({})
  const [secretInput, setSecretInput] = useState<Record<string, string>>({})
  /** What a scan of each row's form turned up, keyed by integration id. */
  const [scanned, setScanned] = useState<Record<string, ScannedField[]>>({})
  const [scanning, setScanning] = useState<string | null>(null)
  const [scanNote, setScanNote] = useState<Record<string, string>>({})
  //: Which cards are showing their settings. Closed by default: a destination
  //: that is working needs no attention, and a page of open forms is a page
  //: you have to read to find the one you came for.
  const [open, setOpen] = useState<Record<string, boolean>>({})

  /**
   * Read the form and offer its fields, instead of asking someone to find
   * element_30776892 in a page of HTML.
   *
   * A suggestion only fills a box that is empty. Overwriting a mapping that
   * already works — because a label happened to match — would silently change
   * where a congregation's visitors are sent, which is the one thing this must
   * never do on its own.
   */
  async function scanFormFor(row: Integration, spec: Spec) {
    if (!spec.scan) return
    const cfg = (row.config ?? {}) as Record<string, unknown>
    const url = String(cfg[spec.scan.urlKey] ?? '').trim()
    if (!url) {
      setScanNote((p) => ({ ...p, [row.id]: 'Fill in the form URL first, then scan.' }))
      return
    }
    setScanning(row.id)
    setScanNote((p) => ({ ...p, [row.id]: '' }))
    const res = await invokeFn(spec.scan.fn, { org_id: row.org_id, form_url: url })
    setScanning(null)
    if (!res.ok) {
      setScanNote((p) => ({ ...p, [row.id]: res.error ?? 'The scan failed.' }))
      return
    }

    const fields = (res.fields ?? []) as ScannedField[]
    const suggested = (res.suggested ?? {}) as Record<string, string>
    setScanned((p) => ({ ...p, [row.id]: fields }))

    const filled: string[] = []
    for (const f of spec.fields) {
      if (!f.mappable || !suggested[f.key]) continue
      if (String(cfg[f.key] ?? '').trim()) continue
      setField(row.id, f.key, suggested[f.key])
      filled.push(f.label)
    }
    setScanNote((p) => ({
      ...p,
      [row.id]:
        `Found ${fields.length} field${fields.length === 1 ? '' : 's'}` +
        (res.formId ? ` in ${res.formId}` : '') +
        (filled.length ? `. Filled in ${filled.join(', ')} — check them, then Save.` : '.'),
    }))
  }
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addKind, setAddKind] = useState<IntegrationKind | ''>('')
  const [addName, setAddName] = useState('')

  /** Whether the text fields differ from what the server last returned. The
   *  switches are excluded on purpose: they are never pending. */
  const dirty = (row: Integration) =>
    loaded[row.id] !== undefined &&
    loaded[row.id] !== JSON.stringify({ name: row.name, config: row.config ?? {} })

  /** Anything for Save to do. A typed-but-unsaved credential counts even
   *  though it never appears in `dirty` — it is write-only and is not part of
   *  the row we compare against. */
  const pending = (row: Integration) => dirty(row) || Boolean(secretInput[row.id]?.trim())
  const specOf = (kind: IntegrationKind) => specs.find((s) => s.kind === kind)

  /** Whether this kind has anything an operator types. A destination that
   *  names itself, holds no settings and needs no credential has nothing for a
   *  Save button to do — the switches write themselves. */
  const hasEditableText = (spec: Spec) =>
    !spec.autoNamed || spec.fields.length > 0 || Boolean(spec.secret)

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    const { data, error } = await supabase
      .from('integrations')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .order('kind')
      .order('name')
    if (error) setError(error.message)
    // Every row this organization has, not only the ones this render knows how
    // to draw. Filtering here dropped integrations permanently: the specs on
    // offer depend on entitlements that arrive a moment after the first paint,
    // so a load that ran in that moment kept only the kinds it happened to
    // know about, and nothing reloaded afterwards. Which rows are *shown* is a
    // render-time question, answered where the spec is looked up.
    const mine = (data ?? []) as Integration[]
    setList(mine)
    setLoaded(
      Object.fromEntries(
        mine.map((r) => [r.id, JSON.stringify({ name: r.name, config: r.config ?? {} })]),
      ),
    )

    // Per instance, not per kind: two Drive accounts can differ in whether a
    // key has been stored.
    const flags: Record<string, boolean> = {}
    for (const row of mine.filter((r) => specOf(r.kind)?.secret)) {
      const { data: has } = await supabase.rpc('integration_has_secret', { p_integration: row.id })
      flags[row.id] = Boolean(has)
    }
    setHasSecret(flags)
    setLoading(false)
    // Deliberately only the organization. This used to depend on `specs`,
    // which the parent rebuilds on every render — so loading rebuilt it, which
    // rebuilt this, which loaded again.
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Finish anything the Google round trip interrupted.
   *
   * Adding a Sheet with no account connected sends the operator to Google, and
   * they come back to a destination that still has no sheet — the step that
   * would have made it was the step that redirected. Nothing else notices, so
   * the destination sits half made until a visitor signs in.
   */
  const finishPending = useCallback(async () => {
    const half = list.filter(
      (r) => r.kind === 'google_sheet' && !(r.config as Record<string, unknown>)?.spreadsheet_id,
    )
    if (!half.length) return
    for (const row of half) {
      const res = await invokeFn('google-provision', {
        org_id: row.org_id,
        what: 'sheet',
        integration_id: row.id,
      })
      if (res.ok) await supabase.from('integrations').update({ enabled: true }).eq('id', row.id)
    }
    await load()
  }, [list, load])

  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (q.get('connected') !== 'google') return
    window.history.replaceState({}, '', window.location.pathname)
    void finishPending()
  }, [finishPending])

  function patch(id: string, changes: Partial<Integration>) {
    setList((prev) => prev.map((r) => (r.id === id ? { ...r, ...changes } : r)))
  }

  /**
   * A switch that takes effect on click, rather than waiting for Save.
   *
   * Only this one column is written, so a half-typed form URL sitting in the
   * text fields is not dragged live along with it — those still need Save,
   * and the card says so while they differ.
   */
  /** Written on change, like the switches beside it — there is nothing for a
   *  Save to coordinate, and this is the state of the thing rather than part
   *  of its configuration. */
  async function setAudience(row: Integration, value: string) {
    const before = (row.config ?? {}) as Record<string, unknown>
    const next = { ...before, audience: value }
    patch(row.id, { config: next })
    setBusy(row.id)
    setError(null)
    const { error } = await supabase
      .from('integrations')
      .update({ config: next })
      .eq('id', row.id)
    setBusy(null)
    if (error) {
      // Back where it was: a control showing a state the database does not
      // hold is worse than the failure.
      patch(row.id, { config: before })
      setError(error.message)
      return
    }
    await load()
  }

  async function toggleNow(row: Integration, key: 'enabled' | 'default_enabled', value: boolean) {
    const before = row[key]
    patch(row.id, { [key]: value } as Partial<Integration>)
    setError(null)
    const { error } = await supabase
      .from('integrations')
      .update({ [key]: value })
      .eq('id', row.id)
    if (error) {
      // Put the switch back where it was: leaving it showing a state the
      // database does not hold is worse than the failure itself.
      patch(row.id, { [key]: before } as Partial<Integration>)
      setError(error.message)
      return
    }
  }

  /**
   * Write a change immediately, for controls that save themselves.
   *
   * The loaded snapshot moves with it, so the row does not read as edited
   * afterwards — otherwise a self-saving control would leave a Save button
   * lit for work already done.
   */
  async function persist(row: Integration, patch: Partial<Integration>) {
    const next = { ...row, ...patch }
    const name = next.name.trim()
    const config = next.config ?? {}
    setError(null)
    const { error } = await supabase
      .from('integrations')
      .update({ name, config })
      .eq('id', row.id)
    if (error) {
      setError(error.message)
      return
    }
    setList((prev) => prev.map((r) => (r.id === row.id ? { ...next, name } : r)))
    setLoaded((prev) => ({ ...prev, [row.id]: JSON.stringify({ name, config }) }))
  }

  /**
   * Save a renamed row, and move anything named after it.
   *
   * An event's spreadsheet is titled from the event, so a rename that moves
   * one and not the other leaves a customer looking for a list under a name
   * it no longer has. Best effort and said out loud when it fails: the event
   * is renamed either way, and a title that quietly stayed behind is the kind
   * of drift nobody notices until they are searching Drive for it.
   */
  async function renamed(row: Integration) {
    await persist(row, {})
    if (row.kind !== 'event' || !orgId) return
    const config = (row.config ?? {}) as Record<string, unknown>
    if (!config.spreadsheet_id) return
    const res = await invokeFn('google-provision', {
      org_id: orgId,
      what: 'rename_event',
      integration_id: row.id,
    })
    if (res.ok) {
      await load()
      return
    }
    setNotice(
      `The event was renamed, but its attendee list is still called ` +
        `"${config.spreadsheet_title ?? 'its old name'}". ` +
        String(res.error ?? ''),
    )
  }

  /** Make an event's attendee list after the fact, when creating it failed. */
  async function makeEventList(row: Integration) {
    if (!orgId) return
    setBusy(row.id)
    setError(null)
    const res = await invokeFn('google-provision', {
      org_id: orgId,
      what: 'event',
      integration_id: row.id,
    })
    setBusy(null)
    if (res.ok) {
      await load()
      return
    }
    // An owner with no account connected gets taken to connect one. Anyone
    // else — an operator, an admin who is not the owner — gets told whose job
    // it is, because there is no button that changes that.
    if (res.needs_connect && !res.needs_owner) {
      const begin = await invokeFn('google-oauth-begin', {
        org_id: orgId,
        return_to: '/admin/integrations',
      })
      if (begin.ok && typeof begin.url === 'string') {
        window.location.assign(begin.url as string)
        return
      }
    }
    setError(res.error ?? 'Could not create the attendee list.')
  }

  function setField(id: string, key: string, value: unknown) {
    setList((prev) =>
      prev.map((r) => (r.id === id ? { ...r, config: { ...(r.config ?? {}), [key]: value } } : r)),
    )
  }

  /** Kinds that are useless without a spreadsheet, so are never made without one. */
  const NEEDS_SHEET: IntegrationKind[] = ['google_sheet', 'event']

  async function create() {
    if (!orgId || !addKind) return
    const spec = specOf(addKind)
    const name = addName.trim() || spec?.title || addKind
    setBusy('add')
    setNotice(null)
    setError(null)

    // Ask first, make second. An event with no attendee list is not a
    // half-configured event, it is a useless one — there is nowhere to put the
    // pre-registered guests, which is the whole point of it. And this console
    // cannot answer the question itself: it treats an operator reaching into a
    // customer as an owner, so it will happily offer a button for something
    // the server will refuse. Creating the row first left exactly that behind:
    // an event that could not be finished and, for an operator, could not be
    // fixed either.
    if (NEEDS_SHEET.includes(addKind)) {
      const pre = await invokeFn('google-provision', {
        org_id: orgId,
        what: 'preflight',
        // Named so a refusal can say what was refused. A preflight is the one
        // call that does not otherwise reveal what it is for.
        for: addKind === 'event' ? 'event' : 'sheet',
      })
      if (!pre.ok) {
        setBusy(null)
        if (pre.needs_connect) {
          // An owner can fix this in one step, so offer the step rather than
          // the explanation. Nothing has been created, so coming back means
          // adding it again — with an account waiting this time.
          const begin = await invokeFn('google-oauth-begin', {
            org_id: orgId,
            return_to: '/admin/integrations',
          })
          if (begin.ok && typeof begin.url === 'string') {
            window.location.assign(begin.url as string)
            return
          }
        }
        setError(
          (pre.error as string) ??
            'This could not be created. It needs a connected Google account.',
        )
        return
      }
    }
    const { data: made, error } = await supabase
      .from('integrations')
      .insert({
        org_id: orgId,
        kind: addKind,
        name,
        // Switched off on creation: an integration with no configuration yet
        // would otherwise start failing against every sign-in the moment it is
        // added. An event is the exception — it delivers nothing anywhere, its
        // codes do not exist until printers are added, and it has no switch to
        // be turned on with afterwards.
        enabled: specOf(addKind)?.notADestination === true,
        default_enabled: true,
        config: {},
      })
      .select('id')
      .maybeSingle()
    if (error) {
      setBusy(null)
      setError(
        error.message.includes('integrations_org_name_key')
          ? `You already have an integration called "${name}".`
          : error.message,
      )
      return
    }

    // A sheet destination with no sheet is not configured, it is half made. So
    // make it here rather than leaving a button for somebody to find — and
    // switch it on, because at that point there is nothing else to decide.
    //
    // An event's list is made the same way but for a stronger reason: a
    // sign-in sheet is only read after the first visitor, while an attendee
    // list has to exist *before* anyone uses it, because the pre-registered
    // guests go into it beforehand. Making it lazily was a mistake copied
    // from the sheet destination.
    if ((addKind === 'google_sheet' || addKind === 'event') && made?.id) {
      const res = await invokeFn('google-provision', {
        org_id: orgId,
        what: addKind === 'event' ? 'event' : 'sheet',
        integration_id: made.id,
      })
      if (res.ok) {
        await supabase.from('integrations').update({ enabled: true }).eq('id', made.id)
      } else {
        // The preflight above already established that this could be made, so
        // reaching here means it failed for some other reason — the account
        // was revoked in the last second, or Google refused. Rare, and not
        // something a redirect fixes.
        setError(
          res.error ??
            (addKind === 'event'
              ? 'The event was added, but its attendee list could not be created.'
              : 'The destination was added, but its sheet could not be created.'),
        )
      }
    }

    setBusy(null)
    // Open, if there is anything to fill in. A destination arrives switched
    // off and unconfigured, so landing collapsed would hide the one thing
    // that has to happen next behind a button nobody has been told about.
    if (made?.id && specOf(addKind) && hasEditableText(specOf(addKind)!)) {
      setOpen((p) => ({ ...p, [made.id as string]: true }))
    }
    setAddKind('')
    setAddName('')
    await load()
  }

  async function save(row: Integration, onSaved?: () => void) {
    const spec = specOf(row.kind)
    setBusy(row.id)
    setNotice(null)
    setError(null)
    const { error } = await supabase
      .from('integrations')
      .update({
        name: row.name.trim(),
        enabled: row.enabled,
        default_enabled: row.default_enabled,
        config: row.config ?? {},
      })
      .eq('id', row.id)
    if (error) {
      setError(error.message)
      setBusy(null)
      return
    }

    const pending = secretInput[row.id]?.trim()
    if (spec?.secret && pending) {
      const { error: secretError } = await supabase.rpc('set_integration_secret', {
        p_integration: row.id,
        p_secret: pending,
      })
      if (secretError) {
        setError(secretError.message)
        setBusy(null)
        // Deliberately not closed. The settings saved and the credential did
        // not, which is the one outcome where the form must stay in front of
        // whoever was typing.
        await load()
        return
      }
      setSecretInput((p) => ({ ...p, [row.id]: '' }))
    }
    setBusy(null)
    // Closed on the way out: saving is the end of the errand, and leaving the
    // form open invites a second look at something already dealt with.
    onSaved?.()
    await load()
  }

  async function clearSecret(row: Integration) {
    if (!window.confirm(`Remove the stored credential for ${row.name}?`)) return
    setBusy(row.id)
    const { error } = await supabase.rpc('clear_integration_secret', { p_integration: row.id })
    if (error) setError(error.message)
    setBusy(null)
    await load()
  }

  async function resetPrinters(row: Integration) {
    if (
      !window.confirm(
        `Put every printer back to the default for ${row.name} ` +
          `(${row.default_enabled ? 'on' : 'off'})? Any printer set differently loses that.`,
      )
    ) {
      return
    }
    setBusy(row.id)
    setNotice(null)
    setError(null)
    // Exceptions only live in this table, so clearing them *is* the reset.
    const { error } = await supabase
      .from('printer_integrations')
      .delete()
      .eq('integration_id', row.id)
    setBusy(null)
    // The only message kept. Everything else on this page shows its own
    // result — a switch moves, a card appears or disappears, Save goes dim —
    // but this one changes rows on the Printers tab and leaves no trace here.
    if (error) setError(error.message)
    else setNotice(`Every printer now follows the default for ${row.name}.`)
  }

  async function remove(row: Integration) {
    if (
      !window.confirm(
        `Delete ${row.name}? Sign-ins already sent to it keep their history, but ` +
          `nothing further will be sent there.`,
      )
    ) {
      return
    }
    setBusy(row.id)
    const { error } = await supabase.from('integrations').delete().eq('id', row.id)
    setBusy(null)
    if (error) setError(error.message)
    await load()
  }

  if (!isOwner) return null
  if (loading) return <p className="muted">Loading integrations…</p>

  return (
    <>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      {list.map((row) => {
        const spec = specOf(row.kind)
        if (!spec) return null
        const config = (row.config ?? {}) as Record<string, unknown>
        const idle = unavailable.includes(row.kind)
        return (
          <section
            className={`card${
              (!hasEditableText(spec) || open[row.id]) ||
              (spec.opens && openHref(spec.opens, config))
                ? ''
                : ' is-collapsed'
            }`}
            key={row.id}
          >
            {/* The name, as typed, with what it is behind it. Live rather than
                from the last save, so renaming shows here as you type. */}
            <div className="integration-head" data-kind={row.kind}>
              {/* What it is called, and under it what it is. Stacked rather
                  than side by side: the kind is a caption for the name, and
                  reading it that way needs no gap to scan across. */}
              <div className="integration-ident">
                <h2 className="integration-title">{row.name.trim() || spec.title}</h2>
                <span className="integration-kind">{spec.title}</span>
              </div>

              {/* The state of the thing, on the thing. Both write on click, so
                  they belong with its name rather than in the form below —
                  somebody who never scrolls should still see whether anything
                  is being sent. Delete sits here for the same reason: it acts
                  on the destination, not on its settings. */}
              <div className="integration-controls">
              {/* Who this destination takes, under the switch that decides
                  whether it takes anything. No label: the options say what
                  they are, and a word above them would be explaining a
                  sentence that already reads. */}
              {!spec.notADestination && (
              <div className="integration-enabled">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={Boolean(row.enabled)}
                    onChange={(e) => void toggleNow(row, 'enabled', e.target.checked)}
                  />
                  Enabled
                </label>
                {row.enabled && (
                  <select
                    className="integration-audience"
                    value={String((row.config as Record<string, unknown>)?.audience ?? 'interested')}
                    onChange={(e) => void setAudience(row, e.target.value)}
                    disabled={busy === row.id}
                  >
                    <option value="interested">Interested visitors</option>
                    <option value="visitors">All visitors</option>
                    <option value="all">All sign-ins</option>
                  </select>
                )}
              </div>
              )}

              {/* Only once it is enabled. "On by default" for something
                  switched off describes a state no printer can be in, and the
                  Printers tab would show it as On while nothing was sent. */}
              {row.enabled && !spec.notADestination && (
                <>
                  {/* The reset belongs under the default it resets to, not
                      beside it: it is what to do about that setting rather
                      than another setting of its own. */}
                  <div className="integration-default">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={Boolean(row.default_enabled)}
                        onChange={(e) => void toggleNow(row, 'default_enabled', e.target.checked)}
                      />
                      On by default for printers
                    </label>
                    <button
                      type="button"
                      className="linkish"
                      disabled={busy === row.id}
                      onClick={() => void resetPrinters(row)}
                    >
                      Reset all printers to the default
                    </button>
                  </div>
                </>
              )}
                {/* The two buttons travel together at the right edge. The
                    switches describe the destination; these two act on it, and
                    a gap between the kinds is easier to aim at than a row of
                    controls that all look alike. */}
                <div className="integration-actions">
                  {hasEditableText(spec) && (
                    <button
                      type="button"
                      className="secondary btn-sm"
                      aria-expanded={Boolean(open[row.id])}
                      onClick={() => setOpen((p) => ({ ...p, [row.id]: !p[row.id] }))}
                    >
                      {open[row.id] ? 'Close' : 'Configure'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary btn-sm danger"
                    disabled={busy === row.id}
                    onClick={() => void remove(row)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>

            {/* Always, open or closed. Looking at the form or the sheet is
                not configuring it, and behind Configure it becomes something
                to go and find. */}
            {spec.opens && openHref(spec.opens, config) && (
              <div style={{ marginTop: 10 }}>
                <a href={openHref(spec.opens, config)!} target="_blank" rel="noreferrer noopener">
                  {spec.opens.label}
                </a>
                {typeof config.spreadsheet_title === 'string' && (
                  <span className="muted small" style={{ marginLeft: 8 }}>
                    {config.spreadsheet_title}
                  </span>
                )}
              </div>
            )}

            {/* Everything below the banner, for a destination that has
                settings. A card with none — one that makes its own sheet and
                names it — has nothing to hide, so it stays open. */}
            {(!hasEditableText(spec) || open[row.id]) && (
            <>
            {spec.autoNamed ? (
              /* Nothing to name. The destination makes its own file and calls
                 it what it calls it; a box asking the operator for a different
                 name would be asking about something they never see. */
              spec.blurb ? <p className="muted small">{spec.blurb}</p> : null
            ) : (
              <label className="field">
                Name
                <input
                  value={row.name}
                  onChange={(e) => patch(row.id, { name: e.target.value })}
                  // Kept as you type, written when you leave the field. A kind
                  // with no Save button still has a name, and saving on every
                  // keystroke would write a row per letter.
                  onBlur={() => {
                    if (spec.savesItself && dirty(row)) void renamed(row)
                  }}
                  placeholder={spec.title}
                />
                {spec.blurb && <span className="muted small">{spec.blurb}</span>}
              </label>
            )}

            {spec.fields.length > 0 && (
            <div className="grid2">
              {spec.fields.map((f) =>
                f.type === 'checkbox' ? (
                  <label className="check" key={f.key}>
                    <input
                      type="checkbox"
                      checked={Boolean(config[f.key])}
                      onChange={(e) => setField(row.id, f.key, e.target.checked)}
                    />
                    {f.label}
                  </label>
                ) : f.mappable && scanned[row.id] ? (
                  <label className="field" key={f.key}>
                    {f.label}
                    <select
                      value={(config[f.key] as string) ?? ''}
                      onChange={(e) => setField(row.id, f.key, e.target.value)}
                    >
                      <option value="">— not sent —</option>
                      {scanned[row.id].map((sf) => (
                        <option key={sf.name} value={sf.name}>
                          {sf.label || '(no label on the form)'} ({sf.name})
                        </option>
                      ))}
                      {/* A saved code the form no longer has. Kept as an option
                          so it is visible and selected rather than silently
                          reset to "not sent" — the mapping is wrong either way,
                          and being told is the whole point. */}
                      {(config[f.key] as string) &&
                        !scanned[row.id].some((sf) => sf.name === config[f.key]) && (
                          <option value={config[f.key] as string}>
                            {config[f.key] as string} — no longer on this form
                          </option>
                        )}
                    </select>
                    {(config[f.key] as string) &&
                    !scanned[row.id].some((sf) => sf.name === config[f.key]) ? (
                      <span className="field-error">
                        This form has no field called {config[f.key] as string} any more. Sign-ins
                        mapped to it are not arriving. Pick the right one.
                      </span>
                    ) : (
                      f.hint && <span className="muted small">{f.hint}</span>
                    )}
                  </label>
                ) : (
                  <label className="field" key={f.key}>
                    {f.label}
                    <input
                      value={
                        f.type === 'json'
                          ? typeof config[f.key] === 'string'
                            ? (config[f.key] as string)
                            : JSON.stringify(config[f.key] ?? {})
                          : ((config[f.key] as string) ?? '')
                      }
                      placeholder={f.placeholder}
                      onChange={(e) => setField(row.id, f.key, e.target.value)}
                    />
                    {f.hint && <span className="muted small">{f.hint}</span>}
                  </label>
                ),
              )}
            </div>
            )}

            {idle && (
              /* Stated once, at the top of the card, rather than disabling
                 every control on it: the settings are still worth reading, and
                 an operator who can see why it is idle can act on it. */
              <p className="muted small" style={{ marginTop: 10 }}>
                This is not running. {spec.title} is not enabled for your organization —
                contact support to turn it back on. Nothing here has been deleted.
              </p>
            )}

            {spec.kind === 'event' && orgId && !idle && (
              <>
                {config.spreadsheet_url || config.spreadsheet_id ? (
                  /* The link belongs here, not only in the banner: filling the
                     list in is the first thing anybody does after making an
                     event, and it is done in the spreadsheet rather than on
                     this page. */
                  <p style={{ marginTop: 10 }}>
                    <a
                      href={
                        (config.spreadsheet_url as string) ||
                        `https://docs.google.com/spreadsheets/d/${config.spreadsheet_id}`
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open the attendee list
                    </a>
                    <span className="muted small">
                      {' '}
                      — paste your pre-registered guests into the Pre-registered tab.
                    </span>
                  </p>
                ) : (
                  /* Normally made as the event is created. Getting here means
                     that failed — usually no Google account yet — so the way
                     to finish it is on the page rather than in a message. */
                  <div style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="secondary btn-sm"
                      disabled={busy === row.id}
                      onClick={() => void makeEventList(row)}
                    >
                      {busy === row.id ? 'Creating…' : 'Create the attendee list'}
                    </button>
                    <span className="muted small" style={{ marginLeft: 10 }}>
                      This event has no attendee list, so there is nowhere to put its
                      pre-registered guests and everyone would register as on-site.
                      Creating one is an owner&apos;s job — an operator reaching in
                      cannot connect a customer&apos;s Google account. Delete the event
                      and add it again if that is easier.
                    </span>
                  </div>
                )}
                <EventPrinters
                  orgId={orgId}
                  integrationId={row.id}
                  eventName={row.name}
                  config={config}
                  onConfig={(key, value) =>
                    void persist(row, { config: { ...config, [key]: value } })
                  }
                />
              </>
            )}

            {spec.kind === 'google_sheet' && !config.spreadsheet_id && (
              /* No sheet yet, and nothing to do about it. One is made the
                 first time a visitor needs recording — so the absence is a
                 stage rather than a fault, and saying so beats a button that
                 does what is going to happen anyway. */
              <p className="muted small" style={{ marginTop: 10 }}>
                The spreadsheet is created when the first visitor is recorded.
              </p>
            )}

            {spec.scan && (
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="secondary btn-sm"
                  disabled={scanning === row.id}
                  onClick={() => void scanFormFor(row, spec)}
                >
                  {scanning === row.id
                    ? 'Reading the form…'
                    : scanned[row.id]
                      ? 'Read the form again'
                      : 'Read the form'}
                </button>
                <span className="muted small" style={{ marginLeft: 10 }}>
                  {scanNote[row.id] ||
                    'Fetches the form and lists its fields by name, so the boxes above ' +
                      'become drop-downs instead of codes to copy.'}
                </span>
              </div>
            )}

            {spec.secret && (
              <label className="field" style={{ marginTop: 18 }}>
                {spec.secret.label}
                <input
                  type="password"
                  autoComplete="off"
                  value={secretInput[row.id] ?? ''}
                  placeholder={hasSecret[row.id] ? '•••••••• stored' : 'not set'}
                  onChange={(e) => setSecretInput((p) => ({ ...p, [row.id]: e.target.value }))}
                />
                <span className="muted small">{spec.secret.hint}</span>
                {hasSecret[row.id] && (
                  <button
                    type="button"
                    className="secondary btn-sm"
                    style={{ marginTop: 6, alignSelf: 'flex-start' }}
                    onClick={() => void clearSecret(row)}
                  >
                    Remove stored credential
                  </button>
                )}
              </label>
            )}

            {/* The switches are already live, so this can only ever be about the
                text fields — which is why it names them. */}
            {hasEditableText(spec) && !spec.savesItself && pending(row) && (
              <p className="muted small" style={{ marginTop: 10 }}>
                The settings above have been edited and not saved yet.
              </p>
            )}

            {hasEditableText(spec) && !spec.savesItself && (
              <div className="modal-actions" style={{ marginTop: 20 }}>
                <button
                  type="button"
                  disabled={busy === row.id || !pending(row)}
                  onClick={() => void save(row, () => setOpen((p) => ({ ...p, [row.id]: false })))}
                >
                  {busy === row.id ? 'Saving…' : 'Save configuration'}
                </button>
              </div>
            )}
            </>
            )}

          </section>
        )
      })}

      {/* Which kinds are on offer comes from the organization's entitlements,
          which are read once when the admin loads. An operator switching Events
          on for a customer mid-session would otherwise not appear until the
          page happened to be reloaded, with nothing on screen suggesting it —
          so the row is re-read as somebody reaches for it. On hover as well as
          on focus, because the answer needs to be in hand before the list
          opens rather than while it is open. */}
      <section
        className="card"
        onMouseEnter={() => onOfferKinds?.()}
        onFocusCapture={() => onOfferKinds?.()}
      >
        <h2>Add an integration</h2>
        <div className="grid2">
          <label className="field">
            Kind
            <select
              value={addKind}
              onChange={(e) => setAddKind(e.target.value as IntegrationKind | '')}
            >
              <option value="">Choose…</option>
              {specs
                .filter((s) => !unavailable.includes(s.kind))
                .map((s) => (
                  <option key={s.kind} value={s.kind}>
                    {s.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            Name
            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder={addKind ? specOf(addKind as IntegrationKind)?.title : 'Main office'}
            />
          </label>
        </div>
        <button type="button" disabled={!addKind || busy === 'add'} onClick={() => void create()}>
          {busy === 'add' ? 'Adding…' : 'Add'}
        </button>
      </section>
    </>
  )
}
