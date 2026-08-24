export type Role = 'owner' | 'admin' | 'staff'

export interface Organization {
  id: string
  slug: string
  name: string
  status: 'active' | 'suspended'
}

/** One organization the signed-in user belongs to, with their role in it. */
export interface OrgMembership {
  org_id: string
  role: Role
  organization: Organization
}

/** A print bridge's credential. The secret itself is never stored or returned —
 *  only its hash, and a short prefix so tokens can be told apart. */
export interface BridgeToken {
  id: string
  org_id: string
  name: string | null
  token_prefix: string | null
  printer_ids: string[] | null
  last_seen: string | null
  created_at: string
  revoked_at: string | null
}

/** A key for the external print API, scoped to one organization. Like bridge
 *  tokens, only the hash is stored. */
export interface ApiKey {
  id: string
  org_id: string
  name: string | null
  key_prefix: string | null
  last_used_at: string | null
  created_at: string
  revoked_at: string | null
}

export type IntegrationKind = 'google_form' | 'shulcloud' | 'google_drive'

/** One organization's settings for one external system. Credentials are not
 *  here — they live in Vault and are never returned to the browser. */
export interface Integration {
  id: string
  org_id: string
  kind: IntegrationKind
  enabled: boolean
  config: Record<string, unknown>
  updated_at: string
  created_at: string
}

/** A printer the bridge saw on the local network. A cache of a scan, not a
 *  record — safe to discard, and it reappears on the next scan. */
export interface DiscoveredPrinter {
  id: string
  org_id: string
  ip: string
  mac: string | null
  model: string | null
  node_name: string | null
  first_seen: string
  last_seen: string
}

/** A member of an organization, as returned by the org_members() function. */
export interface OrgMember {
  user_id: string
  email: string
  role: Role
  created_at: string
}

export interface Printer {
  id: string
  org_id: string
  name: string
  /** Opaque, rotatable identifier encoded in this printer's lobby QR code. */
  kiosk_token: string
  /** Badge wording, per printer: a lobby desk and a social hall can differ. */
  badge_header: string | null
  badge_subtitle: string | null
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
