import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

export const TRANSFER_IPC = Object.freeze({
  export: 'transfer.export',
  exportConfirm: 'transfer.export.confirm',
  import: 'transfer.import',
  sharePrepare: 'transfer.share.prepare',
  shareConfirm: 'transfer.share.confirm',
  shareCancel: 'transfer.share.cancel',
  shareEvents: 'transfer.share.events',
})

export type TransferExportFormat = 'html' | 'jsonl'

export interface TransferEmptyRequest {}

export interface TransferExportRequest {
  readonly format: TransferExportFormat
}

export interface TransferExportConfirmRequest {
  readonly preparationId: string
  readonly confirmed: boolean
  readonly overwriteConfirmed: boolean
}

export interface TransferImportRequest {}

export interface TransferShareConfirmRequest {
  readonly preparationId: string
  readonly confirmed: boolean
}

export interface TransferShareCancelRequest {
  readonly preparationId: string
}

export interface TransferShareDestinationDisclosure {
  readonly destination: 'radius-organization' | 'github-private-gist'
  readonly visibility: 'organization' | 'unlisted'
  readonly access: 'organization-members' | 'anyone-with-url'
  readonly condition: 'radius-provider-authenticated' | 'radius-provider-absent-or-no-credential'
  readonly requires: 'radius-authentication' | 'github-cli-authentication'
  readonly fallback: 'none-after-radius-auth-or-upload-error' | 'only-before-radius-upload'
}

export type TransferShareDestination = 'radius-organization' | 'github-private-gist'

export type TransferShareProgressPhase =
  | 'exporting-jsonl'
  | 'checking-radius-auth'
  | 'uploading-radius'
  | 'checking-github-auth'
  | 'exporting-html'
  | 'creating-gist'

export interface TransferShareProgress {
  readonly phase: TransferShareProgressPhase
}

/** Progress is identified by the one-use share preparation and never contains URLs or auth data. */
export type TransferShareEventPayload =
  | {
      readonly type: 'share-progress'
      readonly operationId: string
      readonly phase: TransferShareProgressPhase
    }
  | {
      readonly type: 'share-terminal'
      readonly operationId: string
      readonly outcome: 'shared' | 'cancelled' | 'failed'
    }

export type TransferShareOperationOutcome =
  | {
      readonly status: 'shared'
      readonly destination: 'radius-organization'
      readonly url: string
    }
  | {
      readonly status: 'shared'
      readonly destination: 'github-private-gist'
      readonly url: string
      readonly gistUrl: string
    }
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'failed'
      readonly phase: TransferShareProgressPhase
      readonly message: string
    }

export interface TransferMessageCounts {
  readonly total: number
  readonly user: number
  readonly assistant: number
  readonly tool: number
  readonly other: number
}

export interface TransferAttachmentReference {
  /** Zero-based index among transcript message entries. */
  readonly messageIndex: number
  readonly contentIndex: number
  readonly type: 'image'
  readonly mimeType: string
  readonly reference: string
}

export interface TransferSecretScanSummary {
  readonly version: 'bounded-v1'
  readonly messageCount: number
  readonly scannedMessageCount: number
  readonly unscannedMessageCount: number
  readonly truncatedTextCount: number
  readonly apiKeyMatches: number
  readonly tokenMatches: number
  readonly privateKeyMatches: number
  readonly affectedMessageIndices: readonly number[]
  readonly additionalAffectedMessageCount: number
  readonly systemPromptMatches: number
  readonly toolSchemaMatches: number
  readonly entryMetadataMatches: number
}

export interface TransferConsentPayload {
  readonly sessionId: string
  readonly messageCounts: TransferMessageCounts
  readonly attachmentReferences: readonly TransferAttachmentReference[]
  readonly attachmentReferenceCount: number
  readonly omittedAttachmentReferenceCount: number
  readonly secretScan: TransferSecretScanSummary
}

export type TransferExportResponse =
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'prepared'
      readonly preparationId: string
      readonly format: TransferExportFormat
      readonly targetPath: string
      readonly overwriteRequired: boolean
      readonly consent: TransferConsentPayload
    }
  | {
      readonly status: 'failed'
      readonly error: 'dialog-unavailable' | 'invalid-destination' | 'runtime-unavailable' | 'session-busy'
    }

export type TransferExportConfirmResponse =
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'overwrite-required'
      readonly preparationId: string
      readonly targetPath: string
      readonly consent: TransferConsentPayload
    }
  | { readonly status: 'exported'; readonly format: TransferExportFormat; readonly targetPath: string }
  | {
      readonly status: 'failed'
      readonly error: 'preparation-expired' | 'runtime-unavailable' | 'export-failed' | 'session-changed'
    }

export type TransferImportResponse =
  | { readonly status: 'cancelled' }
  | { readonly status: 'imported'; readonly sessionId: string }
  | { readonly status: 'invalid'; readonly error: 'invalid-jsonl' | 'invalid-session' | 'file-too-large' }
  | { readonly status: 'failed'; readonly error: 'dialog-unavailable' | 'runtime-unavailable' | 'import-failed' }

export interface TransferSharePrepareRequest {}

export type TransferSharePrepareResponse =
  | {
      readonly status: 'prepared'
      readonly preparationId: string
      readonly shareAvailable: boolean
      readonly destinations: readonly TransferShareDestinationDisclosure[]
      readonly seam?: 'native-share-operation-not-injected'
      readonly consent: TransferConsentPayload
    }
  | { readonly status: 'failed'; readonly error: 'runtime-unavailable' | 'session-busy' }

export type TransferShareConfirmResponse =
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'shared'
      readonly destination: 'radius-organization'
      readonly url: string
    }
  | {
      readonly status: 'shared'
      readonly destination: 'github-private-gist'
      readonly url: string
      readonly gistUrl: string
    }
  | {
      readonly status: 'unavailable'
      readonly seam: 'native-share-operation-not-injected'
    }
  | {
      readonly status: 'failed'
      readonly error: 'preparation-expired' | 'runtime-unavailable' | 'session-changed' | 'share-failed'
      readonly phase?: TransferShareProgressPhase
      readonly message?: string
    }

export type TransferShareCancelResponse =
  | { readonly status: 'cancellation-requested' }
  | { readonly status: 'failed'; readonly error: 'share-not-active' | 'runtime-unavailable' }

export interface TransferCapabilityContracts {
  'transfer.export': { readonly request: TransferExportRequest; readonly response: TransferExportResponse }
  'transfer.export.confirm': {
    readonly request: TransferExportConfirmRequest
    readonly response: TransferExportConfirmResponse
  }
  'transfer.import': { readonly request: TransferImportRequest; readonly response: TransferImportResponse }
  'transfer.share.prepare': {
    readonly request: TransferSharePrepareRequest
    readonly response: TransferSharePrepareResponse
  }
  'transfer.share.confirm': {
    readonly request: TransferShareConfirmRequest
    readonly response: TransferShareConfirmResponse
  }
  'transfer.share.cancel': {
    readonly request: TransferShareCancelRequest
    readonly response: TransferShareCancelResponse
  }
}

export interface TransferEventContracts {
  'transfer.share.events': { readonly payload: TransferShareEventPayload }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends TransferCapabilityContracts {}
  interface IpcEventContracts extends TransferEventContracts {}
}

const TRANSFER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[4-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isTransferEmptyRequest(value: unknown): value is TransferEmptyRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

export function isTransferExportRequest(value: unknown): value is TransferExportRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['format'])
    && (value.format === 'html' || value.format === 'jsonl')
}

export function isTransferExportConfirmRequest(value: unknown): value is TransferExportConfirmRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['preparationId', 'confirmed', 'overwriteConfirmed'])
    && typeof value.preparationId === 'string'
    && TRANSFER_ID_PATTERN.test(value.preparationId)
    && typeof value.confirmed === 'boolean'
    && typeof value.overwriteConfirmed === 'boolean'
}

export function isTransferShareConfirmRequest(value: unknown): value is TransferShareConfirmRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['preparationId', 'confirmed'])
    && typeof value.preparationId === 'string'
    && TRANSFER_ID_PATTERN.test(value.preparationId)
    && typeof value.confirmed === 'boolean'
}

export function isTransferShareCancelRequest(value: unknown): value is TransferShareCancelRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['preparationId'])
    && typeof value.preparationId === 'string'
    && TRANSFER_ID_PATTERN.test(value.preparationId)
}

function isTransferShareProgressPhase(value: unknown): value is TransferShareProgressPhase {
  return value === 'exporting-jsonl'
    || value === 'checking-radius-auth'
    || value === 'uploading-radius'
    || value === 'checking-github-auth'
    || value === 'exporting-html'
    || value === 'creating-gist'
}

export function isTransferShareEventPayload(value: unknown): value is TransferShareEventPayload {
  if (!isPlainRecord(value) || typeof value.operationId !== 'string' || !TRANSFER_ID_PATTERN.test(value.operationId)) return false
  if (value.type === 'share-progress') {
    return hasExactKeys(value, ['type', 'operationId', 'phase']) && isTransferShareProgressPhase(value.phase)
  }
  return value.type === 'share-terminal'
    && hasExactKeys(value, ['type', 'operationId', 'outcome'])
    && (value.outcome === 'shared' || value.outcome === 'cancelled' || value.outcome === 'failed')
}

function isMessageCounts(value: unknown): value is TransferMessageCounts {
  return isPlainRecord(value)
    && hasExactKeys(value, ['total', 'user', 'assistant', 'tool', 'other'])
    && Object.values(value).every((item) => Number.isSafeInteger(item) && (item as number) >= 0)
}

function isAttachmentReference(value: unknown): value is TransferAttachmentReference {
  return isPlainRecord(value)
    && hasExactKeys(value, ['messageIndex', 'contentIndex', 'type', 'mimeType', 'reference'])
    && Number.isSafeInteger(value.messageIndex)
    && (value.messageIndex as number) >= 0
    && Number.isSafeInteger(value.contentIndex)
    && (value.contentIndex as number) >= 0
    && value.type === 'image'
    && typeof value.mimeType === 'string'
    && value.mimeType.length <= 128
    && typeof value.reference === 'string'
    && value.reference.length <= 128
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isSecretScanSummary(value: unknown): value is TransferSecretScanSummary {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, [
      'version', 'messageCount', 'scannedMessageCount', 'unscannedMessageCount', 'truncatedTextCount',
      'apiKeyMatches', 'tokenMatches', 'privateKeyMatches', 'affectedMessageIndices',
      'additionalAffectedMessageCount', 'systemPromptMatches', 'toolSchemaMatches', 'entryMetadataMatches',
    ])) return false
  const counts = [
    value.messageCount,
    value.scannedMessageCount,
    value.unscannedMessageCount,
    value.truncatedTextCount,
    value.apiKeyMatches,
    value.tokenMatches,
    value.privateKeyMatches,
    value.additionalAffectedMessageCount,
    value.systemPromptMatches,
    value.toolSchemaMatches,
    value.entryMetadataMatches,
  ]
  return value.version === 'bounded-v1'
    && counts.every((item) => Number.isSafeInteger(item) && (item as number) >= 0)
    && Array.isArray(value.affectedMessageIndices)
    && value.affectedMessageIndices.length <= 100
    && value.affectedMessageIndices.every((item) => Number.isSafeInteger(item) && (item as number) >= 0)
}

export function isTransferConsentPayload(value: unknown): value is TransferConsentPayload {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      'sessionId', 'messageCounts', 'attachmentReferences', 'attachmentReferenceCount',
      'omittedAttachmentReferenceCount', 'secretScan',
    ])
    && typeof value.sessionId === 'string'
    && value.sessionId.length > 0
    && value.sessionId.length <= 128
    && isMessageCounts(value.messageCounts)
    && Array.isArray(value.attachmentReferences)
    && value.attachmentReferences.length <= 200
    && value.attachmentReferences.every(isAttachmentReference)
    && isNonNegativeSafeInteger(value.attachmentReferenceCount)
    && value.attachmentReferenceCount >= value.attachmentReferences.length
    && isNonNegativeSafeInteger(value.omittedAttachmentReferenceCount)
    && value.attachmentReferenceCount
      === value.attachmentReferences.length + value.omittedAttachmentReferenceCount
    && isSecretScanSummary(value.secretScan)
}

function isTransferExportResponse(value: unknown): value is TransferExportResponse {
  if (!isPlainRecord(value) || typeof value.status !== 'string') return false
  if (value.status === 'cancelled') return hasExactKeys(value, ['status'])
  if (value.status === 'failed') {
    return hasExactKeys(value, ['status', 'error'])
      && ['dialog-unavailable', 'invalid-destination', 'runtime-unavailable', 'session-busy'].includes(String(value.error))
  }
  return value.status === 'prepared'
    && hasExactKeys(value, ['status', 'preparationId', 'format', 'targetPath', 'overwriteRequired', 'consent'])
    && typeof value.preparationId === 'string'
    && TRANSFER_ID_PATTERN.test(value.preparationId)
    && (value.format === 'html' || value.format === 'jsonl')
    && typeof value.targetPath === 'string'
    && value.targetPath.length > 0
    && value.targetPath.length <= 4096
    && typeof value.overwriteRequired === 'boolean'
    && isTransferConsentPayload(value.consent)
}

function isTransferExportConfirmResponse(value: unknown): value is TransferExportConfirmResponse {
  if (!isPlainRecord(value) || typeof value.status !== 'string') return false
  if (value.status === 'cancelled') return hasExactKeys(value, ['status'])
  if (value.status === 'failed') {
    return hasExactKeys(value, ['status', 'error'])
      && ['preparation-expired', 'runtime-unavailable', 'export-failed', 'session-changed'].includes(String(value.error))
  }
  if (value.status === 'exported') {
    return hasExactKeys(value, ['status', 'format', 'targetPath'])
      && (value.format === 'html' || value.format === 'jsonl')
      && typeof value.targetPath === 'string'
      && value.targetPath.length <= 4096
  }
  return value.status === 'overwrite-required'
    && hasExactKeys(value, ['status', 'preparationId', 'targetPath', 'consent'])
    && typeof value.preparationId === 'string'
    && TRANSFER_ID_PATTERN.test(value.preparationId)
    && typeof value.targetPath === 'string'
    && value.targetPath.length <= 4096
    && isTransferConsentPayload(value.consent)
}

function isTransferImportResponse(value: unknown): value is TransferImportResponse {
  if (!isPlainRecord(value) || typeof value.status !== 'string') return false
  if (value.status === 'cancelled') return hasExactKeys(value, ['status'])
  if (value.status === 'imported') {
    return hasExactKeys(value, ['status', 'sessionId'])
      && typeof value.sessionId === 'string'
      && value.sessionId.length > 0
      && value.sessionId.length <= 128
  }
  if (value.status === 'invalid') {
    return hasExactKeys(value, ['status', 'error'])
      && ['invalid-jsonl', 'invalid-session', 'file-too-large'].includes(String(value.error))
  }
  return value.status === 'failed'
    && hasExactKeys(value, ['status', 'error'])
    && ['dialog-unavailable', 'runtime-unavailable', 'import-failed'].includes(String(value.error))
}

function isShareDestinationDisclosure(value: unknown): value is TransferShareDestinationDisclosure {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['destination', 'visibility', 'access', 'condition', 'requires', 'fallback'])) return false
  if (value.destination === 'radius-organization') {
    return value.visibility === 'organization'
      && value.access === 'organization-members'
      && value.condition === 'radius-provider-authenticated'
      && value.requires === 'radius-authentication'
      && value.fallback === 'none-after-radius-auth-or-upload-error'
  }
  return value.destination === 'github-private-gist'
    && value.visibility === 'unlisted'
    && value.access === 'anyone-with-url'
    && value.condition === 'radius-provider-absent-or-no-credential'
    && value.requires === 'github-cli-authentication'
    && value.fallback === 'only-before-radius-upload'
}

function isTransferSharePrepareResponse(value: unknown): value is TransferSharePrepareResponse {
  if (!isPlainRecord(value) || typeof value.status !== 'string') return false
  if (value.status === 'failed') {
    return hasExactKeys(value, ['status', 'error'])
      && (value.error === 'runtime-unavailable' || value.error === 'session-busy')
  }
  const keys = Object.hasOwn(value, 'seam')
    ? ['status', 'preparationId', 'shareAvailable', 'destinations', 'seam', 'consent']
    : ['status', 'preparationId', 'shareAvailable', 'destinations', 'consent']
  return value.status === 'prepared'
    && hasExactKeys(value, keys)
    && typeof value.preparationId === 'string'
    && TRANSFER_ID_PATTERN.test(value.preparationId)
    && typeof value.shareAvailable === 'boolean'
    && Array.isArray(value.destinations)
    && value.destinations.length === 2
    && value.destinations.every(isShareDestinationDisclosure)
    && value.destinations.some((entry) => entry.destination === 'radius-organization')
    && value.destinations.some((entry) => entry.destination === 'github-private-gist')
    && (value.shareAvailable
      ? !Object.hasOwn(value, 'seam')
      : value.seam === 'native-share-operation-not-injected')
    && isTransferConsentPayload(value.consent)
}

function isTransferShareConfirmResponse(value: unknown): value is TransferShareConfirmResponse {
  if (!isPlainRecord(value) || typeof value.status !== 'string') return false
  if (value.status === 'cancelled') return hasExactKeys(value, ['status'])
  if (value.status === 'shared') {
    if (value.destination === 'radius-organization') {
      return hasExactKeys(value, ['status', 'destination', 'url'])
        && typeof value.url === 'string'
        && value.url.length > 0
        && value.url.length <= 2048
    }
    return value.destination === 'github-private-gist'
      && hasExactKeys(value, ['status', 'destination', 'url', 'gistUrl'])
      && typeof value.url === 'string'
      && value.url.length > 0
      && value.url.length <= 2048
      && typeof value.gistUrl === 'string'
      && value.gistUrl.length > 0
      && value.gistUrl.length <= 2048
  }
  if (value.status === 'failed') {
    if (value.error !== 'share-failed') {
      return hasExactKeys(value, ['status', 'error'])
        && ['preparation-expired', 'runtime-unavailable', 'session-changed'].includes(String(value.error))
    }
    const keys = [
      'status', 'error',
      ...(Object.hasOwn(value, 'phase') ? ['phase'] : []),
      ...(Object.hasOwn(value, 'message') ? ['message'] : []),
    ]
    return hasExactKeys(value, keys)
      && (!Object.hasOwn(value, 'phase') || [
        'exporting-jsonl', 'checking-radius-auth', 'uploading-radius',
        'checking-github-auth', 'exporting-html', 'creating-gist',
      ].includes(String(value.phase)))
      && (!Object.hasOwn(value, 'message') || typeof value.message === 'string' && value.message.length <= 512)
  }
  return value.status === 'unavailable'
    && hasExactKeys(value, ['status', 'seam'])
    && value.seam === 'native-share-operation-not-injected'
}

function isTransferShareCancelResponse(value: unknown): value is TransferShareCancelResponse {
  if (!isPlainRecord(value) || typeof value.status !== 'string') return false
  if (value.status === 'cancellation-requested') return hasExactKeys(value, ['status'])
  return value.status === 'failed'
    && hasExactKeys(value, ['status', 'error'])
    && (value.error === 'share-not-active' || value.error === 'runtime-unavailable')
}

export const transferValidators = Object.freeze({
  exportRequest: isTransferExportRequest,
  exportResponse: isTransferExportResponse,
  exportConfirmRequest: isTransferExportConfirmRequest,
  exportConfirmResponse: isTransferExportConfirmResponse,
  importRequest: isTransferEmptyRequest,
  importResponse: isTransferImportResponse,
  sharePrepareRequest: isTransferEmptyRequest,
  sharePrepareResponse: isTransferSharePrepareResponse,
  shareConfirmRequest: isTransferShareConfirmRequest,
  shareConfirmResponse: isTransferShareConfirmResponse,
  shareCancelRequest: isTransferShareCancelRequest,
  shareCancelResponse: isTransferShareCancelResponse,
})
