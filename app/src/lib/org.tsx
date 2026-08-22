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
    // Filter by user_id: the membership policy exposes every member of the
    // user's orgs, not just their own rows.
    const { data, error } = await supabase
      .from('memberships')
      .select('org_id, role, organizations(id, slug, name, status)')
      .eq('user_id', userId)
    if (error) {
      setError(error.message)
      setOrgs([])
      setLoading(false)
      return
    }
    const list: OrgMembership[] = (data ?? [])
      .map((row) => {
        const org = row.organizations as unknown as OrgMembership['organization'] | null
        return org ? { org_id: row.org_id as string, role: row.role as Role, organization: org } : null
      })
      .filter((m): m is OrgMembership => m !== null)
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
      loading: loading || authLoading,
      error,
      switchOrg,
      reload: load,
    }
  }, [orgs, orgId, loading, authLoading, error, switchOrg, load])

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

export function useOrg() {
  const ctx = useContext(OrgContext)
  if (!ctx) throw new Error('useOrg must be used within an OrgProvider')
  return ctx
}
