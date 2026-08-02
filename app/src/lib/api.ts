import { supabase } from './supabase'

export interface SubmitResult {
  job_id: string
  entry_id: string
}

/** Submit the public badge form via the submit-badge Edge Function. */
export async function submitBadge(input: {
  first_name: string
  last_name: string
  phone: string
  email: string
}): Promise<SubmitResult> {
  const { data, error } = await supabase.functions.invoke('submit-badge', { body: input })
  if (error) throw new Error('Could not reach the server. Please try again.')
  if (!data?.ok) throw new Error(data?.error ?? 'Something went wrong. Please try again.')
  return { job_id: data.job_id, entry_id: data.entry_id }
}

export type JobStatus = 'queued' | 'printing' | 'printed' | 'failed'

/** Poll a single print job's status via the job-status Edge Function. */
export async function getJobStatus(jobId: string): Promise<{ status: JobStatus; error: string | null }> {
  const { data, error } = await supabase.functions.invoke('job-status', { body: { job_id: jobId } })
  if (error) throw new Error('status check failed')
  if (!data?.ok) throw new Error(data?.error ?? 'status check failed')
  return { status: data.status, error: data.error }
}
