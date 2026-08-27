import type { ActivityEntry } from './types'

/**
 * Plain English for one log entry.
 *
 * The `action` strings are stable identifiers meant for querying and must not
 * be changed to read better; this is the part a person reads. An unrecognised
 * action falls through to its raw name rather than being hidden, because a log
 * that silently omits what it does not understand is worse than an ugly line.
 */
export function describeActivity(e: ActivityEntry): string {
  const d = e.detail ?? {}
  const who = e.subject ?? 'something'
  switch (e.action) {
    // --- a customer's own people
    case 'member.add':
      return d.invited
        ? `invited ${who} as ${d.role}`
        : `added ${who} as ${d.role} (existing account, no email sent)`
    case 'member.role':
      return `changed ${who} from ${d.from} to ${d.to}`
    case 'member.remove':
      return d.account_deleted
        ? `deleted ${who} — their account was removed as well`
        : `removed ${who} from this organization`

    // --- organizations
    case 'org.create':
      return `created ${who}`
    case 'org.status':
      return `${d.to === 'suspended' ? 'suspended' : 'resumed'} ${who}`
    case 'org.custom_integrations':
      return `${d.enabled ? 'enabled' : 'disabled'} custom integrations for ${who}`
    case 'org.rename':
      return `renamed ${d.from} to ${who}`
    case 'org.delete':
      return `deleted ${who} — ${d.members} member(s), ${d.entries} sign-in(s), permanently`

    // --- print servers
    case 'bridge.issue':
      return `issued a print-server credential (${d.prefix}…)`
    case 'bridge.revoke':
      return `revoked a print-server credential (${d.prefix}…)`
    case 'device.allocate':
      return `allocated print server ${who}${d.customer ? ` for ${d.customer}` : ''}`
    case 'release.set':
      return d.to ? `set the fleet release to ${d.to}` : 'cleared the fleet release'

    // --- who runs the service
    case 'operator.add':
      return `made ${who} an operator (${d.role})`
    case 'operator.role':
      return `changed operator ${who} from ${d.from} to ${d.to}`
    case 'operator.remove':
      return `removed ${who} as an operator`

    default:
      return `${e.action} ${e.subject ?? ''}`.trim()
  }
}
