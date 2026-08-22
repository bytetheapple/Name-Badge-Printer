export interface Printer {
  id: string
  org_id: string
  name: string
  location: string | null
  printer_ip: string | null
  port: number
  reachable: boolean | null
  media_type: string | null
  media_width: string | null
  error_state: string | null
  last_checked: string | null
  header_image_url: string | null
  created_at: string
}

export interface FormEntry {
  id: string
  org_id: string
  first_name: string
  last_name: string | null
  pronouns: string | null
  phone: string | null
  email: string | null
  visitor_type: 'member' | 'visitor'
  printer_id: string | null
  printer?: { name: string } | null
  party_id: string | null
  is_primary: boolean
  source_ip: string | null
  google_sync_status: 'pending' | 'sent' | 'failed' | 'skipped'
  google_synced_at: string | null
  google_error: string | null
  created_at: string
}

export interface PrinterConfigRow {
  id: number
  org_id: string
  label_media: string
  dpi: number
  badge_template: Record<string, unknown>
  updated_at: string
}

export interface PrinterStatusRow {
  id: number
  org_id: string
  bridge_last_seen: string | null
  updated_at: string
}

export interface PrintJob {
  id: string
  org_id: string
  entry_id: string | null
  printer_id: string | null
  printer?: { name: string } | null
  type: 'badge' | 'test'
  status: 'queued' | 'printing' | 'printed' | 'failed'
  attempts: number
  header_image_url: string | null
  error: string | null
  created_at: string
  claimed_at: string | null
  printed_at: string | null
}
