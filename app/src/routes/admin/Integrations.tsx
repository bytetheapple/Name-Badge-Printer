import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { invokeFn } from '../../lib/functions'
import { useOrg } from '../../lib/org'
import type { Integration, IntegrationKind } from '../../lib/types'

export { CUSTOM_SPECS, PLATFORM_SPECS }

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
  opens: { urlKey: string; fromId?: { key: string; prefix: string } },
  config: Record<string, unknown>,
): string | null {
  const url = String(config[opens.urlKey] ?? '').trim()
  if (url.startsWith('http')) return url
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
  blurb: string
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
  opens?: { urlKey: string; label: string; fromId?: { key: string; prefix: string } }
  /** Set when this integration also stores a credential in Vault. */
  secret?: { label: string; hint: string }
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
    blurb:
      'Visitors who ask to hear more are added as a row of a spreadsheet in your own ' +
      'Drive. Members are never sent.',
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
export default function Integrations({ specs = PLATFORM_SPECS }: { specs?: Spec[] } = {}) {
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

  /**
   * Read the form and offer its fields, instead of asking someone to find
   * element_30776892 in a page of HTML.
   *
   * A suggestion only fills a box that is empty. Overwriting a mapping that
   * already works — because a label happened to match — would silently change
   * where a congregation's visitors are sent, which is the one thing this must
   * never do on its own.
   */
  /**
   * Make the spreadsheet now, rather than on the first visitor.
   *
   * Waiting until a sign-in meant configuring a destination and being shown
   * nothing — no sheet, no link, no way to tell whether it had worked. If the
   * organization has not connected Google yet, this is also the moment to ask.
   */
  async function createSheetFor(row: Integration) {
    setBusy(row.id)
    setError(null)
    setScanNote((p) => ({ ...p, [row.id]: '' }))
    const res = await invokeFn('google-provision', {
      org_id: row.org_id,
      what: 'sheet',
      integration_id: row.id,
    })
    setBusy(null)
    if (res.ok) {
      setScanNote((p) => ({ ...p, [row.id]: 'Sheet created in your Drive.' }))
      await load()
      return
    }
    if (res.needs_connect) {
      const begin = await invokeFn('google-oauth-begin', {
        org_id: row.org_id,
        return_to: '/admin/integrations',
      })
      if (begin.ok && typeof begin.url === 'string') {
        window.location.assign(begin.url as string)
        return
      }
    }
    setScanNote((p) => ({ ...p, [row.id]: res.error ?? 'Could not create the sheet.' }))
  }

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

  const kinds = specs.map((s) => s.kind)
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
    const mine = ((data ?? []) as Integration[]).filter((r) => kinds.includes(r.kind))
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
    // kinds is derived from specs, which is a stable module constant
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, specs])

  useEffect(() => {
    void load()
  }, [load])

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

  function setField(id: string, key: string, value: unknown) {
    setList((prev) =>
      prev.map((r) => (r.id === id ? { ...r, config: { ...(r.config ?? {}), [key]: value } } : r)),
    )
  }

  async function create() {
    if (!orgId || !addKind) return
    const spec = specOf(addKind)
    const name = addName.trim() || spec?.title || addKind
    setBusy('add')
    setNotice(null)
    setError(null)
    // Switched off on creation: an integration with no configuration yet would
    // otherwise start failing against every sign-in the moment it is added.
    const { data: made, error } = await supabase
      .from('integrations')
      .insert({ org_id: orgId, kind: addKind, name, enabled: false, default_enabled: true, config: {} })
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
    if (addKind === 'google_sheet' && made?.id) {
      const res = await invokeFn('google-provision', {
        org_id: orgId,
        what: 'sheet',
        integration_id: made.id,
      })
      if (res.ok) {
        await supabase.from('integrations').update({ enabled: true }).eq('id', made.id)
      } else if (res.needs_connect) {
        // No Google account yet. Ask for one; the destination is waiting here
        // when they come back.
        const begin = await invokeFn('google-oauth-begin', {
          org_id: orgId,
          return_to: '/admin/integrations',
        })
        if (begin.ok && typeof begin.url === 'string') {
          window.location.assign(begin.url as string)
          return
        }
        setError(begin.error ?? 'Could not start the Google connection.')
      } else {
        setError(res.error ?? 'The destination was added, but its sheet could not be created.')
      }
    }

    setBusy(null)
    setAddKind('')
    setAddName('')
    await load()
  }

  async function save(row: Integration) {
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
      if (secretError) setError(secretError.message)
      else setSecretInput((p) => ({ ...p, [row.id]: '' }))
    }
    setBusy(null)
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
        return (
          <section className="card" key={row.id}>
            {/* The name, as typed, with what it is behind it. Live rather than
                from the last save, so renaming shows here as you type. */}
            <div className="integration-head" data-kind={row.kind}>
              <h2 className="integration-title">{row.name.trim() || spec.title}</h2>
              <span className="integration-kind">{spec.title}</span>
            </div>

            {/* First, not last. Both write on click, so this is the state of
                the thing rather than part of the form below it — and someone
                who saves settings without scrolling to the foot of the card
                should not be left wondering why nothing is being sent. */}
            <div className="switch-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={Boolean(row.enabled)}
                  onChange={(e) => void toggleNow(row, 'enabled', e.target.checked)}
                />
                Enabled
              </label>

              {/* Only once it is enabled. "On by default" for something
                  switched off describes a state no printer can be in, and the
                  Printers tab would show it as On while nothing was sent. */}
              {row.enabled && (
                <>
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
                </>
              )}
            </div>

            {spec.autoNamed ? (
              /* Nothing to name. The destination makes its own file and calls
                 it what it calls it; a box asking the operator for a different
                 name would be asking about something they never see. */
              <p className="muted small">{spec.blurb}</p>
            ) : (
              <label className="field">
                Name
                <input
                  value={row.name}
                  onChange={(e) => patch(row.id, { name: e.target.value })}
                  placeholder={spec.title}
                />
                <span className="muted small">{spec.blurb}</span>
              </label>
            )}

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

            {spec.kind === 'google_sheet' && !config.spreadsheet_id && (
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="secondary btn-sm"
                  disabled={busy === row.id}
                  onClick={() => void createSheetFor(row)}
                >
                  {busy === row.id ? 'Creating…' : 'Create the sheet'}
                </button>
                <span className="muted small" style={{ marginLeft: 10 }}>
                  {scanNote[row.id] ||
                    'Makes the spreadsheet in your Google Drive. Connects a Google account ' +
                      'first if there is not one.'}
                </span>
              </div>
            )}

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
                {typeof config.previous_spreadsheet_id === 'string' && (
                  <span className="muted small" style={{ marginLeft: 10 }}>
                    An earlier sheet holds the sign-ins from before the switch.
                  </span>
                )}
              </div>
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
            {pending(row) && (
              <p className="muted small" style={{ marginTop: 10 }}>
                The settings above have been edited and not saved yet.
              </p>
            )}

            <div className="modal-actions" style={{ marginTop: 20 }}>
              <button
                type="button"
                className="secondary btn-sm danger"
                disabled={busy === row.id}
                onClick={() => void remove(row)}
              >
                Delete
              </button>
              {/* Dim until there is text to save. The switches below write
                  themselves, so an enabled card with nothing typed has
                  genuinely nothing for this button to do. */}
              <button
                type="button"
                disabled={busy === row.id || !pending(row)}
                onClick={() => void save(row)}
              >
                {busy === row.id ? 'Saving…' : 'Save'}
              </button>
            </div>

          </section>
        )
      })}

      <section className="card">
        <h2>Add an integration</h2>
        <p className="muted small">
          Choose what kind of place this is, and what to call it. It arrives switched off so you
          can fill in its settings before anything is sent.
        </p>
        <div className="grid2">
          <label className="field">
            Kind
            <select
              value={addKind}
              onChange={(e) => setAddKind(e.target.value as IntegrationKind | '')}
            >
              <option value="">Choose…</option>
              {specs.map((s) => (
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
            <span className="muted small">
              How you will tell it apart from the others. Shown against every sign-in sent there.
            </span>
          </label>
        </div>
        <button type="button" disabled={!addKind || busy === 'add'} onClick={() => void create()}>
          {busy === 'add' ? 'Adding…' : 'Add'}
        </button>
      </section>
    </>
  )
}
