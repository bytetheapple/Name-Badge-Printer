import { useEffect, useState } from 'react'
import { pingSupabase } from '../lib/supabase'

/** Shows whether the app can reach the configured Supabase project. */
export function ConnectionBanner() {
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    let active = true
    pingSupabase().then((result) => {
      if (active) setState(result)
    })
    return () => {
      active = false
    }
  }, [])

  if (!state) return <div className="banner banner--pending">Checking Supabase connection…</div>

  return (
    <div className={state.ok ? 'banner banner--ok' : 'banner banner--err'}>
      {state.ok ? '✓ ' : '✕ '}
      {state.message}
    </div>
  )
}
