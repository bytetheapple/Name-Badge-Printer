import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useOrg } from '../../lib/org'
import type { Integration, IntegrationKind } from '../../lib/types'

export { CUSTOM_SPECS }

const COLUMNS = 'id, org_id, kind, enabled, config, updated_at, created_at'

type Field = {
  key: string
  label: string
  type?: 'text' | 'checkbox' | 'json'
  hint?: string
  placeholder?: string
}

type Spec = {
  kind: IntegrationKind
  title: string
  blurb: string
  fields: Field[]
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
      { key: 'entry_phone', label: 'Phone field', placeholder: 'entry.123456' },
      {
        key: 'collect_email',
        label: "Use Google's built-in email capture",
        type: 'checkbox',
        hint: 'Turn on if the form has "Collect email addresses" set to Responder input.',
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
    fields: [
      { key: 'form_url', label: 'Form URL', placeholder: 'https://www.example.org/form/welcome' },
      { key: 'field_first', label: 'First name input', placeholder: 'element_12345678' },
      { key: 'field_last', label: 'Last name input', placeholder: 'element_12345678' },
      { key: 'field_email', label: 'Email input', placeholder: 'element_12345678' },
      { key: 'field_phone', label: 'Phone input', placeholder: 'element_12345678' },
      {
        key: 'success_text',
        label: 'Success text',
        hint: 'Text that appears on the page after a successful submission.',
      },
    ],
  },
]

const PLATFORM_SPECS: Spec[] = [
  {
    kind: 'google_drive',
    title: 'Google Drive (selfies)',
    blurb:
      'The service account that uploads visitor selfies. Which folder they land in is set under Settings → Visitor selfie.',
    fields: [
      {
        key: 'sa_client_email',
        label: 'Service account email',
        placeholder: 'name@project.iam.gserviceaccount.com',
      },
    ],
    secret: {
      label: 'Service account private key',
      hint: 'The PEM private key from the service account JSON. Stored encrypted and never shown again.',
    },
  },
]

/**
 * Per-organization integration settings.
 *
 * Config is ordinary data the org's admins own. The one real credential — the
 * Drive service-account key — is written through a database function into
 * Vault, and there is no route that reads it back, so the field shows only
 * whether one is stored.
 */
export default function Integrations({ specs = PLATFORM_SPECS }: { specs?: Spec[] } = {}) {
  const { orgId, isAdmin } = useOrg()
  const [rows, setRows] = useState<Record<string, Integration>>({})
  const [hasSecret, setHasSecret] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [secretInput, setSecretInput] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    if (!orgId) return
    setLoading(true)
    const { data, error } = await supabase
      .from('integrations')
      .select(COLUMNS)
      .eq('org_id', orgId)
    if (error) setError(error.message)
    const byKind: Record<string, Integration> = {}
    for (const r of (data ?? []) as Integration[]) byKind[r.kind] = r
    setRows(byKind)

    const flags: Record<string, boolean> = {}
    for (const spec of specs.filter((s) => s.secret)) {
      const { data: has } = await supabase.rpc('integration_has_secret', {
        p_org: orgId,
        p_kind: spec.kind,
      })
      flags[spec.kind] = Boolean(has)
    }
    setHasSecret(flags)
    setLoading(false)
  }, [orgId, specs])

  useEffect(() => {
    void load()
  }, [load])

  function setField(kind: IntegrationKind, key: string, value: unknown) {
    setRows((prev) => {
      const existing = prev[kind]
      const config = { ...(existing?.config ?? {}), [key]: value }
      return { ...prev, [kind]: { ...(existing ?? ({} as Integration)), kind, config } }
    })
  }

  function setEnabled(kind: IntegrationKind, enabled: boolean) {
    setRows((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? ({} as Integration)), kind, enabled } }))
  }

  async function save(spec: Spec) {
    if (!orgId) return
    setBusy(spec.kind)
    setNotice(null)
    setError(null)
    const row = rows[spec.kind]
    const payload = { enabled: Boolean(row?.enabled), config: row?.config ?? {} }

    // Update or insert explicitly rather than upserting: org_id and kind are
    // insert-only columns, and an upsert would try to write them on conflict.
    const { error } = row?.id
      ? await supabase.from('integrations').update(payload).eq('id', row.id)
      : await supabase.from('integrations').insert({ org_id: orgId, kind: spec.kind, ...payload })

    if (error) setError(error.message)
    else setNotice(`${spec.title} saved.`)

    const pending = secretInput[spec.kind]?.trim()
    if (!error && spec.secret && pending) {
      const { error: secretError } = await supabase.rpc('set_integration_secret', {
        p_org: orgId,
        p_kind: spec.kind,
        p_secret: pending,
      })
      if (secretError) setError(secretError.message)
      else {
        setSecretInput((p) => ({ ...p, [spec.kind]: '' }))
        setNotice(`${spec.title} saved, including the credential.`)
      }
    }
    setBusy(null)
    await load()
  }

  async function clearSecret(spec: Spec) {
    if (!orgId || !window.confirm(`Remove the stored ${spec.secret?.label.toLowerCase()}?`)) return
    setBusy(spec.kind)
    const { error } = await supabase.rpc('clear_integration_secret', {
      p_org: orgId,
      p_kind: spec.kind,
    })
    if (error) setError(error.message)
    setBusy(null)
    await load()
  }

  if (!isAdmin) return null
  if (loading) return <p className="muted">Loading integrations…</p>

  return (
    <>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}

      {specs.map((spec) => {
        const row = rows[spec.kind]
        const config = (row?.config ?? {}) as Record<string, unknown>
        return (
          <section className="card" key={spec.kind}>
            <h2>{spec.title}</h2>
            <p className="muted small">{spec.blurb}</p>

            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(row?.enabled)}
                onChange={(e) => setEnabled(spec.kind, e.target.checked)}
              />
              Use this organization's own settings
            </label>

            <div className="grid2" style={{ marginTop: 12 }}>
              {spec.fields.map((f) =>
                f.type === 'checkbox' ? (
                  <label className="check" key={f.key}>
                    <input
                      type="checkbox"
                      checked={Boolean(config[f.key])}
                      onChange={(e) => setField(spec.kind, f.key, e.target.checked)}
                    />
                    {f.label}
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
                      onChange={(e) =>
                        setField(
                          spec.kind,
                          f.key,
                          f.type === 'json' ? safeJson(e.target.value) : e.target.value,
                        )
                      }
                    />
                    {f.hint && <span className="muted small">{f.hint}</span>}
                  </label>
                ),
              )}
            </div>

            {spec.secret && (
              <div style={{ marginTop: 12 }}>
                <label className="field">
                  {spec.secret.label}
                  <textarea
                    rows={3}
                    value={secretInput[spec.kind] ?? ''}
                    placeholder={
                      hasSecret[spec.kind]
                        ? 'A key is stored. Paste a new one to replace it.'
                        : '-----BEGIN PRIVATE KEY-----…'
                    }
                    onChange={(e) =>
                      setSecretInput((p) => ({ ...p, [spec.kind]: e.target.value }))
                    }
                  />
                  <span className="muted small">{spec.secret.hint}</span>
                </label>
                {hasSecret[spec.kind] && (
                  <p className="muted small">
                    A key is stored for this organization.{' '}
                    <button className="linklike" onClick={() => void clearSecret(spec)}>
                      Remove it
                    </button>
                  </p>
                )}
              </div>
            )}

            <button type="button" onClick={() => void save(spec)} disabled={busy === spec.kind}>
              {busy === spec.kind ? 'Saving…' : `Save ${spec.title}`}
            </button>
          </section>
        )
      })}
    </>
  )
}

/** Keep whatever was typed if it is not valid JSON yet, so editing is possible. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
