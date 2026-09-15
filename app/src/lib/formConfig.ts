// The shape of the sign-in form, per audience: which questions are asked, and
// whether each is required. First and last name are always shown and required
// and are not represented here. Selfie is handled separately — it is
// visitor-only and tied to the Google Drive connection — via
// app_settings.selfie_mode.
//
// This file is the app's copy; supabase/functions/_shared/formConfig.ts is an
// identical copy for the Edge Functions (the two builds cannot share a module).
// Keep them in step.

export type FieldState = 'hidden' | 'optional' | 'required'
export type Audience = 'member' | 'visitor'

/** The fields this config governs, in the order the panel lists them. */
export const CONFIGURABLE_FIELDS = ['pronouns', 'phone', 'email'] as const
export type ConfigField = (typeof CONFIGURABLE_FIELDS)[number]

export type AudienceConfig = Record<ConfigField, FieldState>
export type FieldConfig = Record<Audience, AudienceConfig>

/**
 * The built-in defaults, matching the behaviour before this setting existed, so
 * a row that has never been edited (field_config null) behaves exactly as it
 * did. `pronounsEnabled` comes from the old app_settings.pronouns_enabled.
 */
export function defaultFieldConfig(pronounsEnabled: boolean): FieldConfig {
  const pronouns: FieldState = pronounsEnabled ? 'optional' : 'hidden'
  return {
    member: { pronouns, phone: 'optional', email: 'optional' },
    visitor: { pronouns, phone: 'required', email: 'required' },
  }
}

function asState(v: unknown, fallback: FieldState): FieldState {
  return v === 'hidden' || v === 'optional' || v === 'required' ? v : fallback
}

/**
 * A complete, valid config from whatever is stored — which may be null, partial,
 * or (from an untrusted response) malformed — filling every gap from the
 * defaults so callers never have to guard a missing field.
 */
export function resolveFieldConfig(raw: unknown, pronounsEnabled: boolean): FieldConfig {
  const d = defaultFieldConfig(pronounsEnabled)
  const r = (raw ?? {}) as Partial<Record<Audience, Partial<AudienceConfig>>>
  const one = (a: Audience): AudienceConfig => ({
    pronouns: asState(r[a]?.pronouns, d[a].pronouns),
    phone: asState(r[a]?.phone, d[a].phone),
    email: asState(r[a]?.email, d[a].email),
  })
  return { member: one('member'), visitor: one('visitor') }
}
