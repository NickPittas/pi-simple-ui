import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

export type ContentKind = 'text' | 'code' | 'uri'
export type AttachmentCategory = 'image' | 'pdf' | 'text' | 'code'
export type AttachmentMimeType =
  | 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  | 'application/pdf' | 'text/plain' | 'text/markdown' | 'application/json' | 'text/csv'

export interface AttachmentTypeInfo {
  readonly category: AttachmentCategory
  readonly mime: AttachmentMimeType
}

/** These limits keep IPC/base64 payloads bounded below the transport's ~10 MB ceiling. */
export const CONTENT_LIMITS = Object.freeze({
  attachmentBytes: 7_500_000,
  attachmentBase64Characters: 10_000_000,
  inlineImageBytes: 1_000_000,
  inlineImageBase64Characters: 1_333_336,
  attachmentsPerMessage: 20,
  attachmentNameCharacters: 255,
  pathCharacters: 4096,
  exportNameCharacters: 128,
})

/** Extension allowlist. HTML and source files are delivered as inert text/plain content. */
export const ATTACHMENT_TYPES: Readonly<Record<string, AttachmentTypeInfo>> = Object.freeze({
  '.png': { category: 'image', mime: 'image/png' },
  '.jpg': { category: 'image', mime: 'image/jpeg' },
  '.jpeg': { category: 'image', mime: 'image/jpeg' },
  '.gif': { category: 'image', mime: 'image/gif' },
  '.webp': { category: 'image', mime: 'image/webp' },
  '.pdf': { category: 'pdf', mime: 'application/pdf' },
  '.txt': { category: 'text', mime: 'text/plain' },
  '.md': { category: 'text', mime: 'text/markdown' },
  '.json': { category: 'text', mime: 'application/json' },
  '.csv': { category: 'text', mime: 'text/csv' },
  '.c': { category: 'code', mime: 'text/plain' },
  '.h': { category: 'code', mime: 'text/plain' },
  '.cc': { category: 'code', mime: 'text/plain' },
  '.cpp': { category: 'code', mime: 'text/plain' },
  '.cxx': { category: 'code', mime: 'text/plain' },
  '.hpp': { category: 'code', mime: 'text/plain' },
  '.cs': { category: 'code', mime: 'text/plain' },
  '.css': { category: 'code', mime: 'text/plain' },
  '.ex': { category: 'code', mime: 'text/plain' },
  '.exs': { category: 'code', mime: 'text/plain' },
  '.go': { category: 'code', mime: 'text/plain' },
  '.hbs': { category: 'code', mime: 'text/plain' },
  '.hs': { category: 'code', mime: 'text/plain' },
  '.htm': { category: 'code', mime: 'text/plain' },
  '.html': { category: 'code', mime: 'text/plain' },
  '.java': { category: 'code', mime: 'text/plain' },
  '.js': { category: 'code', mime: 'text/plain' },
  '.jsx': { category: 'code', mime: 'text/plain' },
  '.kt': { category: 'code', mime: 'text/plain' },
  '.kts': { category: 'code', mime: 'text/plain' },
  '.lua': { category: 'code', mime: 'text/plain' },
  '.mjs': { category: 'code', mime: 'text/plain' },
  '.cjs': { category: 'code', mime: 'text/plain' },
  '.php': { category: 'code', mime: 'text/plain' },
  '.pl': { category: 'code', mime: 'text/plain' },
  '.ps1': { category: 'code', mime: 'text/plain' },
  '.py': { category: 'code', mime: 'text/plain' },
  '.rb': { category: 'code', mime: 'text/plain' },
  '.rs': { category: 'code', mime: 'text/plain' },
  '.scala': { category: 'code', mime: 'text/plain' },
  '.sh': { category: 'code', mime: 'text/plain' },
  '.sql': { category: 'code', mime: 'text/plain' },
  '.swift': { category: 'code', mime: 'text/plain' },
  '.toml': { category: 'code', mime: 'text/plain' },
  '.ts': { category: 'code', mime: 'text/plain' },
  '.tsx': { category: 'code', mime: 'text/plain' },
  '.xml': { category: 'code', mime: 'text/plain' },
  '.yaml': { category: 'code', mime: 'text/plain' },
  '.yml': { category: 'code', mime: 'text/plain' },
})

export interface AttachmentReadRequest {
  readonly workspacePath: string
  readonly relativeOrAbsPath: string
}

export interface AttachmentReadResponse {
  readonly name: string
  readonly mime: string
  readonly bytesBase64: string
  readonly byteLength: number
}

export interface ExportWriteRequest {
  readonly suggestedName: string
  readonly bytesBase64: string
}

export interface ExportWriteResponse {
  readonly path: string | null
}

export interface ContentCapabilityContracts {
  'files.read-attachment': {
    readonly request: AttachmentReadRequest
    readonly response: AttachmentReadResponse
  }
  'files.write-export': {
    readonly request: ExportWriteRequest
    readonly response: ExportWriteResponse
  }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends ContentCapabilityContracts {}
}

export function attachmentTypeForExtension(extension: string): AttachmentTypeInfo | null {
  const normalized = extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
  return ATTACHMENT_TYPES[normalized] ?? null
}

export function attachmentTypeForName(name: string): AttachmentTypeInfo | null {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? null : attachmentTypeForExtension(name.slice(dot))
}

function isUriCandidate(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return false
  try {
    return new URL(value).protocol.length > 1
  } catch {
    return false
  }
}

/** Classifies content only; URI candidates still require protocol validation before rendering. */
export function classifyContent(value: string, fileName?: string): ContentKind {
  if (isUriCandidate(value)) return 'uri'
  return attachmentTypeForName(fileName ?? '')?.category === 'code' ? 'code' : 'text'
}

export function isAttachmentCountWithinLimit(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 0 && count <= CONTENT_LIMITS.attachmentsPerMessage
}

export function isAttachmentSizeWithinLimit(byteLength: number): boolean {
  return Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= CONTENT_LIMITS.attachmentBytes
}

export function isAllowedAttachmentMimeType(value: unknown): value is AttachmentMimeType {
  return typeof value === 'string' && Object.values(ATTACHMENT_TYPES).some((type) => type.mime === value)
}

export function getBase64ByteLength(value: string, maxCharacters: number = CONTENT_LIMITS.attachmentBase64Characters): number | null {
  if (value.length > maxCharacters || value.length % 4 !== 0) return null
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null
  if (value.length === 0) return 0
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

export function isAllowedLinkProtocol(value: unknown): value is 'https:' | 'http:' | 'mailto:' {
  return value === 'https:' || value === 'http:' || value === 'mailto:'
}

export function isRenderableLinkUrl(value: string): boolean {
  if (value.length === 0 || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (!isAllowedLinkProtocol(url.protocol)) return false
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return url.hostname.length > 0 && !value.includes('\\')
    }
    return url.pathname.length > 0
  } catch {
    return false
  }
}

/** A bounded, base64-only raster image data URI; SVG and other active formats are excluded. */
export function isBoundedImageDataUri(value: string): boolean {
  if (value.length > CONTENT_LIMITS.inlineImageBase64Characters + 32) return false
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value)
  if (!match) return false
  const byteLength = getBase64ByteLength(match[2] ?? '', CONTENT_LIMITS.inlineImageBase64Characters)
  return byteLength !== null && byteLength > 0 && byteLength <= CONTENT_LIMITS.inlineImageBytes
}

export function isSafeAttachmentName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= CONTENT_LIMITS.attachmentNameCharacters
    && value !== '.'
    && value !== '..'
    && !/[\\/\u0000-\u001f\u007f]/.test(value)
}

export function isSafeExportName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= CONTENT_LIMITS.exportNameCharacters
    && value !== '.'
    && value !== '..'
    && !/[\\/\u0000-\u001f\u007f]/.test(value)
    && !value.endsWith('.')
}

export function isAttachmentReadRequest(value: unknown): value is AttachmentReadRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['workspacePath', 'relativeOrAbsPath'])
    && typeof value.workspacePath === 'string'
    && value.workspacePath.length > 0
    && value.workspacePath.length <= CONTENT_LIMITS.pathCharacters
    && !value.workspacePath.includes('\0')
    && typeof value.relativeOrAbsPath === 'string'
    && value.relativeOrAbsPath.length > 0
    && value.relativeOrAbsPath.length <= CONTENT_LIMITS.pathCharacters
    && !value.relativeOrAbsPath.includes('\0')
}

export function isAttachmentReadResponse(value: unknown): value is AttachmentReadResponse {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['name', 'mime', 'bytesBase64', 'byteLength'])) return false
  if (!isSafeAttachmentName(value.name)
    || !isAllowedAttachmentMimeType(value.mime)
    || typeof value.bytesBase64 !== 'string'
    || !Number.isSafeInteger(value.byteLength)
    || (value.byteLength as number) < 0
    || (value.byteLength as number) > CONTENT_LIMITS.attachmentBytes) return false
  const base64Length = getBase64ByteLength(value.bytesBase64)
  return base64Length !== null
    && base64Length === value.byteLength
    && base64Length <= CONTENT_LIMITS.attachmentBytes
}

export function isExportWriteRequest(value: unknown): value is ExportWriteRequest {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['suggestedName', 'bytesBase64'])) return false
  if (!isSafeExportName(value.suggestedName) || typeof value.bytesBase64 !== 'string') return false
  const byteLength = getBase64ByteLength(value.bytesBase64)
  return byteLength !== null && byteLength <= CONTENT_LIMITS.attachmentBytes
}

export function isExportWriteResponse(value: unknown): value is ExportWriteResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['path'])
    && (value.path === null
      || (typeof value.path === 'string'
        && value.path.length > 0
        && value.path.length <= CONTENT_LIMITS.pathCharacters
        && !value.path.includes('\0')))
}
