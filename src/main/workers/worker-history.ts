import { realpathSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  CURRENT_SESSION_VERSION,
  parseSessionEntries,
  SessionManager,
  type JSONValue,
  type SessionInfo,
} from '@earendil-works/pi-coding-agent'
import {
  WORKER_SNAPSHOT_DEFAULT_LIMIT,
  WORKER_SNAPSHOT_MAX_LIMIT,
  WORKER_SNAPSHOT_MAX_OFFSET,
} from '../../shared/workers.ts'
import type { WorkerRegistry } from './worker-registry.ts'
import type {
  WorkerIdentityInput,
  WorkerIdentityOwnership,
  WorkerIdentityRecord,
  WorkerIdentityStore,
  WorkerNativeSessionReference,
} from './worker-identity.ts'
import { toWorkerJson } from './worker-events.ts'

export interface WorkerHistoryPage {
  readonly workerId: string
  readonly offset: number
  readonly limit: number
  readonly total: number
  readonly nextOffset: number | null
  readonly messages: readonly JSONValue[]
}

export interface NativeWorkerHistory {
  readonly messages: readonly JSONValue[]
  /** Native SessionEntry IDs in the same order as messages. */
  readonly messageIds: readonly string[]
}

export interface WorkerHistoryOptions {
  readonly identities: WorkerIdentityStore
  /** Only explicit workspace-scoped roots; no default/global session-directory scan. */
  readonly sessionDirectories?: readonly string[]
  readonly ownership: WorkerIdentityOwnership
  /** Used only when a corrupt sidecar requires native identity recovery. */
  readonly recoverNativeIdentities?: (sessions: readonly SessionInfo[]) => readonly WorkerIdentityInput[]
}

interface NativeSessionLocation extends WorkerNativeSessionReference {
  readonly manager: SessionManager
}

interface ParsedNativeSession {
  readonly manager: SessionManager
  readonly nativeSessionId: string
  readonly nativeSessionCwd: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function within(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function nativeSession(path: string, expectedId?: string, expectedCwd?: string): ParsedNativeSession | null {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const headerLine = content.split(/\r?\n/, 1)[0]
  if (!headerLine) return null
  let header: unknown
  try {
    header = JSON.parse(headerLine)
  } catch {
    return null
  }
  if (!isRecord(header)
    || header.type !== 'session'
    || typeof header.id !== 'string'
    || !header.id
    || header.id.length > 256
    || header.id.includes('\0')
    || typeof header.cwd !== 'string'
    || !header.cwd
    || header.cwd.length > 4_096
    || typeof header.version !== 'number'
    || !Number.isSafeInteger(header.version)
    || header.version < 1
    || header.version > CURRENT_SESSION_VERSION
    || (expectedId !== undefined && header.id !== expectedId)) return null

  const nativeSessionCwd = resolve(header.cwd)
  if (expectedCwd !== undefined && nativeSessionCwd !== resolve(expectedCwd)) return null
  try {
    // In-memory session managers apply legacy projection migrations without writing native files.
    const manager = SessionManager.inMemory(nativeSessionCwd, undefined, parseSessionEntries(content))
    if (manager.getSessionId() !== header.id || resolve(manager.getCwd()) !== nativeSessionCwd) return null
    return { manager, nativeSessionId: header.id, nativeSessionCwd }
  } catch {
    return null
  }
}

function nativeConversation(manager: SessionManager): NativeWorkerHistory {
  const messageIds = new Set<string>()
  const messages: JSONValue[] = []
  const ids: string[] = []
  const projection = manager.buildSessionProjection()
  for (const contribution of projection.entries) {
    const nativeEntryId = contribution.sourceEntry.id
    contribution.messages.forEach((message, index) => {
      const id = `${nativeEntryId}:${index}`
      if (messageIds.has(id)) return
      messageIds.add(id)
      ids.push(id)
      messages.push(toWorkerJson(message))
    })
  }
  return { messages, messageIds: ids }
}

function validPage(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > WORKER_SNAPSHOT_MAX_OFFSET
    || !Number.isSafeInteger(limit) || limit < 1 || limit > WORKER_SNAPSHOT_MAX_LIMIT) {
    throw new TypeError('The worker history page is invalid.')
  }
}

/** Restores read-only projections from validated, workspace-owned native session files. */
export class WorkerHistory {
  private readonly identities: WorkerIdentityStore
  private readonly sessionDirectories: readonly string[]
  private readonly ownership: WorkerIdentityOwnership
  private readonly recoverNativeIdentities?: WorkerHistoryOptions['recoverNativeIdentities']
  private readonly captureCache = new Map<string, WorkerNativeSessionReference | null>()
  private readonly restoreAttempts = new Map<string, { readonly key: string; readonly promise: Promise<void> }>()
  private lastSessions: readonly SessionInfo[] = []
  private sessionsDiscovered = false

  constructor(options: WorkerHistoryOptions) {
    this.identities = options.identities
    this.sessionDirectories = (options.sessionDirectories ?? []).map((directory) => resolve(directory))
    this.ownership = {
      workspaceId: options.ownership.workspaceId,
      workspacePath: resolve(options.ownership.workspacePath),
      runtimeId: options.ownership.runtimeId,
    }
    this.recoverNativeIdentities = options.recoverNativeIdentities
  }

  get diagnostics() {
    return this.identities.diagnostics
  }

  /** Capture a reference only from an observed native manager/session record. */
  captureSessionReference(
    workerId: string,
    sessionFile: string,
    expectedSessionId?: string,
    expectedCwd?: string,
  ): WorkerNativeSessionReference | null {
    const cacheKey = `${sessionFile}\0${expectedSessionId ?? ''}\0${expectedCwd ?? ''}`
    const cached = this.captureCache.get(cacheKey)
    if (cached) return cached
    let reference: WorkerNativeSessionReference | null = null
    try {
      const canonicalPath = realpathSync(sessionFile)
      if (!statSync(canonicalPath).isFile()) throw new Error('not a regular session file')
      const parsed = nativeSession(canonicalPath, expectedSessionId, expectedCwd)
      if (!parsed) throw new Error('native session header did not match the observed session')
      reference = {
        nativeSessionId: parsed.nativeSessionId,
        nativeSessionPath: canonicalPath,
        nativeSessionDirectory: dirname(canonicalPath),
        nativeSessionCwd: parsed.nativeSessionCwd,
      }
    } catch {
      this.diagnostic('session-reference-invalid', workerId,
        'An observed native session reference could not be validated; its history will not be restored from that path.')
    }
    if (reference) this.captureCache.set(cacheKey, reference)
    if (this.captureCache.size > 2_000) this.captureCache.clear()
    return reference
  }

  /** Restore after the observer has populated summaries; repeated live scans are deduplicated. */
  async restore(registry: WorkerRegistry): Promise<void> {
    const scope = registry.scope
    const sessions = await this.discoverSessions()
    if (!registry.isCurrentScope(scope)) return
    this.lastSessions = sessions
    this.sessionsDiscovered = true
    if (this.recoverNativeIdentities && this.identities.requiresNativeRecovery) {
      const recoveredIdentities = this.recoverNativeIdentities(sessions)
      let recovered = 0
      for (const identity of recoveredIdentities) {
        if (!registry.isCurrentScope(scope)) return
        try {
          this.identities.remember(identity)
          recovered++
        } catch {
          // Invalid native metadata for one worker does not block other recoveries.
        }
      }
      if (recovered > 0) this.identities.finishNativeRecovery()
    }
    registry.setHistoryPageReader?.((workerId, offset, limit) => this.page(registry, workerId, offset, limit))

    for (const identity of this.identities.list()) {
      if (!registry.isCurrentScope(scope)) return
      await this.restoreWorker(registry, identity.workerId)
    }
  }

  /** Restore one newly observed session reference without replacing complete live messages. */
  async restoreWorker(registry: WorkerRegistry, workerId: string): Promise<void> {
    const scope = registry.scope
    if (!registry.isCurrentScope(scope)) return
    const identity = this.identities.getByWorkerId(workerId)
    if (!identity?.nativeSessionId || !registry.hasWorker(workerId)) return
    const referenceKey = [
      identity.nativeSessionId,
      identity.nativeSessionPath,
      identity.nativeSessionDirectory,
      identity.nativeSessionCwd,
      identity.ownerWorkspaceId,
      identity.ownerWorkspacePath,
      identity.ownerRuntimeId,
    ].join('\0')
    const previousAttempt = this.restoreAttempts.get(workerId)
    if (previousAttempt?.key === referenceKey) return previousAttempt.promise
    const promise = this.restoreWorkerForIdentity(registry, identity)
    this.restoreAttempts.set(workerId, { key: referenceKey, promise })
    if (this.restoreAttempts.size > 2_000) this.restoreAttempts.clear()
    return promise
  }

  private async restoreWorkerForIdentity(registry: WorkerRegistry, identity: WorkerIdentityRecord): Promise<void> {
    const scope = registry.scope
    try {
      const location = await this.findLocation(identity, registry)
      if (!location || !registry.isCurrentScope(scope)) return
      const history = nativeConversation(location.manager)
      if (!registry.isCurrentScope(scope)) return
      registry.restoreMessages?.(identity.workerId, history.messages, history.messageIds)
    } catch {
      this.diagnostic('session-reference-invalid', identity.workerId,
        'The validated native session could not be projected into worker history.')
    }
  }

  /** Read one bounded page from the validated session path or scoped discovery roots. */
  async page(
    registry: WorkerRegistry,
    workerId: string,
    offset = 0,
    limit = WORKER_SNAPSHOT_DEFAULT_LIMIT,
  ): Promise<WorkerHistoryPage | null> {
    validPage(offset, limit)
    const scope = registry.scope
    if (!registry.isCurrentScope(scope)) return null
    const identity = this.identities.getByWorkerId(workerId)
    if (!identity?.nativeSessionId) return null
    const location = await this.findLocation(identity, registry)
    if (!location || !registry.isCurrentScope(scope)) return null
    const history = nativeConversation(location.manager)
    if (!registry.isCurrentScope(scope)) return null
    const end = Math.min(history.messages.length, offset + limit)
    return {
      workerId,
      offset,
      limit,
      total: history.messages.length,
      nextOffset: end < history.messages.length ? end : null,
      messages: history.messages.slice(offset, end),
    }
  }

  private async findLocation(
    identity: WorkerIdentityRecord,
    registry: WorkerRegistry,
  ): Promise<NativeSessionLocation | null> {
    const ownership = this.ownerStatus(identity)
    if (ownership === 'mismatch') {
      this.diagnostic('session-reference-owner-mismatch', identity.workerId,
        'The recorded session belongs to a different workspace; restoration was skipped.')
      return null
    }

    if (identity.nativeSessionPath && identity.nativeSessionDirectory && identity.nativeSessionCwd) {
      const direct = this.validateReference(identity)
      if (direct) return direct
    }

    const sessions = this.sessionsDiscovered ? this.lastSessions : await this.discoverSessions()
    if (!registry.isCurrentScope(registry.scope)) return null
    this.lastSessions = sessions
    this.sessionsDiscovered = true
    const candidates = sessions.filter((session) => session.id === identity.nativeSessionId)
    const verified: NativeSessionLocation[] = []
    for (const candidate of candidates) {
      const location = this.validateDiscovered(candidate, identity)
      if (location && !verified.some((previous) => previous.nativeSessionPath === location.nativeSessionPath)) {
        verified.push(location)
      }
    }
    if (verified.length > 1) {
      this.diagnostic('session-reference-invalid', identity.workerId,
        'Multiple scoped native sessions matched this worker ID; restoration was skipped as ambiguous.')
      return null
    }
    const moved = verified[0]
    if (!moved) {
      if (identity.nativeSessionPath) {
        this.diagnostic('session-reference-missing', identity.workerId,
          'The recorded native session is missing or no longer matches its header; no scoped replacement was found.')
      }
      return null
    }

    if (identity.nativeSessionPath && identity.nativeSessionPath !== moved.nativeSessionPath) {
      this.diagnostic('session-reference-moved', identity.workerId,
        'The native session moved within a configured workspace root; its validated reference was updated.')
    }
    if (!registry.isCurrentScope(registry.scope)) return null
    const latest = this.identities.getByWorkerId(identity.workerId)
    if (!latest || latest.nativeSessionId !== identity.nativeSessionId
      || latest.nativeSessionPath !== identity.nativeSessionPath
      || latest.nativeSessionCwd !== identity.nativeSessionCwd
      || latest.ownerWorkspaceId !== identity.ownerWorkspaceId
      || latest.ownerWorkspacePath !== identity.ownerWorkspacePath
      || latest.ownerRuntimeId !== identity.ownerRuntimeId) return null
    try {
      this.identities.remember({
        provider: identity.provider,
        nativeAgentId: identity.nativeAgentId ?? undefined,
        nativeSessionId: moved.nativeSessionId,
        preferredWorkerId: identity.workerId,
        parentAgentId: identity.parentAgentId ?? undefined,
        parentSessionId: identity.parentSessionId ?? undefined,
        workflowId: identity.workflowId ?? undefined,
        toolCallId: identity.toolCallId ?? undefined,
        nativeSessionPath: moved.nativeSessionPath,
        nativeSessionDirectory: moved.nativeSessionDirectory,
        nativeSessionCwd: moved.nativeSessionCwd,
        ownerWorkspaceId: this.ownership.workspaceId,
        ownerWorkspacePath: this.ownership.workspacePath,
        ownerRuntimeId: this.ownership.runtimeId,
      })
    } catch {
      this.diagnostic('session-reference-invalid', identity.workerId,
        'The relocated native session reference could not be persisted to the identity sidecar.')
    }
    return moved
  }

  private ownerStatus(identity: WorkerIdentityRecord): 'current' | 'legacy' | 'mismatch' {
    const hasOwner = identity.ownerWorkspaceId !== null
      || identity.ownerWorkspacePath !== null
      || identity.ownerRuntimeId !== null
    if (!hasOwner) return 'legacy'
    return identity.ownerWorkspaceId === this.ownership.workspaceId
      && identity.ownerWorkspacePath === this.ownership.workspacePath
      && identity.ownerRuntimeId !== null
      ? 'current'
      : 'mismatch'
  }

  private validateReference(identity: WorkerIdentityRecord): NativeSessionLocation | null {
    const path = identity.nativeSessionPath!
    const directory = identity.nativeSessionDirectory!
    try {
      const canonicalPath = realpathSync(path)
      if (canonicalPath !== path || dirname(canonicalPath) !== directory) {
        this.diagnostic('session-reference-moved', identity.workerId,
          'The recorded native session path changed; restoration will search only configured workspace roots.')
        return null
      }
      if (!statSync(canonicalPath).isFile()) throw new Error('not a regular session file')
      const parsed = nativeSession(canonicalPath, identity.nativeSessionId!, identity.nativeSessionCwd!)
      if (!parsed) {
        this.diagnostic('session-reference-invalid', identity.workerId,
          'The native session header ID or working directory does not match its recorded reference.')
        return null
      }
      return {
        nativeSessionId: parsed.nativeSessionId,
        nativeSessionPath: canonicalPath,
        nativeSessionDirectory: directory,
        nativeSessionCwd: parsed.nativeSessionCwd,
        manager: parsed.manager,
      }
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined
      this.diagnostic(code === 'ENOENT' ? 'session-reference-missing' : 'session-reference-invalid', identity.workerId,
        code === 'ENOENT'
          ? 'The recorded native session file is missing; restoration will search only configured workspace roots.'
          : 'The recorded native session file could not be validated.')
      return null
    }
  }

  private validateDiscovered(session: SessionInfo, identity: WorkerIdentityRecord): NativeSessionLocation | null {
    let canonicalPath: string
    try {
      canonicalPath = realpathSync(session.path)
      if (!statSync(canonicalPath).isFile()) return null
    } catch {
      return null
    }
    const parsed = nativeSession(canonicalPath, identity.nativeSessionId!, identity.nativeSessionCwd ?? undefined)
    if (!parsed) return null
    return {
      nativeSessionId: parsed.nativeSessionId,
      nativeSessionPath: canonicalPath,
      nativeSessionDirectory: dirname(canonicalPath),
      nativeSessionCwd: parsed.nativeSessionCwd,
      manager: parsed.manager,
    }
  }

  private async discoverSessions(): Promise<SessionInfo[]> {
    const found = new Map<string, SessionInfo[]>()
    for (const configuredRoot of this.sessionDirectories) {
      let root: string
      try {
        root = realpathSync(configuredRoot)
        if (!statSync(root).isDirectory()) continue
      } catch {
        continue
      }
      let sessions: SessionInfo[]
      try {
        sessions = await SessionManager.listAll(root)
      } catch {
        continue
      }
      for (const session of sessions) {
        try {
          const path = realpathSync(session.path)
          if (!within(root, path) || !statSync(path).isFile()) continue
          const list = found.get(session.id) ?? []
          list.push({ ...session, path })
          found.set(session.id, list)
        } catch {
          // Raced deletion or unreadable native files are diagnosed when their identities are restored.
        }
      }
    }
    return [...found.values()].flat()
  }

  private diagnostic(
    code: 'session-reference-invalid' | 'session-reference-owner-mismatch' | 'session-reference-missing' | 'session-reference-moved',
    workerId: string,
    message: string,
  ): void {
    this.identities.reportDiagnostic({ code, workerId, message })
  }
}
