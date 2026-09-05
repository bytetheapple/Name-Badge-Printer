export type Role = 'owner' | 'admin' | 'staff'

export interface Organization {
  id: string
  slug: string
  name: string
  status: 'active' | 'suspended'
  /**
   * Whether this org may configure bespoke sync targets. Granted by the
   * platform team after the integration has actually been built — an org
   * cannot turn it on for itself.
   */
  custom_integrations: boolean
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
  /** First successful connection. Null means the card has never been booted. */
  first_used_at: string | null
  superseded_at: string | null
  /** Set when the device could not store a replacement credential. */
  rotation_error: string | null
  rotation_failed_at: string | null
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

export type IntegrationKind = 'google_form' | 'shulcloud' | 'google_drive' | 'google_sheet' | 'google_oauth'

/** One organization's settings for one external system. Credentials are not
 *  here — they live in Vault and are never returned to the browser. */
export interface Integration {
  id: string
  org_id: string
  kind: IntegrationKind
  /** What this one is called. An organization may have several of a kind — two
   *  ShulCloud forms for two audiences — so the name is how they are told
   *  apart. Resolved when a row is rendered, so renaming updates history. */
  name: string
  enabled: boolean
  /** Whether a printer that says nothing about this uses it. Per-printer
   *  exceptions live in printer_integrations and override this. */
  default_enabled: boolean
  config: Record<string, unknown>
  updated_at: string
  created_at: string
}

/** What happened when one sign-in was sent to one destination. */
export interface EntryDelivery {
  id: number
  entry_id: string
  integration_id: string | null
  status: 'pending' | 'sent' | 'failed' | 'skipped'
  error: string | null
  attempted_at: string | null
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

/** One printer a scan turned up during a guided setup. */
export interface ProvisioningCandidate {
  ip: string
  mac: string | null
  model: string | null
  via: string
  /** The printer this already is, if the org has it configured. */
  configured_as?: string | null
  /** And its id — what a re-home binds to, so moving a printer corrects its
   *  record instead of creating a second one for the same hardware. */
  configured_id?: string | null
}

/** One entry in a session's transcript — what the print server reported. */
export interface ProvisioningLogEntry {
  at: string
  step: string
  ok: boolean
  text: string
}

/**
 * A printer setup in progress.
 *
 * `state` is the step it is waiting on. Four of them belong to the print
 * server (discover, configure, wifi, rediscover) and the rest to whoever is
 * standing at the printer.
 */
export interface ProvisioningSession {
  /** What this session is doing. 'setup' is a printer out of a box; 'rehome'
   *  is a configured printer that has moved to another network and must not be
   *  reset; 'locate' is unattended and only corrects an address. */
  kind: 'setup' | 'rehome' | 'locate'
  id: string
  org_id: string
  state: string
  printer_name: string | null
  location: string | null
  ssid: string | null
  candidates: ProvisioningCandidate[]
  wired_ip: string | null
  model: string | null
  serial: string | null
  firmware: string | null
  /** SSIDs the printer itself reported seeing, for the network picker. */
  visible_networks: string[]
  wireless_mac: string | null
  wireless_ip: string | null
  printer_id: string | null
  task_started_at: string | null
  log: ProvisioningLogEntry[]
  error: string | null
  created_at: string
  updated_at: string
}

/** A version that has been released, with something said about it. */
export interface BridgeRelease {
  id: string
  ref: string
  label: string
  notes: string | null
  created_at: string
}

/** A print server that has been built, or is being built. */
export interface PiDevice {
  id: string
  serial: string
  org_id: string | null
  customer: string | null
  notes: string | null
  claim_prefix: string | null
  claimed_at: string | null
  /** Overrides the fleet release for this device — a staged rollout, or a
   *  customer held on a known-good version. */
  pinned_ref: string | null
  /** What it last reported running. Reported, never assumed. */
  running_ref: string | null
  last_seen: string | null
  update_error: string | null
  bridge_token_id: string | null
  created_at: string
}

/** One tenant as the platform team sees it, from platform_overview(). */
export interface PlatformOrg {
  org_id: string
  slug: string
  name: string
  status: 'active' | 'suspended'
  custom_integrations: boolean
  created_at: string
  members: number
  printers: number
  entries_30d: number
  bridge_last_seen: string | null
  live_bridges: number
}

/** A member of an organization, as returned by the org_members() function. */
export interface OrgMember {
  user_id: string
  email: string
  role: Role
  created_at: string
}

/** One thing that happened, and who did it. Actor and subject are stored as
 *  text as well as ids, so an entry still reads correctly after the account it
 *  describes has been deleted — which is one of the things it records. */
export interface ActivityEntry {
  id: number
  at: string
  org_id: string | null
  actor_email: string | null
  action: string
  subject: string | null
  detail: Record<string, unknown>
}

/** Guest Badges staff, as distinct from a customer's own people. An operator
 *  holds no membership in any organization — that is what keeps them off a
 *  customer's Members tab as a fact rather than as a filter. */
export type OperatorRole = 'owner' | 'support'

export interface Operator {
  user_id: string
  email: string
  role: OperatorRole
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
  /** Which of the three possible headers this printer uses. */
  badge_header_mode: 'text' | 'logo' | 'image'
  location: string | null
  printer_ip: string | null
  /** Wireless MAC — how the printer is found again when its address changes.
   *  Null on printers configured before this was recorded; the bridge fills
   *  it in on the first heartbeat where the printer answers. */
  mac: string | null
  /** Wired MAC. Separate because the mDNS name depends on which interface
   *  answers: BRW+mac on wireless, BRN+wired_mac on Ethernet. */
  wired_mac: string | null
  port: number
  reachable: boolean | null
  media_type: string | null
  media_width: string | null
  error_state: string | null
  /** Why the bridge could not reach this printer, in words an operator can
   *  act on. Null while it is reachable. "Unreachable" alone sent somebody
   *  hunting a printer fault that was really two networks with no route. */
  unreachable_reason: string | null
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
  /** The visitor asked to hear more from this congregation. False for members,
   *  and false for an untouched box — which is a no, not an unknown. */
  wants_followup: boolean
  /** How an additional badge relates to whoever signed the family in. Null on
   *  the primary row and on a lone sign-in. */
  relationship: string | null
  source_ip: string | null
  google_sync_status: 'pending' | 'sent' | 'failed' | 'skipped'
  /** Recorded since August, and until now never shown anywhere. */
  shulcloud_sync_status: 'pending' | 'sent' | 'failed' | 'skipped'
  shulcloud_error: string | null
  /** 'skipped' means no photo reached us; 'failed' means it did and could not
   *  be stored, with the reason in selfie_error. */
  /** Where the photograph ended up, when one was stored. */
  selfie_link: string | null
  selfie_status: 'pending' | 'sent' | 'failed' | 'skipped'
  selfie_error: string | null
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

/** One network the print server is on. A printer is reachable only from a
 *  network the server shares with it, which is the question this answers. */
export interface ServerInterface {
  name: string
  kind: 'wired' | 'wifi' | 'unknown'
  state: string
  ip: string | null
  ssid?: string | null
  signal?: number | null
}

export interface ServerNetwork {
  interfaces: ServerInterface[]
  /** nmcli's word for the radio: 'enabled', 'disabled', or null where we
   *  could not ask (a Mac running a demo bridge). */
  wifi_radio?: string | null
}

export interface PrinterStatusRow {
  id: number
  org_id: string
  bridge_last_seen: string | null
  /** Reported every heartbeat. Null from a bridge too old to send it — which
   *  is not the same as a server with no networks, so it is shown as unknown
   *  rather than as none. */
  network: ServerNetwork | null
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
