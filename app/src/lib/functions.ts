import { supabase } from './supabase'

/** What every Edge Function in this project returns. */
export interface FnResult {
  ok: boolean
  error?: string
  detail?: string
  [key: string]: unknown
}

/**
 * Call an Edge Function and get its *own* error message back.
 *
 * supabase-js discards the response body on any non-2xx and hands back
 * "Edge Function returned a non-2xx status code", which is never the reason
 * and cannot be acted on. The Response itself is on `error.context`, and the
 * function's JSON is inside it — so the careful error messages the functions
 * already write ("Only an owner can add an operator", "Check the project's
 * SMTP settings") reach the person who needs them instead of being replaced
 * by a status code.
 */
export async function invokeFn(name: string, body: Record<string, unknown>): Promise<FnResult> {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (!error) return (data as FnResult) ?? { ok: false, error: 'The function returned nothing.' }

  const ctx = (error as { context?: Response }).context
  if (ctx && typeof ctx.json === 'function') {
    try {
      const parsed = (await ctx.json()) as FnResult
      if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') return parsed
    } catch {
      // Not JSON — a gateway error page, or a function that crashed before it
      // could answer. The status is then genuinely all there is.
    }
    return { ok: false, error: `${error.message} (HTTP ${ctx.status})` }
  }
  return { ok: false, error: error.message }
}
