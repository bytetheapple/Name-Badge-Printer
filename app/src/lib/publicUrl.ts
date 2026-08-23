/**
 * Where the public sign-in pages live.
 *
 * The lobby QR codes encode this host and are physically printed, so changing
 * it means reprinting them. Keeping it in one place means the move to a product
 * domain is a single edit plus a redirect for anything already in the wild.
 *
 * Set VITE_PUBLIC_BASE_URL to override; otherwise the admin's own origin is
 * used, which is right for both local development and the current deployment.
 */
const configured = import.meta.env.VITE_PUBLIC_BASE_URL as string | undefined

export const publicBaseUrl = (configured?.replace(/\/+$/, '') || window.location.origin)

/** The URL a printer's QR code should encode. */
export const kioskUrl = (kioskToken: string) => `${publicBaseUrl}/k/${kioskToken}`
