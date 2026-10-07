import { supabase } from './supabase'

export interface GreeterVisitor {
  id: string
  first_name: string
  last_name: string
  created_at: string
  has_selfie: boolean
  has_license: boolean
  selfie_status: 'pending' | 'sent' | 'failed' | 'skipped' | 'deleted'
  license_status: 'pending' | 'sent' | 'failed' | 'skipped' | 'deleted'
}

/** The recent visitor sign-ins for the greeter desk. */
export async function greeterFeed(
  orgId: string,
): Promise<{ org_name: string | null; visitors: GreeterVisitor[] }> {
  const { data, error } = await supabase.functions.invoke('greeter-feed', {
    body: { org_id: orgId },
  })
  if (error) throw new Error('Could not reach the server.')
  if (!data?.ok) throw new Error(data?.error ?? 'Could not load the desk.')
  return {
    org_name: (data.org_name as string | null) ?? null,
    visitors: (data.visitors as GreeterVisitor[]) ?? [],
  }
}

/**
 * Fetch one visitor image (selfie or licence) as an object URL.
 *
 * A raw fetch rather than functions.invoke: the response is image bytes, not
 * JSON, and we want it as a blob. Returns null when there is nothing to show —
 * never taken, or deleted since by the retention policy — so the caller shows a
 * placeholder. Remember to revokeObjectURL when done.
 */
export async function fetchVisitorImage(
  entryId: string,
  kind: 'selfie' | 'license',
): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) return null
  const base = import.meta.env.VITE_SUPABASE_URL
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY
  try {
    const res = await fetch(`${base}/functions/v1/visitor-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anon,
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ entry_id: entryId, kind }),
    })
    if (!res.ok) return null
    const blob = await res.blob()
    if (!blob.size) return null
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}
