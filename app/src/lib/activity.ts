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

    // --- where the data goes
    case 'integration.create':
      return `added ${who} as a destination`
    case 'integration.enabled':
      return `${d.to ? 'switched on' : 'switched off'} ${who}`
    case 'integration.default':
      return `made ${who} ${d.to ? 'on' : 'off'} by default for printers`
    case 'integration.rename':
      return `renamed ${d.from} to ${who}`
    case 'integration.update': {
      // Names what moved, not the values. The whole configuration before and
      // after is on the row for anyone who needs it; a row of form field ids
      // is not something to read in a table.
      const keys = Array.isArray(d.changed) ? (d.changed as string[]) : []
      return keys.length
        ? `changed ${keys.join(', ')} on ${who}`
        : `changed the settings for ${who}`
    }
    case 'integration.credential':
      return `${d.action === 'cleared' ? 'removed' : d.action === 'replaced' ? 'replaced' : 'stored'} the credential for ${who}`
    case 'integration.delete':
      return `deleted the destination ${who}`
    case 'printer.destination':
      return d.to === 'default'
        ? `put ${d.printer} back to the default for ${who}`
        : `switched ${who} ${d.to} for ${d.printer}`

    // --- print servers
    case 'bridge.issue':
      return `issued a print-server credential (${d.prefix}…)`
    case 'bridge.revoke':
      return `revoked a print-server credential (${d.prefix}…)`
    case 'device.reissue':
      return `reflashed ${who}${d.moved ? ', moving it here' : ''} — ${d.revoked_credentials} credential(s) revoked`
    case 'device.released':
      return `${who} was reassigned away — ${d.revoked_credentials} credential(s) revoked`
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
