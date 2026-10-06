import { Buffer } from 'node:buffer'
import {
  attachmentTypeForExtension,
  attachmentTypeForName,
  classifyContent,
  CONTENT_LIMITS,
  getBase64ByteLength,
  isAllowedAttachmentMimeType,
  isAllowedLinkProtocol,
  isAttachmentCountWithinLimit,
  isAttachmentSizeWithinLimit,
  isBoundedImageDataUri,
  isRenderableLinkUrl,
  type AttachmentCategory,
  type ContentKind,
} from '../../shared/content.ts'

export {
  attachmentTypeForExtension,
  attachmentTypeForName,
  classifyContent,
  CONTENT_LIMITS,
  getBase64ByteLength,
  isAllowedAttachmentMimeType,
  isAllowedLinkProtocol,
  isAttachmentCountWithinLimit,
  isAttachmentSizeWithinLimit,
  isRenderableLinkUrl,
}
export type { AttachmentCategory, ContentKind }

/** Main-process counterpart that also verifies the embedded raster's magic bytes. */
export function isAllowedInlineImageDataUri(value: string): boolean {
  if (!isBoundedImageDataUri(value)) return false
  const comma = value.indexOf(',')
  const metadata = value.slice(0, comma).toLowerCase()
  const declaredMime = metadata === 'data:image/png;base64' ? 'image/png'
    : metadata === 'data:image/jpeg;base64' ? 'image/jpeg'
      : metadata === 'data:image/gif;base64' ? 'image/gif'
        : metadata === 'data:image/webp;base64' ? 'image/webp' : null
  if (!declaredMime) return false

  const bytes = Buffer.from(value.slice(comma + 1), 'base64')
  return sniffRasterMime(bytes) === declaredMime
}

/** Allowlisted attachment extension lookup, intentionally independent of file I/O. */
export function isAllowedAttachmentExtension(extension: string): boolean {
  return attachmentTypeForExtension(extension) !== null
}

/** Text attachment bytes must be valid UTF-8 and contain no NUL bytes before display. */
export function isSafeTextAttachmentBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength > CONTENT_LIMITS.attachmentBytes) return false
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return !decoded.includes('\0')
  } catch {
    return false
  }
}

/** Sniff only the passive formats permitted for inline attachment display. */
export function sniffAttachmentMime(bytes: Uint8Array): string | null {
  return sniffRasterMime(bytes) ?? (hasPdfHeader(bytes) ? 'application/pdf' : null)
}

function sniffRasterMime(bytes: Uint8Array): string | null {
  if (bytes.byteLength >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.byteLength >= 6) {
    const signature = String.fromCharCode(...bytes.subarray(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (bytes.byteLength >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44
    && bytes[3] === 0x46 && bytes[4] === 0x2d
}
