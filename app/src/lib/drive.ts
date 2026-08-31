/**
 * The folder id out of whatever someone pasted.
 *
 * People copy the address bar, not an id — the id is a thing you only know
 * about if you have been told to look for it. So take the link, and take a
 * bare id too, because anyone who has done this before will paste that.
 *
 * Returns '' when it is clearly a link but not to a folder, so the caller can
 * say so rather than storing something Drive will refuse later, in front of a
 * visitor.
 */
export function driveFolderId(input: string): string {
  const raw = input.trim()
  if (!raw) return ''

  // .../folders/<id>, with anything after it: a query string from the Share
  // dialog, a trailing slash, a fragment.
  const inPath = raw.match(/\/folders\/([A-Za-z0-9_-]+)/)
  if (inPath) return inPath[1]

  // The older ?id= form, still what some Drive links produce.
  const inQuery = raw.match(/[?&]id=([A-Za-z0-9_-]+)/)
  if (inQuery) return inQuery[1]

  // A link we could not read a folder out of — a file, a shared drive root, or
  // something else entirely. Refused rather than guessed at.
  if (/^https?:\/\//i.test(raw) || raw.includes('/')) return ''

  // Otherwise assume it is the id itself. Drive ids are this alphabet; anything
  // else is a typo or a stray space from a copy.
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : ''
}
