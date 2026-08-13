import { supabase } from './supabase'

export interface SubmitResult {
  job_id: string
  entry_id: string
}

/** Submit the public badge form via the submit-badge Edge Function. */
export async function submitBadge(input: {
  visitor_type: 'member' | 'visitor'
  first_name: string
  last_name: string
  phone: string
  email: string
  printer_id: string | null
}): Promise<SubmitResult> {
  const { data, error } = await supabase.functions.invoke('submit-badge', { body: input })
  if (error) throw new Error('Could not reach the server. Please try again.')
  if (!data?.ok) throw new Error(data?.error ?? 'Something went wrong. Please try again.')
  return { job_id: data.job_id, entry_id: data.entry_id }
}

export type SelfieMode = 'off' | 'optional' | 'required'

/** Public config the visitor form needs (selfie mode). */
export async function getPublicConfig(): Promise<{ selfie_mode: SelfieMode }> {
  try {
    const { data } = await supabase.functions.invoke('public-config', { body: {} })
    return { selfie_mode: (data?.selfie_mode ?? 'off') as SelfieMode }
  } catch {
    return { selfie_mode: 'off' }
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
export async function getJobStatus(jobId: string): Promise<{ status: JobStatus; error: string | null }> {
  const { data, error } = await supabase.functions.invoke('job-status', { body: { job_id: jobId } })
  if (error) throw new Error('status check failed')
  if (!data?.ok) throw new Error(data?.error ?? 'status check failed')
  return { status: data.status, error: data.error }
}
