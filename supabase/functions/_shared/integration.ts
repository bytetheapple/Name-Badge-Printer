// Per-organization integration settings (MULTI_TENANT_DESIGN.md §11).
//
// Each org configures its own Google Form, CRM endpoint and Drive service
// account, and that is now the only source. There used to be a fallback to
// project-wide environment variables for an org with nothing configured, held
// safe by a check that only one organization existed — a failsafe that had to
// be right every time it ran.
//
// It is gone because it is no longer needed: the one organization on this
// deployment configures everything itself, verified end to end. An org with a
// missing setting now gets "not configured" and nothing is sent, which is the
// only answer that cannot be wrong for somebody else.
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

/**
 * This organization's settings for one integration, or null if it has none.
 *
 * Returns null rather than throwing when an org has not configured something —
 * the caller skips, which is what the "not configured" replies downstream are
 * for. Nothing is inherited from anywhere: an unconfigured org syncs nowhere.
 */
export async function resolveSettings(
  orgId: string | null,
  kind: IntegrationKind,
): Promise<{ config: Record<string, unknown>; secret: string | null; source: string } | null> {
  if (!orgId) return null;
  const own = await integrationFor(orgId, kind);
  if (!own?.enabled) return null;
  return { config: own.config, secret: own.secret, source: "org" };
}
