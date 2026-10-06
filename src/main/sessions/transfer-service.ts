import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type {
  AgentSession,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import type {
  BrowserWindow,
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from 'electron'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import {
  isTransferShareEventPayload,
  type TransferAttachmentReference,
  type TransferConsentPayload,
  type TransferExportConfirmRequest,
  type TransferExportConfirmResponse,
  type TransferExportFormat,
  type TransferExportRequest,
  type TransferExportResponse,
  type TransferImportResponse,
  type TransferMessageCounts,
  type TransferSecretScanSummary,
  type TransferShareCancelRequest,
  type TransferShareCancelResponse,
  type TransferShareConfirmRequest,
  type TransferShareConfirmResponse,
  type TransferShareEventPayload,
  type TransferShareOperationOutcome,
  type TransferShareProgress,
  type TransferSharePrepareResponse,
} from '../../shared/transfer.ts'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'
import { inspectNativeSessionFile } from './session-store.ts'

const MAX_PATH_LENGTH = 4096
const MAX_IMPORT_BYTES = 128 * 1024 * 1024
const PREPARATION_TTL_MS = 5 * 60 * 1000
const MAX_PENDING_PREPARATIONS = 64
const MAX_SCANNED_MESSAGES = 2000
const MAX_SCAN_CHARACTERS = 4 * 1024 * 1024
const MAX_SCAN_STRING_CHARACTERS = 64 * 1024
const MAX_ATTACHMENT_REFERENCES = 200
const MAX_AFFECTED_MESSAGE_INDICES = 100
const MAX_SECRET_FINDINGS = 20_000

export interface TransferRuntimeAccess {
  readonly session: AgentSession
  readonly cwd: string
  /** Must route through the host's serialized session lifecycle operation. */
  readonly importFromJsonl: (path: string, cwdOverride: string) => Promise<{ readonly cancelled: boolean }>
}

export interface TransferServiceOptions {
  readonly getRuntime: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => TransferRuntimeAccess | undefined
  readonly isRuntimeScopeCurrent: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => boolean
  readonly getWindow: (caller: AuthorizedIpcCaller) => BrowserWindow | null
  readonly isCallerActive: (caller: AuthorizedIpcCaller) => boolean
  readonly showSaveDialog: (
    window: BrowserWindow,
    options: SaveDialogOptions,
  ) => Promise<SaveDialogReturnValue>
  readonly showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions,
  ) => Promise<OpenDialogReturnValue>
  readonly shareOperation?: NativeSessionShareOperation
}

/** Typed injection seam for the public SDK session-share operation. */
export interface NativeSessionShareOperation {
  run(
    session: AgentSession,
    options: {
      readonly signal: AbortSignal
      readonly onProgress: (progress: TransferShareProgress) => void
    },
  ): Promise<TransferShareOperationOutcome>
}

const SHARE_DESTINATIONS = Object.freeze([
  {
    destination: 'radius-organization',
    visibility: 'organization',
    access: 'organization-members',
    condition: 'radius-provider-authenticated',
    requires: 'radius-authentication',
    fallback: 'none-after-radius-auth-or-upload-error',
  },
  {
    destination: 'github-private-gist',
    visibility: 'unlisted',
    access: 'anyone-with-url',
    condition: 'radius-provider-absent-or-no-credential',
    requires: 'github-cli-authentication',
    fallback: 'only-before-radius-upload',
  },
] as const)

interface CallerSnapshot {
  readonly windowId: number
  readonly webContentsId: number
  readonly frameUrl: string
}

interface ScopeSnapshot {
  readonly ownerId: string
  readonly generation: number
}

interface PendingBase {
  readonly id: string
  readonly caller: CallerSnapshot
  readonly scope: ScopeSnapshot
  readonly session: AgentSession
  readonly sessionId: string
  readonly revision: string
  readonly expiresAt: number
}

interface PendingExport extends PendingBase {
  readonly kind: 'export'
  readonly format: TransferExportFormat
  readonly targetPath: string
  readonly consent: TransferConsentPayload
}

interface PendingShare extends PendingBase {
  readonly kind: 'share'
  readonly consent: TransferConsentPayload
}

interface ActiveShare {
  readonly operationId: string
  readonly caller: CallerSnapshot
  readonly scope: ScopeSnapshot
  readonly session: AgentSession
  readonly sessionId: string
  readonly controller: AbortController
  terminalEmitted: boolean
}

interface ShareEventSubscriber {
  readonly caller: CallerSnapshot
  readonly scope: ScopeSnapshot
  readonly runtime: TransferRuntimeAccess
  readonly sessionId: string
  readonly publish: (event: TransferShareEventPayload) => void
}

type PendingPreparation = PendingExport | PendingShare

interface ScanCounts {
  apiKey: number
  token: number
  privateKey: number
  total: number
  systemPrompt: number
  toolSchema: number
  entryMetadata: number
  truncatedText: number
  remainingCharacters: number
  scannedMessages: number
  affectedMessages: Set<number>
}

const SECRET_PATTERNS = Object.freeze([
  { category: 'apiKey' as const, source: String.raw`\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b`, flags: 'g' },
  { category: 'apiKey' as const, source: String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b`, flags: 'g' },
  { category: 'apiKey' as const, source: String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b`, flags: 'g' },
  { category: 'apiKey' as const, source: String.raw`\bglpat-[A-Za-z0-9_-]{20,}\b`, flags: 'g' },
  { category: 'apiKey' as const, source: String.raw`\bAIza[0-9A-Za-z_-]{35}\b`, flags: 'g' },
  { category: 'token' as const, source: String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}\b`, flags: 'g' },
  { category: 'token' as const, source: String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`, flags: 'g' },
  { category: 'apiKey' as const, source: String.raw`\bAKIA[0-9A-Z]{16}\b`, flags: 'g' },
  { category: 'token' as const, source: String.raw`\bBearer\s+[A-Za-z0-9._~+/=-]{12,}`, flags: 'gi' },
  { category: 'token' as const, source: String.raw`\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*[^\s,;"']{12,}`, flags: 'gi' },
  { category: 'privateKey' as const, source: String.raw`-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----`, flags: 'g' },
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameCaller(left: CallerSnapshot, right: AuthorizedIpcCaller): boolean {
  return left.windowId === right.windowId
    && left.webContentsId === right.webContentsId
    && left.frameUrl === right.frameUrl
}

function sameScope(left: ScopeSnapshot, right: RuntimeScope): boolean {
  return left.ownerId === right.ownerId && left.generation === right.generation
}

function callerSnapshot(caller: AuthorizedIpcCaller): CallerSnapshot {
  return Object.freeze({
    windowId: caller.windowId,
    webContentsId: caller.webContentsId,
    frameUrl: caller.frameUrl,
  })
}

function scopeSnapshot(scope: RuntimeScope): ScopeSnapshot {
  return Object.freeze({ ownerId: scope.ownerId, generation: scope.generation })
}

function isActiveWindow(window: BrowserWindow | null, caller: AuthorizedIpcCaller): window is BrowserWindow {
  try {
    return !!window
      && !window.isDestroyed()
      && window.id === caller.windowId
      && window.webContents.id === caller.webContentsId
      && !window.webContents.isDestroyed()
  } catch {
    return false
  }
}

async function selectedExportPath(path: string): Promise<{ readonly path: string; readonly exists: boolean } | null> {
  if (!path || path.length > MAX_PATH_LENGTH || path.includes('\0') || !isAbsolute(path)) return null
  try {
    const absolute = resolve(path)
    const name = basename(absolute)
    if (!name || name === '.' || name === '..') return null
    const parent = await realpath(dirname(absolute))
    if (!(await stat(parent)).isDirectory()) return null
    const target = join(parent, name)
    if (target.length > MAX_PATH_LENGTH) return null
    try {
      const targetStat = await lstat(target)
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) return null
      return { path: target, exists: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      return { path: target, exists: false }
    }
  } catch {
    return null
  }
}

async function selectedImportPath(path: string): Promise<string | null> {
  if (!path || path.length > MAX_PATH_LENGTH || path.includes('\0') || !isAbsolute(path)) return null
  try {
    const inputStat = await lstat(path)
    if (inputStat.isSymbolicLink() || !inputStat.isFile()) return null
    const canonical = await realpath(path)
    if (canonical.length > MAX_PATH_LENGTH || !canonical.toLowerCase().endsWith('.jsonl')) return null
    return canonical
  } catch {
    return null
  }
}

function messageContent(entry: SessionEntry): { readonly content: unknown; readonly role: string } | undefined {
  if (entry.type === 'message') {
    const message = entry.message as unknown
    if (!isRecord(message)) return undefined
    return { content: message.content, role: typeof message.role === 'string' ? message.role : 'other' }
  }
  if (entry.type === 'custom_message') return { content: entry.content, role: 'other' }
  return undefined
}

function countMessages(entries: readonly SessionEntry[]): TransferMessageCounts {
  const counts = { total: 0, user: 0, assistant: 0, tool: 0, other: 0 }
  for (const entry of entries) {
    const message = messageContent(entry)
    if (!message) continue
    counts.total += 1
    if (message.role === 'user') counts.user += 1
    else if (message.role === 'assistant') counts.assistant += 1
    else if (message.role === 'toolResult') counts.tool += 1
    else counts.other += 1
  }
  return counts
}

function collectAttachmentReferences(entries: readonly SessionEntry[]): {
  readonly references: readonly TransferAttachmentReference[]
  readonly total: number
} {
  const references: TransferAttachmentReference[] = []
  let total = 0
  let messageIndex = 0
  for (const entry of entries) {
    const message = messageContent(entry)
    if (!message) continue
    if (Array.isArray(message.content)) {
      for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
        const part = message.content[contentIndex]
        if (!isRecord(part) || part.type !== 'image') continue
        total += 1
        if (references.length < MAX_ATTACHMENT_REFERENCES) {
          const mimeType = typeof part.mimeType === 'string' ? part.mimeType.slice(0, 128) : 'application/octet-stream'
          references.push({
            messageIndex,
            contentIndex,
            type: 'image',
            mimeType,
            reference: `${messageIndex}:${contentIndex}`,
          })
        }
      }
    }
    messageIndex += 1
  }
  return { references, total }
}

function scanString(
  value: string,
  messageIndex: number | null,
  counts: ScanCounts,
  metadata?: 'system' | 'tool' | 'entry',
): void {
  if (counts.total >= MAX_SECRET_FINDINGS) {
    counts.truncatedText += 1
    return
  }
  if (counts.remainingCharacters <= 0) {
    counts.truncatedText += 1
    return
  }
  const scanLength = Math.min(value.length, MAX_SCAN_STRING_CHARACTERS, counts.remainingCharacters)
  const candidate = value.slice(0, scanLength)
  counts.remainingCharacters -= scanLength
  if (scanLength < value.length) counts.truncatedText += 1
  for (const rule of SECRET_PATTERNS) {
    if (counts.total >= MAX_SECRET_FINDINGS) {
      counts.truncatedText += 1
      break
    }
    const matcher = new RegExp(rule.source, rule.flags)
    let count = 0
    const remainingFindingBudget = MAX_SECRET_FINDINGS - counts.total
    for (const match of candidate.matchAll(matcher)) {
      // Do not retain or serialize matched text; only count its category and location.
      void match.index
      count += 1
      if (count >= remainingFindingBudget) break
    }
    if (count === 0) continue
    counts[rule.category] += count
    counts.total += count
    if (messageIndex !== null) counts.affectedMessages.add(messageIndex)
    if (metadata === 'system') counts.systemPrompt += count
    if (metadata === 'tool') counts.toolSchema += count
    if (metadata === 'entry') counts.entryMetadata += count
    if (counts.total >= MAX_SECRET_FINDINGS) counts.truncatedText += 1
  }
}

function scanValue(
  value: unknown,
  messageIndex: number | null,
  counts: ScanCounts,
  metadata?: 'system' | 'tool' | 'entry',
  depth = 0,
): void {
  if (typeof value === 'string') {
    scanString(value, messageIndex, counts, metadata)
    return
  }
  if (counts.remainingCharacters <= 0) {
    counts.truncatedText += 1
    return
  }
  if (depth >= 7 || value === null || typeof value !== 'object' || counts.remainingCharacters <= 0) return
  if (Array.isArray(value)) {
    const array = value as unknown[]
    for (const item of array.slice(0, 100)) scanValue(item, messageIndex, counts, metadata, depth + 1)
    if (array.length > 100) counts.truncatedText += 1
    return
  }
  const record = value as Record<string, unknown>
  for (const [key, item] of Object.entries(record).slice(0, 100)) {
    if (/^base64$/i.test(key) || record.type === 'image' && /^data$/i.test(key)) continue
    scanValue(item, messageIndex, counts, metadata, depth + 1)
  }
}

function createConsent(
  session: AgentSession,
  entries: readonly SessionEntry[],
  includeRuntimeMetadata: boolean,
): TransferConsentPayload {
  const attachmentSummary = collectAttachmentReferences(entries)
  const totalMessageCount = countMessages(entries).total
  const counts: ScanCounts = {
    apiKey: 0,
    token: 0,
    privateKey: 0,
    total: 0,
    systemPrompt: 0,
    toolSchema: 0,
    entryMetadata: 0,
    truncatedText: 0,
    remainingCharacters: MAX_SCAN_CHARACTERS,
    scannedMessages: 0,
    affectedMessages: new Set(),
  }
  let messageIndex = 0
  let unscannedMessages = 0
  for (const entry of entries) {
    const message = messageContent(entry)
    if (!message) continue
    if (counts.scannedMessages >= MAX_SCANNED_MESSAGES || counts.remainingCharacters <= 0) {
      unscannedMessages += 1
      messageIndex += 1
      continue
    }
    scanValue(entry.type === 'message' ? entry.message : entry, messageIndex, counts)
    counts.scannedMessages += 1
    messageIndex += 1
  }
  for (const entry of entries) {
    if (messageContent(entry)) continue
    scanValue(entry, null, counts, 'entry')
  }
  if (includeRuntimeMetadata) {
    scanValue(session.state.systemPrompt, null, counts, 'system')
    scanValue(session.state.tools, null, counts, 'tool')
  }
  const affectedMessageIndices = [...counts.affectedMessages].sort((left, right) => left - right)
  return {
    sessionId: session.sessionId,
    messageCounts: countMessages(entries),
    attachmentReferences: attachmentSummary.references,
    attachmentReferenceCount: attachmentSummary.total,
    omittedAttachmentReferenceCount: attachmentSummary.total - attachmentSummary.references.length,
    secretScan: {
      version: 'bounded-v1',
      messageCount: totalMessageCount,
      scannedMessageCount: counts.scannedMessages,
      unscannedMessageCount: unscannedMessages,
      truncatedTextCount: counts.truncatedText,
      apiKeyMatches: counts.apiKey,
      tokenMatches: counts.token,
      privateKeyMatches: counts.privateKey,
      affectedMessageIndices: affectedMessageIndices.slice(0, MAX_AFFECTED_MESSAGE_INDICES),
      additionalAffectedMessageCount: Math.max(0, affectedMessageIndices.length - MAX_AFFECTED_MESSAGE_INDICES),
      systemPromptMatches: counts.systemPrompt,
      toolSchemaMatches: counts.toolSchema,
      entryMetadataMatches: counts.entryMetadata,
    },
  }
}

function contentRevision(
  session: AgentSession,
  entries: readonly SessionEntry[],
  includeRuntimeMetadata: boolean,
): string {
  const hash = createHash('sha256')
  hash.update(`${session.sessionId}\0${session.sessionManager.getLeafId() ?? ''}\n`)
  for (const entry of entries) {
    hash.update(`${entry.id}\0${entry.type}\0${entry.parentId ?? ''}\0${entry.timestamp}\n`)
  }
  if (includeRuntimeMetadata) {
    hash.update(session.state.systemPrompt)
    hash.update(JSON.stringify(session.state.tools) ?? '')
  }
  return hash.digest('hex')
}

async function targetExists(targetPath: string): Promise<'missing' | 'file' | 'unsafe'> {
  try {
    const currentStat = await lstat(targetPath)
    return currentStat.isFile() && !currentStat.isSymbolicLink() ? 'file' : 'unsafe'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe'
  }
}

export class TransferService {
  private readonly pending = new Map<string, PendingPreparation>()
  private readonly activeShares = new Map<string, ActiveShare>()
  private readonly shareEventSubscribers = new Set<ShareEventSubscriber>()
  private disposed = false

  constructor(private readonly options: TransferServiceOptions) {}

  subscribeShareEvents(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    publish: (event: TransferShareEventPayload) => void,
  ): () => void {
    const runtime = this.resolveRuntime(caller, scope)
    if (!runtime) throw new TypeError('The transfer runtime is unavailable for this caller.')
    const subscriber: ShareEventSubscriber = {
      caller: callerSnapshot(caller),
      scope: scopeSnapshot(scope),
      runtime,
      sessionId: runtime.session.sessionId,
      publish,
    }
    this.shareEventSubscribers.add(subscriber)
    return () => this.shareEventSubscribers.delete(subscriber)
  }

  disposeScope(scope: RuntimeScope): void {
    for (const [operationId, active] of this.activeShares) {
      if (!sameScope(active.scope, scope)) continue
      active.controller.abort()
      this.finishShare(operationId, active, 'cancelled')
      this.activeShares.delete(operationId)
    }
    for (const [id, pending] of this.pending) {
      if (sameScope(pending.scope, scope)) this.pending.delete(id)
    }
    for (const subscriber of this.shareEventSubscribers) {
      if (sameScope(subscriber.scope, scope)) this.shareEventSubscribers.delete(subscriber)
    }
  }

  dispose(): void {
    if (this.disposed) return
    for (const [operationId, active] of this.activeShares) {
      active.controller.abort()
      this.finishShare(operationId, active, 'cancelled')
      this.activeShares.delete(operationId)
    }
    this.pending.clear()
    this.shareEventSubscribers.clear()
    this.disposed = true
  }

  async prepareExport(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    request: TransferExportRequest,
  ): Promise<TransferExportResponse> {
    const runtime = this.resolveRuntime(caller, scope)
    if (!runtime) return { status: 'failed', error: 'runtime-unavailable' }
    if (!runtime.session.isIdle) return { status: 'failed', error: 'session-busy' }
    const sessionId = runtime.session.sessionId
    const window = this.getActiveWindow(caller)
    if (!window) return { status: 'failed', error: 'dialog-unavailable' }
    let selection: SaveDialogReturnValue
    try {
      selection = await this.options.showSaveDialog(window, {
        title: request.format === 'html' ? 'Export session as HTML' : 'Export session as JSONL',
        buttonLabel: 'Continue',
        defaultPath: `pi-session-${sessionId}.${request.format}`,
        filters: [{ name: request.format.toUpperCase(), extensions: [request.format] }],
      })
    } catch {
      return { status: 'failed', error: 'dialog-unavailable' }
    }
    if (selection.canceled || !selection.filePath) return { status: 'cancelled' }
    if (!this.isStillCurrent(caller, scope, runtime, sessionId, window)) {
      return { status: 'failed', error: 'runtime-unavailable' }
    }
    const target = await selectedExportPath(selection.filePath)
    if (!target
      || extname(target.path).toLowerCase() !== `.${request.format}`) {
      return { status: 'failed', error: 'invalid-destination' }
    }
    const entries = request.format === 'html'
      ? runtime.session.sessionManager.getEntries()
      : runtime.session.sessionManager.getBranch()
    const includeRuntimeMetadata = request.format === 'html'
    const pending = this.addPending<PendingExport>({
      kind: 'export',
      format: request.format,
      targetPath: target.path,
      consent: createConsent(runtime.session, entries, includeRuntimeMetadata),
      revision: contentRevision(runtime.session, entries, includeRuntimeMetadata),
      sessionId,
      session: runtime.session,
      caller: callerSnapshot(caller),
      scope: scopeSnapshot(scope),
    })
    return {
      status: 'prepared',
      preparationId: pending.id,
      format: pending.format,
      targetPath: pending.targetPath,
      overwriteRequired: target.exists,
      consent: pending.consent,
    }
  }

  async confirmExport(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    request: TransferExportConfirmRequest,
  ): Promise<TransferExportConfirmResponse> {
    const preparation = this.getPending(request.preparationId)
    if (!preparation
      || preparation.kind !== 'export'
      || !sameCaller(preparation.caller, caller)
      || !sameScope(preparation.scope, scope)) {
      return { status: 'failed', error: 'preparation-expired' }
    }
    const pending = preparation
    if (!request.confirmed) {
      this.pending.delete(pending.id)
      return { status: 'cancelled' }
    }
    const runtime = this.resolveRuntime(caller, scope)
    if (!runtime || runtime.session !== pending.session || runtime.session.sessionId !== pending.sessionId) {
      this.pending.delete(pending.id)
      return { status: 'failed', error: 'runtime-unavailable' }
    }
    const exportEntries = pending.format === 'html'
      ? runtime.session.sessionManager.getEntries()
      : runtime.session.sessionManager.getBranch()
    const includeRuntimeMetadata = pending.format === 'html'
    if (!runtime.session.isIdle
      || contentRevision(runtime.session, exportEntries, includeRuntimeMetadata) !== pending.revision) {
      this.pending.delete(pending.id)
      return { status: 'failed', error: 'session-changed' }
    }
    const before = await targetExists(pending.targetPath)
    if (before === 'unsafe') {
      this.pending.delete(pending.id)
      return { status: 'failed', error: 'export-failed' }
    }
    if (before === 'file' && !request.overwriteConfirmed) {
      return {
        status: 'overwrite-required',
        preparationId: pending.id,
        targetPath: pending.targetPath,
        consent: pending.consent,
      }
    }

    const extension = pending.format === 'html' ? 'html' : 'jsonl'
    const temporaryPath = join(dirname(pending.targetPath), `.pi-transfer-${randomUUID()}.${extension}`)
    try {
      if (pending.format === 'html') await runtime.session.exportToHtml(temporaryPath)
      else runtime.session.exportToJsonl(temporaryPath)

      const latestEntries = pending.format === 'html'
        ? runtime.session.sessionManager.getEntries()
        : runtime.session.sessionManager.getBranch()
      if (!this.isStillCurrent(caller, scope, runtime, pending.sessionId)
        || !runtime.session.isIdle
        || contentRevision(runtime.session, latestEntries, includeRuntimeMetadata) !== pending.revision) {
        this.pending.delete(pending.id)
        return { status: 'failed', error: 'session-changed' }
      }
      const after = await targetExists(pending.targetPath)
      if (after === 'unsafe') throw new Error('unsafe export target')
      if (after === 'file') {
        if (!request.overwriteConfirmed) {
          return {
            status: 'overwrite-required',
            preparationId: pending.id,
            targetPath: pending.targetPath,
            consent: pending.consent,
          }
        }
        await rename(temporaryPath, pending.targetPath)
      } else {
        // link() is an atomic create-if-absent operation, so a target appearing after
        // the check can never be overwritten without explicit consent.
        try {
          await link(temporaryPath, pending.targetPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST' && !request.overwriteConfirmed) {
            return {
              status: 'overwrite-required',
              preparationId: pending.id,
              targetPath: pending.targetPath,
              consent: pending.consent,
            }
          }
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          await rename(temporaryPath, pending.targetPath)
        }
        await unlink(temporaryPath)
      }
      this.pending.delete(pending.id)
      return { status: 'exported', format: pending.format, targetPath: pending.targetPath }
    } catch {
      this.pending.delete(pending.id)
      return { status: 'failed', error: 'export-failed' }
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }

  async importSession(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<TransferImportResponse> {
    const runtime = this.resolveRuntime(caller, scope)
    if (!runtime) return { status: 'failed', error: 'runtime-unavailable' }
    const session = runtime.session
    const sessionId = session.sessionId
    const window = this.getActiveWindow(caller)
    if (!window) return { status: 'failed', error: 'dialog-unavailable' }
    let selection: OpenDialogReturnValue
    try {
      selection = await this.options.showOpenDialog(window, {
        title: 'Import Pi session JSONL',
        buttonLabel: 'Import',
        properties: ['openFile'],
        filters: [{ name: 'Pi session JSONL', extensions: ['jsonl'] }],
      })
    } catch {
      return { status: 'failed', error: 'dialog-unavailable' }
    }
    if (selection.canceled || selection.filePaths.length !== 1) return { status: 'cancelled' }
    if (!this.isStillCurrent(caller, scope, runtime, sessionId, window)) {
      return { status: 'failed', error: 'runtime-unavailable' }
    }
    const path = await selectedImportPath(selection.filePaths[0] ?? '')
    if (!path) return { status: 'invalid', error: 'invalid-session' }
    try {
      const inputStat = await stat(path)
      if (inputStat.size > MAX_IMPORT_BYTES) return { status: 'invalid', error: 'file-too-large' }
    } catch {
      return { status: 'invalid', error: 'invalid-session' }
    }
    const inspection = await inspectNativeSessionFile(path)
    if (inspection === 'invalid-jsonl' || inspection === 'unreadable') {
      return { status: 'invalid', error: 'invalid-jsonl' }
    }
    if (inspection !== 'valid') return { status: 'invalid', error: 'invalid-session' }
    const latestRuntime = this.resolveRuntime(caller, scope)
    if (!latestRuntime || latestRuntime.session !== session) return { status: 'failed', error: 'runtime-unavailable' }
    try {
      const result = await latestRuntime.importFromJsonl(path, latestRuntime.cwd)
      if (result.cancelled) return { status: 'cancelled' }
      if (!this.options.isRuntimeScopeCurrent(caller, scope)) return { status: 'failed', error: 'runtime-unavailable' }
      const updatedRuntime = this.resolveRuntime(caller, scope)
      if (!updatedRuntime) return { status: 'failed', error: 'runtime-unavailable' }
      return { status: 'imported', sessionId: updatedRuntime.session.sessionId }
    } catch {
      return { status: 'failed', error: 'import-failed' }
    }
  }

  async prepareShare(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<TransferSharePrepareResponse> {
    const runtime = this.resolveRuntime(caller, scope)
    if (!runtime) return { status: 'failed', error: 'runtime-unavailable' }
    if (!runtime.session.isIdle) return { status: 'failed', error: 'session-busy' }
    const session = runtime.session
    const entries = session.sessionManager.getBranch()
    const consent = createConsent(session, entries, true)
    const pending = this.addPending<PendingShare>({
      kind: 'share',
      consent,
      revision: contentRevision(session, entries, true),
      sessionId: session.sessionId,
      session,
      caller: callerSnapshot(caller),
      scope: scopeSnapshot(scope),
    })
    return {
      status: 'prepared',
      preparationId: pending.id,
      shareAvailable: this.options.shareOperation !== undefined,
      destinations: SHARE_DESTINATIONS,
      ...(this.options.shareOperation ? {} : { seam: 'native-share-operation-not-injected' as const }),
      consent,
    }
  }

  async confirmShare(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    request: TransferShareConfirmRequest,
  ): Promise<TransferShareConfirmResponse> {
    const preparation = this.getPending(request.preparationId)
    if (!preparation
      || preparation.kind !== 'share'
      || !sameCaller(preparation.caller, caller)
      || !sameScope(preparation.scope, scope)) {
      return { status: 'failed', error: 'preparation-expired' }
    }
    const pending = preparation
    this.pending.delete(pending.id)
    if (!request.confirmed) return { status: 'cancelled' }
    const operation = this.options.shareOperation
    if (!operation) {
      return { status: 'unavailable', seam: 'native-share-operation-not-injected' }
    }
    const runtime = this.resolveRuntime(caller, scope)
    if (!runtime || runtime.session !== pending.session || runtime.session.sessionId !== pending.sessionId) {
      return { status: 'failed', error: 'runtime-unavailable' }
    }
    if (!runtime.session.isIdle
      || contentRevision(runtime.session, runtime.session.sessionManager.getBranch(), true) !== pending.revision) {
      return { status: 'failed', error: 'session-changed' }
    }
    const controller = new AbortController()
    const active: ActiveShare = {
      operationId: pending.id,
      caller: callerSnapshot(caller),
      scope: scopeSnapshot(scope),
      session: runtime.session,
      sessionId: pending.sessionId,
      controller,
      terminalEmitted: false,
    }
    this.activeShares.set(pending.id, active)
    const runtimeGuard = setInterval(() => {
      if (!this.isStillCurrent(caller, scope, runtime, pending.sessionId) || !runtime.session.isIdle) {
        controller.abort()
      }
    }, 250)
    let terminalOutcome: 'shared' | 'cancelled' | 'failed' = 'failed'
    try {
      const outcome = await operation.run(runtime.session, {
        signal: controller.signal,
        onProgress: (progress: TransferShareProgress) => {
          if (!this.isStillCurrent(caller, scope, runtime, pending.sessionId) || !runtime.session.isIdle) {
            controller.abort()
            return
          }
          const event: TransferShareEventPayload = {
            type: 'share-progress',
            operationId: pending.id,
            phase: progress.phase,
          }
          if (isTransferShareEventPayload(event)) this.publishShareEvent(active, event)
        },
      })
      if (!this.isStillCurrent(caller, scope, runtime, pending.sessionId) || !runtime.session.isIdle) {
        controller.abort()
        terminalOutcome = 'cancelled'
        return { status: 'failed', error: 'runtime-unavailable' }
      }
      if (outcome.status === 'cancelled') {
        terminalOutcome = 'cancelled'
        return { status: 'cancelled' }
      }
      if (outcome.status === 'failed') {
        terminalOutcome = 'failed'
        return {
          status: 'failed',
          error: 'share-failed',
          phase: outcome.phase,
          message: outcome.message.slice(0, 512),
        }
      }
      terminalOutcome = 'shared'
      if (outcome.destination === 'radius-organization') {
        return { status: 'shared', destination: outcome.destination, url: outcome.url }
      }
      return {
        status: 'shared',
        destination: outcome.destination,
        url: outcome.url,
        gistUrl: outcome.gistUrl,
      }
    } catch {
      terminalOutcome = controller.signal.aborted ? 'cancelled' : 'failed'
      return controller.signal.aborted ? { status: 'cancelled' } : { status: 'failed', error: 'share-failed' }
    } finally {
      clearInterval(runtimeGuard)
      this.finishShare(pending.id, active, terminalOutcome)
      this.activeShares.delete(pending.id)
    }
  }

  cancelShare(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    request: TransferShareCancelRequest,
  ): TransferShareCancelResponse {
    const active = this.activeShares.get(request.preparationId)
    if (!active) return { status: 'failed', error: 'share-not-active' }
    if (!sameCaller(active.caller, caller) || !sameScope(active.scope, scope)) {
      return { status: 'failed', error: 'runtime-unavailable' }
    }
    active.controller.abort()
    return { status: 'cancellation-requested' }
  }

  private resolveRuntime(caller: AuthorizedIpcCaller, scope: RuntimeScope): TransferRuntimeAccess | undefined {
    try {
      if (this.disposed || !this.options.isCallerActive(caller) || !this.options.isRuntimeScopeCurrent(caller, scope)) return undefined
      return this.options.getRuntime(caller, scope)
    } catch {
      return undefined
    }
  }

  private isStillCurrent(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    runtime: TransferRuntimeAccess,
    sessionId: string,
    expectedWindow?: BrowserWindow,
  ): boolean {
    try {
      const window = this.options.getWindow(caller)
      return !this.disposed
        && this.options.isCallerActive(caller)
        && this.options.isRuntimeScopeCurrent(caller, scope)
        && this.options.getRuntime(caller, scope)?.session === runtime.session
        && runtime.session.sessionId === sessionId
        && (!expectedWindow || window === expectedWindow && isActiveWindow(window, caller))
    } catch {
      return false
    }
  }

  private publishShareEvent(active: ActiveShare, event: TransferShareEventPayload): void {
    if (this.disposed || this.activeShares.get(active.operationId) !== active) return
    for (const subscriber of this.shareEventSubscribers) {
      if (!sameCaller(active.caller, subscriber.caller)
        || !sameScope(active.scope, subscriber.scope)
        || subscriber.runtime.session !== active.session
        || subscriber.sessionId !== active.sessionId
        || !this.isStillCurrent(subscriber.caller, subscriber.scope, subscriber.runtime, subscriber.sessionId)) continue
      try {
        subscriber.publish(event)
      } catch {
        // Renderer event delivery must not interrupt native session sharing.
      }
    }
  }

  private finishShare(
    operationId: string,
    active: ActiveShare,
    outcome: 'shared' | 'cancelled' | 'failed',
  ): void {
    if (active.terminalEmitted) return
    active.terminalEmitted = true
    this.publishShareEvent(active, { type: 'share-terminal', operationId, outcome })
  }

  private getActiveWindow(caller: AuthorizedIpcCaller): BrowserWindow | null {
    try {
      const window = this.options.getWindow(caller)
      return isActiveWindow(window, caller) && this.options.isCallerActive(caller) ? window : null
    } catch {
      return null
    }
  }

  private addPending<T extends PendingExport | PendingShare>(value: Omit<T, 'id' | 'expiresAt'>): T {
    this.prunePending()
    if (this.pending.size >= MAX_PENDING_PREPARATIONS) throw new Error('Too many pending transfer confirmations.')
    const pending = {
      ...value,
      id: randomUUID(),
      expiresAt: Date.now() + PREPARATION_TTL_MS,
    } as T
    this.pending.set(pending.id, pending)
    return pending
  }

  private getPending(id: string): PendingPreparation | undefined {
    this.prunePending()
    return this.pending.get(id)
  }

  private prunePending(): void {
    const now = Date.now()
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(id)
    }
  }
}
