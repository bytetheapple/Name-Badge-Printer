import { supabase } from './supabase'

/**
 * Putting a badge-header image into storage.
 *
 * One function for both kinds of header image — the organization's name mark
 * and a graphic for one printer — because they are the same bytes in the same
 * bucket with the same rules, and two copies of this drifted on the thing that
 * matters: what is accepted and how it is named.
 *
 * Content-addressed: the object's name is the SHA-256 of its bytes, so
 * uploading the same image twice reuses the object and the bridge's cache,
 * while a changed image always gets a fresh URL. It also means the name mark
 * and a printer's graphic can point at one object without either owning it.
 */

const BUCKET = 'badge-headers'
export const MAX_HEADER_BYTES = 2_000_000

/**
 * What a header image should be, in words an operator can act on. The bridge
 * scales it to about 28% of the badge's height and caps it at the badge's
 * inner width, so on a DK-1234 label that is roughly 190 pixels tall by up to
 * 810 wide. A thermal printer has no grey and no colour, so anything but
 * solid black artwork comes out as dither.
 */
export const HEADER_IMAGE_GUIDANCE =
  'PNG or JPEG, under 2 MB. It prints about 190 pixels tall and up to 810 wide, ' +
  'so a wide, simple design works best — around 1200 × 300 pixels, solid black on a ' +
  'transparent or white background. Colour, greys and fine detail are lost on a ' +
  'thermal printer.'

async function hashBytes(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A reason this file cannot be a header image, or null if it can. */
export function headerImageProblem(file: File): string | null {
  if (!/^image\/(png|jpeg)$/.test(file.type)) return 'Please choose a PNG or JPEG image.'
  if (file.size > MAX_HEADER_BYTES) return 'That image is too large (2 MB maximum).'
  return null
}

/** Store the image and return its public URL. Throws on failure. */
export async function uploadHeaderImage(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const ext = file.type === 'image/png' ? 'png' : 'jpg'
  const path = `${await hashBytes(buf)}.${ext}`
  const up = await supabase.storage
    .from(BUCKET)
    .upload(path, buf, { contentType: file.type, upsert: true })
  if (up.error) throw up.error
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}
