import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import { useAuth } from './auth'
import type { OrgMembership, Role } from './types'

const STORAGE_KEY = 'nbk.orgId'

interface OrgState {
  /** Every organization the signed-in user belongs to, with their role in each. */
  orgs: OrgMembership[]
  /** The org currently being administered, or null while loading / if none. */
  org: OrgMembership | null
  orgId: string | null
  role: Role | null
  /** Owner or admin — the line most of the UI actually cares about. */
  isAdmin: boolean
  isOwner: boolean
  /**
   * The operator, not a tenant role at all.
   *
   * Presentation only: every platform-only function checks this itself in the
   * database, so a wrong answer here shows or hides a link and leaks nothing.
   */
  isPlatformAdmin: boolean
  /** True when the current organization is one the person actually belongs to.
   *  False for an operator reaching in, which is what the marked background
   *  and the banner key on. */
  isMember: boolean
  loading: boolean
  error: string | null
  switchOrg: (orgId: string) => void
  reload: () => Promise<void>
}

const OrgContext = createContext<OrgState | undefined>(undefined)

/**
 * Loads the user's memberships and tracks which org the admin UI is acting on.
 *
 * RLS already confines every query to the user's orgs, but a user may belong to
 * more than one (the operator does), so screens must still filter by the
 * selected org_id explicitly — otherwise two tenants' rows would appear in one
 * table. This context is where that id comes from.
 */
export function OrgProvider({ children }: { children: ReactNode }) {
  const { session, loading: authLoading } = useAuth()
  const userId = session?.user.id ?? null

  const [orgs, setOrgs] = useState<OrgMembership[]>([])
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false)
  const [memberOrgIds, setMemberOrgIds] = useState<Set<string>>(new Set())
  const [orgId, setOrgId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!userId) {
      setOrgs([])
      setOrgId(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    // Two plain queries rather than one embedded select: the membership rows
    // and the org rows are both tiny, and this avoids depending on PostgREST
    // resolving the relationship by name.
    //
    // Filter by user_id — the membership policy exposes every member of the
    // user's orgs, not just their own rows.
    const { data: rows, error } = await supabase
      .from('memberships')
      .select('org_id, role')
      .eq('user_id', userId)
    if (error) {
      setError(error.message)
      setOrgs([])
      setLoading(false)
      return
    }
    // RLS lets a user see only their own row here, so "a row came back" is the
    // whole check — there is nothing to compare against.
    const { data: pa } = await supabase.from('platform_admins').select('user_id').limit(1)
    setIsPlatformAdmin(Boolean(pa?.length))

    const operator = Boolean(pa?.length)
    const ids = (rows ?? []).map((r) => r.org_id as string)
    //: Which of these the person actually belongs to, kept separately from the
    //: list they can reach. An operator reaches every organization but is a
    //: member of none, and telling those apart is what decides whether the
    //: page is marked as operator access.
    setMemberOrgIds(new Set(ids))

    // An operator selects from every organization; everyone else from theirs.
    // The platform read policy on `organizations` is what makes the unfiltered
    // query return anything, so this is not a second source of truth.
    const { data: orgRows, error: orgError } = operator
      ? await supabase
          .from('organizations')
          .select('id, slug, name, status, custom_integrations')
      : ids.length
        ? await supabase
            .from('organizations')
            .select('id, slug, name, status, custom_integrations')
            .in('id', ids)
        : { data: [], error: null }
    if (orgError) {
      setError(orgError.message)
      setOrgs([])
      setLoading(false)
      return
    }
    const roleById = new Map((rows ?? []).map((r) => [r.org_id as string, r.role as Role]))
    const list: OrgMembership[] = (orgRows ?? [])
      .map((o) => ({
        org_id: o.id as string,
        // A real membership wins, matching auth_org_role(): someone who is both
        // an operator and a genuine member keeps their own role.
        role: roleById.get(o.id as string) ?? ('owner' as Role),
        organization: o as unknown as OrgMembership['organization'],
      }))
      .sort((a, b) => a.organization.name.localeCompare(b.organization.name))

    setOrgs(list)
    setOrgId((current) => {
      const remembered = current ?? window.localStorage.getItem(STORAGE_KEY)
      // Fall back to the first org whenever the remembered one is gone — e.g.
      // the user's access to it was removed while they were away.
      return list.some((m) => m.org_id === remembered) ? remembered : (list[0]?.org_id ?? null)
    })
    setLoading(false)
  }, [userId])

  useEffect(() => {
    if (authLoading) return
    void load()
  }, [authLoading, load])

  const switchOrg = useCallback((next: string) => {
    setOrgId(next)
    window.localStorage.setItem(STORAGE_KEY, next)
  }, [])

  const value = useMemo<OrgState>(() => {
    const org = orgs.find((m) => m.org_id === orgId) ?? null
    const role = org?.role ?? null
    return {
      orgs,
      org,
      orgId: org?.org_id ?? null,
      role,
      isAdmin: role === 'owner' || role === 'admin',
      isOwner: role === 'owner',
      isPlatformAdmin,
      isMember: orgId !== null && memberOrgIds.has(orgId),
      loading: loading || authLoading,
      error,
      switchOrg,
      reload: load,
    }
  }, [orgs, orgId, loading, authLoading, error, switchOrg, load, isPlatformAdmin, memberOrgIds])

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

export function useOrg() {
  const ctx = useContext(OrgContext)
  if (!ctx) throw new Error('useOrg must be used within an OrgProvider')
  return ctx
}
