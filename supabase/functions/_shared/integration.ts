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

export type IntegrationKind = "google_form" | "shulcloud" | "google_drive" | "google_sheet";

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

/** One destination a sign-in should reach, with its credential. */
export interface Target {
  id: string;
  name: string;
  config: Record<string, unknown>;
  secret: string | null;
}

/**
 * Every destination of one kind that this sign-in should be sent to.
 *
 * The routing lives in SQL (integration_targets) rather than here, so the
 * three sync functions cannot drift apart on what "enabled for this printer"
 * means. Pass `only` to address a single destination — that is what a resend
 * from one row of the expanded pill does.
 */
export async function targetsFor(
  entryId: string,
  kind: IntegrationKind,
  only?: string | null,
): Promise<Target[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/integration_targets`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({ p_entry: entryId, p_kind: kind }),
  });
  if (!res.ok) {
    console.error(`integration_targets failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return [];
  }
  const rows = (await res.json()) as Target[];
  return only ? rows.filter((r) => r.id === only) : rows;
}

/** What happened at one destination. Upserts, so a retry replaces the attempt. */
export async function recordDelivery(
  entryId: string,
  integrationId: string,
  status: "pending" | "sent" | "failed" | "skipped",
  error?: string | null,
): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_delivery`, {
    method: "POST",
    headers: restHeaders,
    body: JSON.stringify({
      p_entry: entryId,
      p_integration: integrationId,
      p_status: status,
      p_error: error ?? null,
    }),
  });
  if (!res.ok) {
    // Best effort: failing to record must not turn a delivered sign-in into a
    // failed one. It goes to the log, where it is a bug rather than an outage.
    console.error(`record_delivery failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * The single status the Entries table still reads, rolled up from what
 * actually happened at each destination.
 *
 * Kept until the expandable pill ships and the per-kind columns come out. The
 * rule is deliberately pessimistic: anything short of "every destination took
 * it" is not "sent", because a green pill hiding one failed destination is
 * worse than no pill.
 */
export function rollUp(
  results: Array<{ ok: boolean; error?: string }>,
): { status: "sent" | "failed" | "pending"; error: string | null } {
  if (!results.length) return { status: "pending", error: null };
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return { status: "sent", error: null };
  return {
    status: "failed",
    error: `${failed.length} of ${results.length} failed: ${
      failed.map((f) => f.error).filter(Boolean).join("; ")
    }`.slice(0, 500),
  };
}
