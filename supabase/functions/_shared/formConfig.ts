// The shape of the sign-in form, per audience: which questions are asked, and
// whether each is required. First and last name are always shown and required
// and are not represented here. Selfie is handled separately (visitor-only,
// tied to the Google Drive connection) via app_settings.selfie_mode.
//
// This is the Edge Functions' copy of app/src/lib/formConfig.ts — the app and
// the functions cannot share a module, so the two are kept identical by hand.

export type FieldState = "hidden" | "optional" | "required";
export type Audience = "member" | "visitor";

export const CONFIGURABLE_FIELDS = ["pronouns", "phone", "email"] as const;
export type ConfigField = (typeof CONFIGURABLE_FIELDS)[number];

export type AudienceConfig = Record<ConfigField, FieldState>;
export type FieldConfig = Record<Audience, AudienceConfig>;

/** The built-in defaults, matching the behaviour before this setting existed. */
export function defaultFieldConfig(pronounsEnabled: boolean): FieldConfig {
  const pronouns: FieldState = pronounsEnabled ? "optional" : "hidden";
  return {
    member: { pronouns, phone: "optional", email: "optional" },
    visitor: { pronouns, phone: "required", email: "required" },
  };
}

function asState(v: unknown, fallback: FieldState): FieldState {
  return v === "hidden" || v === "optional" || v === "required" ? v : fallback;
}

/** A complete, valid config from whatever is stored (null / partial / malformed),
 *  every gap filled from the defaults. */
export function resolveFieldConfig(raw: unknown, pronounsEnabled: boolean): FieldConfig {
  const d = defaultFieldConfig(pronounsEnabled);
  const r = (raw ?? {}) as Partial<Record<Audience, Partial<AudienceConfig>>>;
  const one = (a: Audience): AudienceConfig => ({
    pronouns: asState(r[a]?.pronouns, d[a].pronouns),
    phone: asState(r[a]?.phone, d[a].phone),
    email: asState(r[a]?.email, d[a].email),
  });
  return { member: one("member"), visitor: one("visitor") };
}
