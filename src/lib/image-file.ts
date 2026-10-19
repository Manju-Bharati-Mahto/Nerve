/* ── Image checks, before anything is sent ─────────────────────────────────
   One copy of the rule every image picker applies, mirroring the server's
   (server/upload-guard.ts: SAFE_IMAGE_EXT, isHeic, HEIC_MESSAGE). The server
   still enforces it; checking here first means a person learns which file is
   wrong while the dialog is open, rather than after the upload. Keep the two
   in step: a type accepted here but refused there reads as a server error. */

/**
 * The `accept` for image inputs. Listing the types, rather than image/*, is
 * what makes iOS Safari convert an iPhone's HEIC photo to JPEG as it is
 * picked — with image/* it sends the HEIC, which the server refuses.
 */
export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif'

/** Same words as the server's refusal. */
export const HEIC_MESSAGE =
  'iPhone HEIC photos are not supported. Choose JPG or PNG (on iPhone: Settings → Camera → Formats → Most Compatible).'

export const IMAGE_TYPE_MESSAGE = 'Only JPG, PNG, WEBP or GIF images are allowed.'

/* The server's SAFE_IMAGE_EXT keys. image/jpg and image/pjpeg are not real
   types, but some Android galleries and older Windows browsers send them for
   an ordinary JPEG. */
const SAFE_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/gif'])

/** By type or by name: several browsers send HEIC as application/octet-stream or with no type. */
export function isHeicFile(file: { type: string; name: string }): boolean {
  return /^image\/hei[cf](-sequence)?$/i.test(file.type) || /\.hei[cf]$/i.test(file.name)
}

/** "10 MB", "3 MB", "512 KB" — the limit as a person reads it. */
export function sizeLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

/** Why this image cannot be uploaded, or null when it can. */
export function checkImageFile(file: { type: string; name: string; size: number }, maxBytes: number): string | null {
  if (isHeicFile(file)) return HEIC_MESSAGE
  if (!SAFE_IMAGE_TYPES.has(file.type)) return IMAGE_TYPE_MESSAGE
  if (file.size > maxBytes) return `That image is larger than ${sizeLabel(maxBytes)}.`
  return null
}
