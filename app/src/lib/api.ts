import { supabase } from './supabase'

/**
 * Identifies which kiosk (and therefore which organization) a public call is
 * for. `kiosk_token` is the supported form; `printer_id` is the older
 * ?printer=<uuid> link, still accepted so printed QR codes keep working.
 */
export interface KioskRef {
  kiosk_token: string | null
  printer_id: string | null
}

export interface SubmitResult {
  entry_id: string
  job_ids: string[]
}

/** One additional (name-only) family/party member printed alongside the primary. */
export interface AdditionalPerson {
  first_name: string
  last_name: string
  pronouns: string
  /** How they relate to whoever is signing the family in. Empty when the
   *  visitor chose not to say — the field is optional on purpose. */
  relationship?: string
}

/** Submit the public badge form via the submit-badge Edge Function. */
export async function submitBadge(input: {
  visitor_type: 'member' | 'visitor'
  first_name: string
  last_name: string
  pronouns: string
  phone: string
  email: string
  wants_followup?: boolean
  additional?: AdditionalPerson[]
} & KioskRef): Promise<SubmitResult> {
  const { data, error } = await supabase.functions.invoke('submit-badge', { body: input })
  if (error) throw new Error('Could not reach the server. Please try again.')
  if (!data?.ok) throw new Error(data?.error ?? 'Something went wrong. Please try again.')
  return { entry_id: data.entry_id, job_ids: data.job_ids ?? [data.job_id] }
}

export type SelfieMode = 'off' | 'optional' | 'required'

/** Public config the visitor/member form needs. */
export async function getPublicConfig(kiosk: KioskRef): Promise<{
  selfie_mode: SelfieMode
  pronouns_enabled: boolean
  /** The congregation's display name, for the wording of the follow-up
   *  question. Null when the kiosk could not be resolved, in which case the
   *  form falls back to naming nobody rather than guessing. */
  org_name: string | null
}> {
  try {
    const { data } = await supabase.functions.invoke('public-config', { body: kiosk })
    return {
      selfie_mode: (data?.selfie_mode ?? 'off') as SelfieMode,
      pronouns_enabled: Boolean(data?.pronouns_enabled),
      org_name: (data?.org_name as string | null) ?? null,
    }
  } catch {
    return { selfie_mode: 'off', pronouns_enabled: false, org_name: null }
  }
}

/** Upload a visitor selfie to Google Drive (fire-and-forget from the caller). */
export async function uploadSelfie(input: {
  entry_id: string
  first_name: string
  last_name: string
  image: string
}): Promise<void> {
  await supabase.functions.invoke('upload-selfie', { body: input })
}

export type JobStatus = 'queued' | 'printing' | 'printed' | 'failed'

/** Poll a single print job's status via the job-status Edge Function. */
export async function getJobStatus(
  jobId: string,
  kiosk: KioskRef | { event_token: string },
): Promise<{ status: JobStatus; error: string | null }> {
  const { data, error } = await supabase.functions.invoke('job-status', {
    body: { job_id: jobId, ...kiosk },
  })
  if (error) throw new Error('status check failed')
  if (!data?.ok) throw new Error(data?.error ?? 'status check failed')
  return { status: data.status, error: data.error }
}

/** What an event registration page shows before anybody types anything. */
export interface EventConfig {
  event_name: string
  org_name: string
  printer_name: string | null
}

/**
 * Resolve a printed event QR code.
 *
 * Returns null when the code is not open — a finished event, a disabled one,
 * or a customer whose Events feature has been switched off. The page says so
 * rather than failing blankly, because the code is on a table in front of
 * somebody and the answer has to be actionable by whoever is standing there.
 */
export async function getEventConfig(token: string): Promise<EventConfig | null> {
  try {
    const { data } = await supabase.functions.invoke('event-config', { body: { token } })
    if (!data?.ok) return null
    return {
      event_name: String(data.event_name ?? 'Event'),
      org_name: String(data.org_name ?? ''),
      printer_name: (data.printer_name as string | null) ?? null,
    }
  } catch {
    return null
  }
}

export interface EventRegisterResult {
  job_ids: string[]
  /** True when they were not on the pre-registration list. The page does not
   *  say so — being told you are a walk-in is the desk's business, not the
   *  guest's — but the badge is marked and the desk can see it. */
  onsite: boolean
  /** Set when the spreadsheet could not be written. The badge still printed;
   *  this is what the desk would otherwise have no way to know. */
  sheet_error: string | null
}

export async function registerForEvent(input: {
  token: string
  first_name: string
  last_name: string
  phone: string
  email: string
  wants_followup: boolean
}): Promise<EventRegisterResult> {
  const { data, error } = await supabase.functions.invoke('event-register', { body: input })
  if (error) throw new Error('Could not reach the server. Please try again.')
  if (!data?.ok) throw new Error(data?.error ?? 'Something went wrong. Please try again.')
  return {
    job_ids: data.job_ids ?? [],
    onsite: Boolean(data.onsite),
    sheet_error: (data.sheet_error as string | null) ?? null,
  }
}
