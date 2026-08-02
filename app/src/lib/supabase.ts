import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/** True when both Supabase env vars are present at build/runtime. */
export const isSupabaseConfigured = Boolean(url && anonKey)

if (!isSupabaseConfigured) {
  console.warn(
    'Supabase env vars missing. Copy app/.env.example to app/.env.local and set ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
  )
}

// Safe to construct with empty strings; calls simply fail until env vars are set.
export const supabase = createClient(url ?? '', anonKey ?? '')

/** Lightweight reachability check used by the ConnectionBanner. */
export async function pingSupabase(): Promise<{ ok: boolean; message: string }> {
  if (!isSupabaseConfigured) {
    return {
      ok: false,
      message: 'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (see app/.env.example)',
    }
  }
  try {
    // The Auth settings endpoint accepts the anon key and requires no tables,
    // so it validates both reachability and key validity. (The PostgREST root
    // /rest/v1/ is restricted to the service_role key and would 401 here.)
    const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anonKey as string } })
    if (res.ok) return { ok: true, message: 'Connected to Supabase' }
    if (res.status === 401) {
      return { ok: false, message: 'Supabase rejected the anon key (check VITE_SUPABASE_ANON_KEY)' }
    }
    return { ok: false, message: `Supabase responded with HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, message: `Cannot reach Supabase: ${(e as Error).message}` }
  }
}
