// Per-organization integration settings (MULTI_TENANT_DESIGN.md §11).
//
// Each org configures its own Google Form, CRM endpoint and Drive service
// account. While an org has nothing configured, the project-wide environment
// variables are used instead — but only while this is a single-tenant database.
// The moment a second org exists that fallback would mean one congregation's
// visitors syncing into another's systems, so it is withdrawn rather than
// guessed at. Same failsafe as everywhere else in this refactor.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const REST = `${SUPABASE_URL}/rest/v1`;
export const restHeaders = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

export type IntegrationKind = "google_form" | "shulcloud" | "google_drive";

export interface Integration {
  enabled: boolean;
  config: Record<string, unknown>;
  secret: string | null;
}

/** The org a form entry belongs to — the trusted starting point for a sync. */
export async function orgOfEntry(entryId: string): Promise<string | null> {
  const res = await fetch(`${REST}/form_entries?id=eq.${entryId}&select=org_id`, {
    headers: restHeaders,
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? (rows[0].org_id as string) : null;
}

/** This org's configuration for one integration, or null if it has none. */
export async function integrationFor(
  orgId: string,
  kind: IntegrationKind,
): Promise<Integration | null> {
  const res = await fetch(`${REST}/rpc/integration_for`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ p_org: orgId, p_kind: kind }),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!rows.length) return null;
  const row = rows[0];
  return {
    enabled: Boolean(row.enabled),
    config: (row.config ?? {}) as Record<string, unknown>,
    secret: (row.secret ?? null) as string | null,
  };
}

let soleOrg: boolean | null = null;

/**
 * Whether the project-wide environment fallback is still honest — i.e. there is
 * exactly one organization, so "the global setting" and "this org's setting"
 * cannot disagree. Cached per instance; a second org is not created often, and
 * an instance is short-lived.
 */
export async function envFallbackAllowed(): Promise<boolean> {
  if (soleOrg !== null) return soleOrg;
  const res = await fetch(`${REST}/organizations?select=id&limit=2`, { headers: restHeaders });
  const rows = res.ok ? await res.json() : [];
  soleOrg = rows.length === 1;
  return soleOrg;
}

/**
 * Resolve one integration's settings: the org's own if configured, otherwise
 * the environment defaults while that is still safe.
 *
 * Returns null when neither applies — the caller should skip rather than fail,
 * matching the existing "not configured" behaviour.
 */
export async function resolveSettings(
  orgId: string | null,
  kind: IntegrationKind,
  envDefaults: () => Record<string, unknown>,
): Promise<{ config: Record<string, unknown>; secret: string | null; source: string } | null> {
  if (orgId) {
    const own = await integrationFor(orgId, kind);
    if (own?.enabled) return { config: own.config, secret: own.secret, source: "org" };
  }
  if (await envFallbackAllowed()) {
    return { config: envDefaults(), secret: null, source: "env" };
  }
  return null;
}
