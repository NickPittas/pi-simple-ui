import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const SIDECAR_VERSION = 3
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024
const MAX_IDENTITIES = 2_000
const MAX_PROVIDER_LENGTH = 128
const MAX_NATIVE_ID_LENGTH = 256
const MAX_WORKER_ID_LENGTH = 128
const MAX_PATH_LENGTH = 4_096

export type WorkerAncestryState = 'known' | 'unknown'

/** Native identifiers and only the relationship data needed to restore worker ancestry. */
export interface WorkerIdentityRecord {
  readonly provider: string
  readonly workerId: string
  readonly nativeAgentId: string | null
  readonly nativeSessionId: string | null
  readonly parentAgentId: string | null
  readonly parentSessionId: string | null
  readonly workflowId: string | null
  readonly parentWorkerId: string | null
  readonly toolCallId: string | null
  readonly rootToolCallId: string | null
  readonly ancestry: WorkerAncestryState
  readonly nativeSessionPath: string | null
  readonly nativeSessionDirectory: string | null
  readonly nativeSessionCwd: string | null
  readonly ownerWorkspaceId: string | null
  readonly ownerWorkspacePath: string | null
  readonly ownerRuntimeId: string | null
  readonly updatedAt: number
}

export interface WorkerIdentityOwnership {
  readonly workspaceId: string
  readonly workspacePath: string
  readonly runtimeId: string
}

export interface WorkerNativeSessionReference {
  readonly nativeSessionId: string
  readonly nativeSessionPath: string
  readonly nativeSessionDirectory: string
  readonly nativeSessionCwd: string
}

export interface WorkerIdentityInput {
  readonly provider: string
  readonly nativeAgentId?: string
  readonly nativeSessionId?: string
  /** Existing provider ID is retained as the application ID when first observed. */
  readonly preferredWorkerId?: string
  readonly parentAgentId?: string
  readonly parentSessionId?: string
  readonly rootSessionId?: string
  readonly workflowId?: string
  /** Native tool call ID linking this worker to the immediate parent conversation. */
  readonly toolCallId?: string
  readonly nativeSessionPath?: string | null
  readonly nativeSessionDirectory?: string | null
  readonly nativeSessionCwd?: string | null
  readonly ownerWorkspaceId?: string | null
  readonly ownerWorkspacePath?: string | null
  readonly ownerRuntimeId?: string | null
}

export interface WorkerIdentityResolution {
  readonly workerId: string
  readonly parentSessionId: string | null
  readonly parentWorkerId: string | null
  readonly workflowId: string | null
  readonly toolCallId: string | null
  readonly rootToolCallId: string | null
  readonly ancestry: WorkerAncestryState
}

export interface WorkerIdentityDiagnostic {
  readonly code:
    | 'sidecar-corrupt'
    | 'sidecar-migrated'
    | 'sidecar-unavailable'
    | 'session-reference-invalid'
    | 'session-reference-owner-mismatch'
    | 'session-reference-missing'
    | 'session-reference-moved'
  readonly message: string
  readonly workerId?: string
}

interface SidecarV3 {
  readonly version: 3
  readonly records: readonly WorkerIdentityRecord[]
}

type LegacyWorkerIdentityRecord = Pick<WorkerIdentityRecord,
  | 'provider' | 'workerId' | 'nativeAgentId' | 'nativeSessionId' | 'parentAgentId' | 'parentSessionId'
  | 'workflowId' | 'parentWorkerId' | 'toolCallId' | 'rootToolCallId' | 'ancestry' | 'updatedAt'
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validId(value: unknown, max = MAX_NATIVE_ID_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
}

function optionalId(value: unknown, max = MAX_NATIVE_ID_LENGTH): value is string | null {
  return value === null || validId(value, max)
}

function isLegacyRecord(value: unknown): value is LegacyWorkerIdentityRecord {
  return isRecord(value)
    && Object.keys(value).length === 12
    && hasLegacyIdentityFields(value)
}

function hasLegacyIdentityFields(value: Record<string, unknown>): boolean {
  return ['provider', 'workerId', 'nativeAgentId', 'nativeSessionId', 'parentAgentId', 'parentSessionId', 'workflowId',
      'parentWorkerId', 'toolCallId', 'rootToolCallId', 'ancestry', 'updatedAt']
      .every((field) => Object.hasOwn(value, field))
    && validId(value.provider, MAX_PROVIDER_LENGTH)
    && validId(value.workerId, MAX_WORKER_ID_LENGTH)
    && optionalId(value.nativeAgentId)
    && optionalId(value.nativeSessionId)
    && optionalId(value.parentAgentId)
    && optionalId(value.parentSessionId)
    && optionalId(value.workflowId)
    && optionalId(value.parentWorkerId, MAX_WORKER_ID_LENGTH)
    && optionalId(value.toolCallId)
    && optionalId(value.rootToolCallId)
    && (value.nativeAgentId !== null || value.nativeSessionId !== null)
    && (value.ancestry === 'known' || value.ancestry === 'unknown')
    && (value.ancestry === 'unknown'
      || value.parentAgentId !== null
      || value.parentSessionId !== null
      || value.workflowId !== null)
    && typeof value.updatedAt === 'number'
    && Number.isSafeInteger(value.updatedAt)
    && value.updatedAt >= 0
}

function isV3Record(value: unknown): value is WorkerIdentityRecord {
  return isRecord(value)
    && Object.keys(value).length === 18
    && [
      'provider', 'workerId', 'nativeAgentId', 'nativeSessionId', 'parentAgentId', 'parentSessionId', 'workflowId',
      'parentWorkerId', 'toolCallId', 'rootToolCallId', 'ancestry', 'nativeSessionPath', 'nativeSessionDirectory',
      'nativeSessionCwd', 'ownerWorkspaceId', 'ownerWorkspacePath', 'ownerRuntimeId', 'updatedAt',
    ].every((field) => Object.hasOwn(value, field))
    && hasLegacyIdentityFields(value)
    && optionalPath(value.nativeSessionPath)
    && optionalPath(value.nativeSessionDirectory)
    && optionalPath(value.nativeSessionCwd)
    && optionalId(value.ownerWorkspaceId, MAX_NATIVE_ID_LENGTH)
    && optionalPath(value.ownerWorkspacePath)
    && optionalId(value.ownerRuntimeId, MAX_NATIVE_ID_LENGTH)
    && ((value.nativeSessionPath === null
      && value.nativeSessionDirectory === null
      && value.nativeSessionCwd === null)
      || (value.nativeSessionPath !== null
        && value.nativeSessionDirectory !== null
        && value.nativeSessionCwd !== null
        && value.nativeSessionId !== null
        && value.ownerWorkspaceId !== null
        && value.ownerWorkspacePath !== null
        && value.ownerRuntimeId !== null
        && dirname(value.nativeSessionPath) === value.nativeSessionDirectory))
    && ((value.ownerWorkspaceId === null && value.ownerWorkspacePath === null && value.ownerRuntimeId === null)
      || (value.ownerWorkspaceId !== null && value.ownerWorkspacePath !== null && value.ownerRuntimeId !== null))
}

function optionalPath(value: unknown): value is string | null {
  return value === null || (typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PATH_LENGTH
    && !value.includes('\0')
    && isAbsolute(value)
    && resolve(value) === value)
}

function withV3Metadata(record: LegacyWorkerIdentityRecord): WorkerIdentityRecord {
  return Object.freeze({
    ...record,
    nativeSessionPath: null,
    nativeSessionDirectory: null,
    nativeSessionCwd: null,
    ownerWorkspaceId: null,
    ownerWorkspacePath: null,
    ownerRuntimeId: null,
  })
}

function key(provider: string, nativeId: string): string {
  return `${provider}\0${nativeId}`
}

function deterministicWorkerId(provider: string, nativeId: string): string {
  // Stable when the sidecar is lost, while keeping provider IDs out of UI-facing IDs.
  const hash = createHash('sha256').update(`${provider}\0${nativeId}`).digest('hex').slice(0, 32)
  return `worker_${hash}`
}

function migrateV1(value: Record<string, unknown>): WorkerIdentityRecord[] | undefined {
  if (value.version !== 1 || !Array.isArray(value.mappings) || value.mappings.length > MAX_IDENTITIES) return undefined
  const records: WorkerIdentityRecord[] = []
  for (const item of value.mappings) {
    if (!isRecord(item) || !validId(item.provider, MAX_PROVIDER_LENGTH)
      || !validId(item.nativeId) || !validId(item.workerId, MAX_WORKER_ID_LENGTH)) return undefined
    records.push(withV3Metadata({
      provider: item.provider,
      workerId: item.workerId,
      nativeAgentId: item.nativeId,
      nativeSessionId: null,
      parentAgentId: null,
      parentSessionId: null,
      workflowId: null,
      parentWorkerId: null,
      toolCallId: null,
      rootToolCallId: null,
      ancestry: 'unknown',
      updatedAt: 0,
    }))
  }
  return records
}

/** Bounded app-data mapping from provider-native identities to stable app worker IDs. */
export class WorkerIdentityStore {
  readonly path: string
  private readonly records = new Map<string, WorkerIdentityRecord>()
  private readonly diagnosticsList: WorkerIdentityDiagnostic[] = []
  private recoveryRequired = false
  private dirty = false

  constructor(path: string) {
    this.path = path
    this.load()
  }

  get diagnostics(): readonly WorkerIdentityDiagnostic[] {
    return [...this.diagnosticsList]
  }

  get requiresNativeRecovery(): boolean {
    return this.recoveryRequired
  }

  list(): readonly WorkerIdentityRecord[] {
    return [...new Map([...this.records.values()].map((record) => [record.workerId, record])).values()]
      .sort((left, right) => left.updatedAt - right.updatedAt)
  }

  getByWorkerId(workerId: string): WorkerIdentityRecord | undefined {
    return [...this.records.values()].find((record) => record.workerId === workerId)
  }

  findByNative(provider: string, nativeId: string): WorkerIdentityRecord | undefined {
    return this.records.get(key(provider, nativeId))
  }

  findBySessionId(nativeSessionId: string): readonly WorkerIdentityRecord[] {
    const unique = new Map<string, WorkerIdentityRecord>()
    for (const record of this.records.values()) {
      if (record.nativeSessionId === nativeSessionId) unique.set(record.workerId, record)
    }
    return [...unique.values()]
  }

  findByRootToolCall(toolCallId: string): readonly WorkerIdentityRecord[] {
    return [...new Map([...this.records.values()]
      .filter((record) => record.rootToolCallId === toolCallId)
      .map((record) => [record.workerId, record])).values()]
  }

  remember(input: WorkerIdentityInput): WorkerIdentityResolution {
    if (!validId(input.provider, MAX_PROVIDER_LENGTH)) throw new TypeError('Worker identity provider is invalid.')
    const agentId = input.nativeAgentId
    const sessionId = input.nativeSessionId
    if (!agentId && !sessionId) throw new TypeError('A native worker or session ID is required.')
    if ((agentId && !validId(agentId)) || (sessionId && !validId(sessionId))) {
      throw new TypeError('Native worker identity is invalid.')
    }
    if (input.preferredWorkerId && !validId(input.preferredWorkerId, MAX_WORKER_ID_LENGTH)) {
      throw new TypeError('Application worker identity is invalid.')
    }

    const prior = (agentId ? this.findByNative(input.provider, agentId) : undefined)
      ?? (sessionId ? this.findByNative(input.provider, sessionId) : undefined)
    const workerId = prior?.workerId ?? input.preferredWorkerId
      ?? deterministicWorkerId(input.provider, sessionId ?? agentId!)
    const parentAgentId = input.parentAgentId ?? prior?.parentAgentId ?? null
    const parentSessionId = input.parentSessionId ?? prior?.parentSessionId ?? null
    const workflowId = input.workflowId ?? prior?.workflowId ?? null
    const parent = (parentAgentId ? this.findByNative(input.provider, parentAgentId) : undefined)
      ?? (parentSessionId ? this.findByNative(input.provider, parentSessionId) : undefined)
    const atRootSession = !!input.rootSessionId && parentSessionId === input.rootSessionId
    const hasNativeParent = !!parentAgentId || !!parentSessionId || !!workflowId
    const rootToolCallId = parent?.rootToolCallId
      ?? (atRootSession ? input.toolCallId ?? null : null)
    const nativeSessionPath = input.nativeSessionPath !== undefined
      ? input.nativeSessionPath
      : prior?.nativeSessionPath ?? null
    const nativeSessionDirectory = input.nativeSessionDirectory !== undefined
      ? input.nativeSessionDirectory
      : prior?.nativeSessionDirectory ?? null
    const nativeSessionCwd = input.nativeSessionCwd !== undefined
      ? input.nativeSessionCwd
      : prior?.nativeSessionCwd ?? null
    const ownerWorkspaceId = input.ownerWorkspaceId !== undefined
      ? input.ownerWorkspaceId
      : prior?.ownerWorkspaceId ?? null
    const ownerWorkspacePath = input.ownerWorkspacePath !== undefined
      ? input.ownerWorkspacePath
      : prior?.ownerWorkspacePath ?? null
    const ownerRuntimeId = input.ownerRuntimeId !== undefined
      ? input.ownerRuntimeId
      : prior?.ownerRuntimeId ?? null
    if (!optionalPath(nativeSessionPath) || !optionalPath(nativeSessionDirectory) || !optionalPath(nativeSessionCwd)
      || !optionalId(ownerWorkspaceId) || !optionalPath(ownerWorkspacePath) || !optionalId(ownerRuntimeId)) {
      throw new TypeError('Worker session reference or ownership metadata is invalid.')
    }
    const hasSessionPath = nativeSessionPath !== null
      && nativeSessionDirectory !== null
      && nativeSessionCwd !== null
    const hasOwner = ownerWorkspaceId !== null && ownerWorkspacePath !== null && ownerRuntimeId !== null
    if ((nativeSessionPath !== null || nativeSessionDirectory !== null || nativeSessionCwd !== null)
      && (!hasSessionPath || !hasOwner || !(sessionId ?? prior?.nativeSessionId))) {
      throw new TypeError('Worker session references require a native session and complete ownership metadata.')
    }
    if ((ownerWorkspaceId !== null || ownerWorkspacePath !== null || ownerRuntimeId !== null) && !hasOwner) {
      throw new TypeError('Worker ownership metadata is incomplete.')
    }
    if (hasSessionPath && dirname(nativeSessionPath) !== nativeSessionDirectory) {
      throw new TypeError('Worker session path and directory do not match.')
    }
    const record: WorkerIdentityRecord = Object.freeze({
      provider: input.provider,
      workerId,
      nativeAgentId: agentId ?? prior?.nativeAgentId ?? null,
      nativeSessionId: sessionId ?? prior?.nativeSessionId ?? null,
      parentAgentId,
      parentSessionId,
      workflowId,
      parentWorkerId: parent?.workerId ?? prior?.parentWorkerId ?? null,
      toolCallId: input.toolCallId ?? prior?.toolCallId ?? null,
      rootToolCallId: rootToolCallId ?? prior?.rootToolCallId ?? null,
      ancestry: hasNativeParent ? 'known' : 'unknown',
      nativeSessionPath,
      nativeSessionDirectory,
      nativeSessionCwd,
      ownerWorkspaceId,
      ownerWorkspacePath,
      ownerRuntimeId,
      updatedAt: Date.now(),
    })

    this.storeRecord(record)
    this.reconcileRelationships()
    if (!agentId && !sessionId) throw new TypeError('A native worker or session ID is required.')
    this.trim()
    this.changed()
    return {
      workerId,
      parentSessionId: record.parentSessionId,
      parentWorkerId: record.parentWorkerId,
      workflowId: record.workflowId,
      toolCallId: record.toolCallId,
      rootToolCallId: record.rootToolCallId,
      ancestry: record.ancestry,
    }
  }

  /** Call after native session/manager discovery when a corrupt sidecar required recovery. */
  finishNativeRecovery(): void {
    if (!this.recoveryRequired) return
    this.recoveryRequired = false
    this.changed()
  }

  reportDiagnostic(diagnostic: WorkerIdentityDiagnostic): void {
    if (this.diagnosticsList.some((existing) => existing.code === diagnostic.code
      && existing.workerId === diagnostic.workerId)) return
    this.diagnosticsList.push(diagnostic)
  }

  private load(): void {
    try {
      const size = statSync(this.path).size
      if (size > MAX_SIDECAR_BYTES) throw new Error('sidecar exceeds size limit')
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!isRecord(parsed)) throw new Error('sidecar is not an object')
      if (parsed.version === SIDECAR_VERSION) {
        if (!Array.isArray(parsed.records) || parsed.records.length > MAX_IDENTITIES
          || !parsed.records.every(isV3Record)) throw new Error('sidecar records are invalid')
        const workerIds = new Set<string>()
        const nativeKeys = new Set<string>()
        for (const record of parsed.records) {
          if (workerIds.has(record.workerId)) throw new Error('sidecar worker IDs are duplicated')
          workerIds.add(record.workerId)
          for (const nativeId of new Set([record.nativeAgentId, record.nativeSessionId])) {
            if (!nativeId) continue
            const nativeKey = key(record.provider, nativeId)
            if (nativeKeys.has(nativeKey)) throw new Error('sidecar native IDs are duplicated')
            nativeKeys.add(nativeKey)
          }
          if (record.nativeAgentId) this.records.set(key(record.provider, record.nativeAgentId), record)
          if (record.nativeSessionId) this.records.set(key(record.provider, record.nativeSessionId), record)
        }
        return
      }
      if (parsed.version === 2 && Array.isArray(parsed.records) && parsed.records.length <= MAX_IDENTITIES
        && parsed.records.every((record) => isRecord(record) && Object.keys(record).length === 12 && isLegacyRecord(record))) {
        const migrated = (parsed.records as LegacyWorkerIdentityRecord[]).map(withV3Metadata)
        this.installMigrated(migrated)
        this.diagnosticsList.push({ code: 'sidecar-migrated', message: 'Worker identity sidecar migrated from version 2.' })
        this.dirty = true
        this.persist()
        return
      }
      const migrated = migrateV1(parsed)
      if (migrated) {
        this.installMigrated(migrated)
        this.diagnosticsList.push({ code: 'sidecar-migrated', message: 'Worker identity sidecar migrated from version 1.' })
        this.dirty = true
        this.persist()
        return
      }
      throw new Error('unsupported or invalid sidecar version')
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return
      this.records.clear()
      this.recoveryRequired = true
      this.diagnosticsList.push({
        code: 'sidecar-corrupt',
        message: 'Worker identity sidecar is invalid; native identity and session discovery is required before it can be rewritten.',
      })
    }
  }

  private installMigrated(records: readonly WorkerIdentityRecord[]): void {
    const workerIds = new Set<string>()
    const nativeKeys = new Set<string>()
    for (const record of records) {
      if (workerIds.has(record.workerId)) throw new Error('sidecar worker IDs are duplicated')
      workerIds.add(record.workerId)
      for (const nativeId of new Set([record.nativeAgentId, record.nativeSessionId])) {
        if (!nativeId) continue
        const nativeKey = key(record.provider, nativeId)
        if (nativeKeys.has(nativeKey)) throw new Error('sidecar native IDs are duplicated')
        nativeKeys.add(nativeKey)
      }
    }
    for (const record of records) {
      if (record.nativeAgentId) this.records.set(key(record.provider, record.nativeAgentId), record)
      if (record.nativeSessionId) this.records.set(key(record.provider, record.nativeSessionId), record)
    }
  }

  private trim(): void {
    const unique = new Map<string, WorkerIdentityRecord>()
    for (const record of this.records.values()) unique.set(record.workerId, record)
    const retained = [...unique.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_IDENTITIES)
    this.records.clear()
    for (const record of retained) {
      if (record.nativeAgentId) this.records.set(key(record.provider, record.nativeAgentId), record)
      if (record.nativeSessionId) this.records.set(key(record.provider, record.nativeSessionId), record)
    }
  }

  private storeRecord(record: WorkerIdentityRecord): void {
    for (const [identityKey, value] of this.records) {
      if (value.workerId === record.workerId) this.records.delete(identityKey)
    }
    if (record.nativeAgentId) this.records.set(key(record.provider, record.nativeAgentId), record)
    if (record.nativeSessionId) this.records.set(key(record.provider, record.nativeSessionId), record)
  }

  private reconcileRelationships(): void {
    const records = this.list()
    for (let pass = 0; pass < 64; pass++) {
      let changed = false
      for (const initial of records) {
        const current = this.getByWorkerId(initial.workerId) ?? initial
        const parent = (current.parentAgentId
          ? this.findByNative(current.provider, current.parentAgentId)
          : undefined)
          ?? (current.parentSessionId
            ? this.findByNative(current.provider, current.parentSessionId)
            : undefined)
        if (!parent) continue
        const rootToolCallId = current.rootToolCallId ?? parent.rootToolCallId
        const parentWorkerId = current.parentWorkerId ?? parent.workerId
        if (rootToolCallId === current.rootToolCallId && parentWorkerId === current.parentWorkerId) continue
        this.storeRecord(Object.freeze({
          ...current,
          parentWorkerId,
          rootToolCallId,
          updatedAt: Date.now(),
        }))
        changed = true
      }
      if (!changed) break
    }
  }

  private changed(): void {
    this.dirty = true
    if (!this.recoveryRequired) this.persist()
  }

  private persist(): void {
    if (!this.dirty) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const unique = new Map<string, WorkerIdentityRecord>()
      for (const record of this.records.values()) unique.set(record.workerId, record)
      const payload: SidecarV3 = {
        version: SIDECAR_VERSION,
        records: [...unique.values()].sort((left, right) => left.updatedAt - right.updatedAt),
      }
      const temporary = join(dirname(this.path), `.${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        renameSync(temporary, this.path)
      } catch (error) {
        try { unlinkSync(temporary) } catch { /* No temporary file was created. */ }
        throw error
      }
      this.dirty = false
    } catch {
      if (!this.diagnosticsList.some((diagnostic) => diagnostic.code === 'sidecar-unavailable')) {
        this.diagnosticsList.push({
          code: 'sidecar-unavailable',
          message: 'Worker identity sidecar could not be persisted; native worker records remain untouched.',
        })
      }
    }
  }
}
