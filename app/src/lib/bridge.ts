/**
 * How long since a print server's last check-in before the console calls it
 * offline.
 *
 * The bridge writes bridge_last_seen on every poll, roughly every two seconds,
 * so this is a tolerance rather than a measurement: a server that misses a few
 * polls to a momentary hiccup is not down, and flipping the indicator red for
 * that would train people to ignore it. Fifteen seconds is about seven missed
 * check-ins -- past a blip, still quick enough that a real drop shows while
 * someone is watching. One definition, imported everywhere the online/offline
 * line is drawn, so the three screens that draw it cannot disagree.
 */
export const BRIDGE_FRESH_MS = 15000
