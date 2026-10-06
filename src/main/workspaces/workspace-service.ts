import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { hasExactKeys, isPlainRecord, isRuntimeScope, type RuntimeScope } from '../../shared/ipc-contracts.ts'
import { createExtensionUIBridge, type ExtensionUIBridge } from '../extensions/extension-ui-bridge.ts'
import type {
  WorkspaceEventPayload,
  WorkspaceInfo,
  WorkspaceOperationResult,
  WorkspaceSnapshot,
  WorkspaceTrustProvenance,
} from '../../shared/workspaces.ts'
import type { CreatePiSessionHostOptions } from '../pi/bootstrap.ts'
import type { PiSessionHost } from '../pi/session-host.ts'

interface FileIdentity {
  readonly device: string
  readonly inode: string
}

interface StoredWorkspace {
  readonly id: string
  readonly path: string
  readonly identity: FileIdentity
  readonly firstOpenedAt: number
  readonly lastOpenedAt: number
  readonly previousPaths: readonly string[]
  readonly nativeTrustInvalidated: boolean
}

interface WorkspaceRegistryFile {
  readonly schemaVersion: 1
  readonly workspaces: readonly StoredWorkspace[]
}

interface ActiveWorkspace {
  readonly record: StoredWorkspace
  readonly host: WorkspaceSessionHost
  readonly generation: number
  watcher?: FSWatcher
  disposeRuntime?: () => void | Promise<void>
}

export type WorkspaceSessionHost = Pick<PiSessionHost,
  | 'session'
  | 'runtime'
  | 'services'
  | 'diagnostics'
  | 'prompt'
  | 'abort'
  | 'subscribe'
  | 'subscribeSessionEvents'
  | 'setRuntimeOperations'
  | 'setRuntimeScopeProvider'
  | 'newSession'
  | 'switchSession'
  | 'fork'
  | 'importFromJsonl'
  | 'reload'
  | 'dispose'>

export type WorkspaceSessionHostFactory = (options: CreatePiSessionHostOptions) => Promise<WorkspaceSessionHost>

export type WorkspaceRuntimeOptionsFactory = (
  workspace: WorkspaceInfo,
) => Omit<CreatePiSessionHostOptions, 'cwd' | 'sessionDir' | 'isProjectTrusted' | 'customViewHost' | 'setExtensionUIActiveSession'>
  | Promise<Omit<CreatePiSessionHostOptions, 'cwd' | 'sessionDir' | 'isProjectTrusted' | 'customViewHost' | 'setExtensionUIActiveSession'>>

export interface ActiveWorkspaceRuntime {
  readonly workspace: WorkspaceInfo
  readonly host: WorkspaceSessionHost
  readonly scope: RuntimeScope
  readonly trustDecision: 'trusted' | 'denied' | 'undecided'
}

export interface WorkspaceServiceOptions {
  readonly registryFilePath: string
  readonly trustStore: ProjectTrustStore
  readonly createSessionHost: WorkspaceSessionHostFactory
  readonly setExtensionUIBridge?: (bridge: ExtensionUIBridge | undefined) => void
  readonly sessionDirForWorkspace?: (workspaceId: string, cwd: string) => string
  readonly runtimeOptionsForWorkspace?: WorkspaceRuntimeOptionsFactory
  readonly onRuntimeStarted?: (
    runtime: ActiveWorkspaceRuntime,
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
  readonly ownerId?: string
  readonly now?: () => number
}

const MAX_WORKSPACES = 50
const MAX_PATH_LENGTH = 4096

function isFileIdentity(value: unknown): value is FileIdentity {
  return isPlainRecord(value)
    && hasExactKeys(value, ['device', 'inode'])
    && typeof value.device === 'string'
    && value.device.length <= 128
    && typeof value.inode === 'string'
    && value.inode.length <= 128
}

function isStoredWorkspace(value: unknown): value is StoredWorkspace {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      'id', 'path', 'identity', 'firstOpenedAt', 'lastOpenedAt', 'previousPaths', 'nativeTrustInvalidated',
    ])
    && typeof value.id === 'string'
    && /^[a-f0-9-]{36}$/i.test(value.id)
    && typeof value.path === 'string'
    && value.path.length > 0
    && value.path.length <= MAX_PATH_LENGTH
    && isFileIdentity(value.identity)
    && Number.isSafeInteger(value.firstOpenedAt)
    && (value.firstOpenedAt as number) >= 0
    && Number.isSafeInteger(value.lastOpenedAt)
    && (value.lastOpenedAt as number) >= 0
    && Array.isArray(value.previousPaths)
    && value.previousPaths.length <= 5
    && value.previousPaths.every((path) => typeof path === 'string' && path.length <= MAX_PATH_LENGTH)
    && typeof value.nativeTrustInvalidated === 'boolean'
}

function readIdentity(path: string): { canonicalPath: string; identity: FileIdentity } {
  if (!isAbsolute(path) || path.length > MAX_PATH_LENGTH || path.includes('\0')) {
    throw new TypeError('Workspace path is invalid.')
  }
  let canonicalPath: string
  let directory: boolean
  let device: string
  let inode: string
  try {
    canonicalPath = realpathSync(path)
    const stats = statSync(canonicalPath, { bigint: true })
    directory = stats.isDirectory()
    device = stats.dev.toString()
    inode = stats.ino.toString()
  } catch {
    throw new Error('Workspace directory is unavailable.')
  }
  if (!directory) throw new Error('Workspace path is not a directory.')
  return {
    canonicalPath,
    identity: { device, inode },
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function isWorkspaceRegistryFile(value: unknown): value is WorkspaceRegistryFile {
  return isPlainRecord(value)
    && hasExactKeys(value, ['schemaVersion', 'workspaces'])
    && value.schemaVersion === 1
    && Array.isArray(value.workspaces)
    && value.workspaces.length <= MAX_WORKSPACES
    && value.workspaces.every(isStoredWorkspace)
}

class WorkspaceRegistry {
  readonly filePath: string
  private records: StoredWorkspace[]

  constructor(filePath: string) {
    if (!isAbsolute(filePath) || filePath.includes('\0')) throw new TypeError('Workspace registry path must be absolute.')
    this.filePath = filePath
    this.records = this.read()
  }

  getAll(): StoredWorkspace[] {
    return [...this.records]
  }

  find(id: string): StoredWorkspace | undefined {
    return this.records.find((record) => record.id === id)
  }

  replace(records: readonly StoredWorkspace[]): void {
    this.records = [...records]
      .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
      .slice(0, MAX_WORKSPACES)
    this.write()
  }

  private read(): StoredWorkspace[] {
    if (!existsSync(this.filePath)) return []
    try {
      if (lstatSync(this.filePath).isSymbolicLink()) return []
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      return isWorkspaceRegistryFile(parsed) ? [...parsed.workspaces] : []
    } catch {
      return []
    }
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    try {
      if (lstatSync(this.filePath).isSymbolicLink()) throw new Error('Workspace registry must not be a symbolic link.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify({ schemaVersion: 1, workspaces: this.records }, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      renameSync(temporaryPath, this.filePath)
    } finally {
      rmSync(temporaryPath, { force: true })
    }
  }
}

export class WorkspaceService {
  private readonly registry: WorkspaceRegistry
  private readonly trustStore: ProjectTrustStore
  private readonly createSessionHost: WorkspaceSessionHostFactory
  private readonly setExtensionUIBridge?: WorkspaceServiceOptions['setExtensionUIBridge']
  private readonly sessionDirForWorkspace?: WorkspaceServiceOptions['sessionDirForWorkspace']
  private readonly runtimeOptionsForWorkspace?: WorkspaceRuntimeOptionsFactory
  private readonly onRuntimeStarted?: WorkspaceServiceOptions['onRuntimeStarted']
  private readonly ownerId: string
  private readonly now: () => number
  private readonly listeners = new Set<(payload: WorkspaceEventPayload) => void>()
  private active: ActiveWorkspace | undefined
  private extensionUIBridge: ExtensionUIBridge | undefined
  private pendingRecord: StoredWorkspace | undefined
  private pendingPath: string | null = null
  private runtimeGeneration = 0
  private selectionIntent = 0
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(options: WorkspaceServiceOptions) {
    this.registry = new WorkspaceRegistry(options.registryFilePath)
    this.trustStore = options.trustStore
    this.createSessionHost = options.createSessionHost
    this.setExtensionUIBridge = options.setExtensionUIBridge
    this.sessionDirForWorkspace = options.sessionDirForWorkspace
    this.runtimeOptionsForWorkspace = options.runtimeOptionsForWorkspace
    this.onRuntimeStarted = options.onRuntimeStarted
    this.ownerId = options.ownerId ?? `workspaces-${randomUUID()}`
    this.now = options.now ?? Date.now
  }

  get activeHost(): WorkspaceSessionHost | undefined {
    return this.active?.host
  }

  get activeRuntime(): ActiveWorkspaceRuntime | undefined {
    const active = this.active
    if (!active) return undefined
    return {
      workspace: this.toInfo(active.record),
      host: active.host,
      scope: this.getRuntimeScope(),
      trustDecision: this.trustProvenance(active.record, this.toInfo(active.record).status).decision,
    }
  }

  getRuntimeScope(): RuntimeScope {
    return { ownerId: this.ownerId, generation: this.runtimeGeneration }
  }

  authorizeRuntimeScope(scope: RuntimeScope): boolean {
    return isRuntimeScope(scope)
      && scope.ownerId === this.ownerId
      && scope.generation === this.runtimeGeneration
  }

  isRuntimeTrusted(scope: RuntimeScope): boolean {
    const active = this.active
    return !!active
      && this.authorizeRuntimeScope(scope)
      && active.generation === scope.generation
      && this.isTrustedAt(active.record, active.record.path)
  }

  setActiveRuntimeTrust(scope: RuntimeScope, trusted: boolean): Promise<WorkspaceOperationResult> {
    const active = this.active
    if (!active || !this.authorizeRuntimeScope(scope) || active.generation !== scope.generation) {
      return Promise.reject(new Error('The active workspace trust request is stale.'))
    }
    return this.changeTrust(active.record.id, trusted)
  }

  subscribe(listener: (payload: WorkspaceEventPayload) => void): () => void {
    if (this.disposed) throw new Error('Workspace service has been disposed.')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async list(): Promise<WorkspaceSnapshot> {
    await this.invalidateMissingActiveWorkspace()
    return this.snapshot()
  }

  open(path: string): Promise<WorkspaceOperationResult> {
    this.assertUsable()
    const intent = ++this.selectionIntent
    this.invalidateRuntimeScope()
    this.replaceExtensionUIBridge(undefined)
    const previous = this.detachActive()
    this.pendingRecord = undefined
    this.pendingPath = typeof path === 'string'
      && path.length > 0
      && path.length <= MAX_PATH_LENGTH
      && !path.includes('\0')
      && isAbsolute(path)
      ? path
      : null
    return this.enqueue(async () => {
      await this.disposeActive(previous)
      if (intent !== this.selectionIntent) return this.result('cancelled')
      let opened: ReturnType<typeof readIdentity>
      try {
        opened = readIdentity(path)
      } catch (error) {
        this.pendingRecord = undefined
        this.pendingPath = null
        this.emit('changed')
        throw error
      }
      const record = this.prepareRecord(opened.canonicalPath, opened.identity)
      this.registry.replace([record, ...this.registry.getAll().filter((item) => item.id !== record.id)])
      this.pendingRecord = record
      this.pendingPath = record.path
      return this.startWorkspace(record, intent, 'opened')
    })
  }

  openRecent(workspaceId: string): Promise<WorkspaceOperationResult> {
    this.assertUsable()
    if (typeof workspaceId !== 'string') return Promise.reject(new TypeError('Workspace ID is invalid.'))
    const record = this.registry.find(workspaceId)
    if (!record || !this.isIdentityCurrent(record)) return Promise.resolve(this.result('missing'))
    return this.open(record.path)
  }

  grantTrust(workspaceId: string): Promise<WorkspaceOperationResult> {
    return this.changeTrust(workspaceId, true)
  }

  revokeTrust(workspaceId: string): Promise<WorkspaceOperationResult> {
    return this.changeTrust(workspaceId, false)
  }

  cancel(): Promise<WorkspaceOperationResult> {
    this.assertUsable()
    const intent = ++this.selectionIntent
    this.invalidateRuntimeScope()
    this.replaceExtensionUIBridge(undefined)
    const previous = this.detachActive()
    this.pendingRecord = undefined
    this.pendingPath = null
    return this.enqueue(async () => {
      await this.disposeActive(previous)
      if (intent !== this.selectionIntent) return this.result('cancelled')
      this.emit('cancelled')
      return this.result('closed')
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const intent = ++this.selectionIntent
    this.invalidateRuntimeScope()
    this.replaceExtensionUIBridge(undefined)
    const previous = this.detachActive()
    this.pendingRecord = undefined
    this.pendingPath = null
    await this.enqueue(async () => {
      await this.disposeActive(previous)
      if (intent !== this.selectionIntent) return
      this.listeners.clear()
    })
  }

  private changeTrust(workspaceId: string, trusted: boolean): Promise<WorkspaceOperationResult> {
    this.assertUsable()
    const record = this.registry.find(workspaceId)
    if (!record || !this.isRecordAtCurrentLocation(record)) {
      return Promise.reject(new Error('Workspace is missing or has moved.'))
    }
    if (!trusted) {
      try {
        // Revocation is persisted before any queued runtime disposal.
        this.trustStore.set(record.path, false)
      } catch (error) {
        return Promise.reject(error)
      }
    }
    const pendingPath = this.pendingPath
    let pendingPathMatches = false
    if (pendingPath !== null) {
      try {
        pendingPathMatches = readIdentity(pendingPath).canonicalPath === record.path
      } catch {
        pendingPathMatches = false
      }
    }
    const targetsCurrent = this.active?.record.id === workspaceId
      || this.pendingRecord?.id === workspaceId
      || pendingPathMatches
    const intent = targetsCurrent ? ++this.selectionIntent : this.selectionIntent
    const previous = targetsCurrent ? this.detachActive() : undefined
    if (targetsCurrent) {
      this.invalidateRuntimeScope()
      this.replaceExtensionUIBridge(undefined)
      this.pendingRecord = record
      this.pendingPath = record.path
    }
    return this.enqueue(async () => {
      await this.disposeActive(previous)
      if (!this.isRecordAtCurrentLocation(record)) throw new Error('Workspace is missing or has moved.')
      // Persist the real Pi project-trust decision; this is not an app-only approval flag.
      this.trustStore.set(record.path, trusted)
      if (trusted && record.nativeTrustInvalidated) {
        const updated = { ...record, nativeTrustInvalidated: false }
        this.registry.replace([updated, ...this.registry.getAll().filter((item) => item.id !== updated.id)])
      }
      if (targetsCurrent && intent !== this.selectionIntent) return this.result('cancelled')
      const currentRecord = this.registry.find(workspaceId) ?? record
      if (targetsCurrent) {
        return this.startWorkspace(currentRecord, intent, 'trust-changed', 'trust-updated')
      }
      this.emit('trust-changed')
      return this.result('trust-updated')
    })
  }

  private prepareRecord(path: string, identity: FileIdentity): StoredWorkspace {
    const existing = this.registry.getAll()
    const exact = existing.find((record) => record.path === path)
    const timestamp = Math.max(0, Math.floor(this.now()))
    if (exact && sameIdentity(exact.identity, identity)) {
      return { ...exact, lastOpenedAt: timestamp }
    }
    if (exact) {
      const trustInvalidated = this.hasExactNativeGrant(path)
      if (trustInvalidated) this.trustStore.set(path, false)
      return {
        id: randomUUID(),
        path,
        identity,
        firstOpenedAt: timestamp,
        lastOpenedAt: timestamp,
        previousPaths: [],
        nativeTrustInvalidated: trustInvalidated,
      }
    }
    const moved = existing.find((record) => sameIdentity(record.identity, identity))
    if (moved) {
      return {
        ...moved,
        path,
        identity,
        lastOpenedAt: timestamp,
        previousPaths: [moved.path, ...moved.previousPaths.filter((previousPath) => previousPath !== path)].slice(0, 5),
        nativeTrustInvalidated: false,
      }
    }
    return {
      id: randomUUID(),
      path,
      identity,
      firstOpenedAt: timestamp,
      lastOpenedAt: timestamp,
      previousPaths: [],
      nativeTrustInvalidated: false,
    }
  }

  private hasExactNativeGrant(path: string): boolean {
    const entry = this.trustStore.getEntry(path)
    return entry?.path === path && entry.decision
  }

  private async startWorkspace(
    record: StoredWorkspace,
    intent: number,
    reason: 'opened' | 'trust-changed',
    outcome: WorkspaceOperationResult['outcome'] = 'opened',
  ): Promise<WorkspaceOperationResult> {
    if (intent !== this.selectionIntent || this.disposed) return this.result('cancelled')
    this.pendingRecord = record
    this.pendingPath = record.path
    const trustedAtStart = this.isTrustedAt(record, record.path)
    const extensionUIBridge = createExtensionUIBridge(this.getRuntimeScope())
    let host: WorkspaceSessionHost
    try {
      this.replaceExtensionUIBridge(extensionUIBridge)
      this.emit('switching')
      const extra = await this.runtimeOptionsForWorkspace?.(this.toInfo(record)) ?? {}
      const sessionDir = this.sessionDirForWorkspace?.(record.id, record.path)
      host = await this.createSessionHost({
        ...extra,
        cwd: record.path,
        ...(sessionDir ? { sessionDir } : {}),
        extensionBindings: {
          ...(extra.extensionBindings ?? {}),
          ...extensionUIBridge.extensionBindings,
        },
        customViewHost: extensionUIBridge.customViewHost,
        setExtensionUIActiveSession: extensionUIBridge.setActiveSession,
        isProjectTrusted: (cwd) => trustedAtStart && this.isTrustedAt(record, cwd),
      })
    } catch (error) {
      if (this.extensionUIBridge === extensionUIBridge) this.replaceExtensionUIBridge(undefined)
      else extensionUIBridge.dispose()
      if (this.pendingRecord?.id === record.id && intent === this.selectionIntent) {
        this.pendingRecord = undefined
        this.pendingPath = null
        this.emit('changed')
      }
      throw error
    }
    if (intent !== this.selectionIntent || this.disposed || !this.isTrustedBoundaryCurrent(record, trustedAtStart)) {
      await host.dispose()
      if (this.extensionUIBridge === extensionUIBridge) this.replaceExtensionUIBridge(undefined)
      else extensionUIBridge.dispose()
      if (intent === this.selectionIntent && !this.disposed) {
        this.pendingRecord = undefined
        this.pendingPath = null
        this.emit('missing')
      }
      return this.result('cancelled')
    }
    const active: ActiveWorkspace = { record, host, generation: this.runtimeGeneration }
    this.active = active
    const workspace = this.toInfo(record)
    try {
      active.disposeRuntime = await this.onRuntimeStarted?.({
        workspace,
        host,
        scope: this.getRuntimeScope(),
        trustDecision: this.trustProvenance(record, workspace.status).decision,
      }) ?? undefined
    } catch (error) {
      if (this.active === active) this.active = undefined
      await this.disposeActive(active)
      if (this.extensionUIBridge === extensionUIBridge) this.replaceExtensionUIBridge(undefined)
      throw error
    }
    if (intent !== this.selectionIntent || this.disposed || this.active !== active
      || !this.isTrustedBoundaryCurrent(record, trustedAtStart)) {
      if (this.active === active) this.active = undefined
      await this.disposeActive(active)
      if (this.extensionUIBridge === extensionUIBridge) this.replaceExtensionUIBridge(undefined)
      if (intent === this.selectionIntent && !this.disposed) {
        this.pendingRecord = undefined
        this.pendingPath = null
        this.emit('missing')
      }
      return this.result('cancelled')
    }
    this.registry.replace([record, ...this.registry.getAll().filter((item) => item.id !== record.id)])
    this.pendingRecord = undefined
    this.pendingPath = null
    this.watchWorkspace(active)
    this.emit(reason)
    return this.result(outcome)
  }

  private isTrustedAt(record: StoredWorkspace, cwd: string): boolean {
    if (record.nativeTrustInvalidated || resolve(cwd) !== record.path || !this.isIdentityCurrent(record)) return false
    try {
      return this.trustStore.get(record.path) === true
    } catch {
      return false
    }
  }

  private isTrustedBoundaryCurrent(record: StoredWorkspace, trustedAtStart: boolean): boolean {
    return this.isIdentityCurrent(record) && this.isTrustedAt(record, record.path) === trustedAtStart
  }

  private isIdentityCurrent(record: StoredWorkspace): boolean {
    try {
      const current = readIdentity(record.path)
      return current.canonicalPath === record.path && sameIdentity(current.identity, record.identity)
    } catch {
      return false
    }
  }

  private isRecordAtCurrentLocation(record: StoredWorkspace): boolean {
    return this.isIdentityCurrent(record)
  }

  private toInfo(record: StoredWorkspace): WorkspaceInfo {
    let status: WorkspaceInfo['status'] = 'missing'
    if (this.isIdentityCurrent(record)) status = record.previousPaths.length > 0 ? 'moved' : 'available'
    return {
      id: record.id,
      path: record.path,
      name: basename(record.path) || record.path,
      status,
      firstOpenedAt: record.firstOpenedAt,
      lastOpenedAt: record.lastOpenedAt,
      movedFrom: record.previousPaths[0] ?? null,
      trust: this.trustProvenance(record, status),
    }
  }

  private trustProvenance(record: StoredWorkspace, status: WorkspaceInfo['status']): Omit<WorkspaceTrustProvenance, 'decision'> & { decision: 'trusted' | 'denied' | 'undecided' } {
    if (record.nativeTrustInvalidated) {
      return {
        decision: 'undecided',
        sourcePath: record.path,
        inherited: false,
        requiresReapproval: true,
      }
    }
    if (status === 'missing') {
      return { decision: 'undecided', sourcePath: null, inherited: false, requiresReapproval: false }
    }
    try {
      const entry = this.trustStore.getEntry(record.path)
      return {
        decision: entry ? entry.decision ? 'trusted' : 'denied' : 'undecided',
        sourcePath: entry?.path ?? null,
        inherited: !!entry && entry.path !== record.path,
        requiresReapproval: false,
      }
    } catch {
      return { decision: 'undecided', sourcePath: null, inherited: false, requiresReapproval: true }
    }
  }

  private snapshot(): WorkspaceSnapshot {
    return {
      generation: this.runtimeGeneration,
      runtimeScope: this.getRuntimeScope(),
      activeWorkspaceId: this.active?.record.id ?? null,
      pendingPath: this.pendingPath,
      workspaces: this.registry.getAll().map((record) => this.toInfo(record)),
    }
  }

  private result(outcome: WorkspaceOperationResult['outcome']): WorkspaceOperationResult {
    return { outcome, snapshot: this.snapshot() }
  }

  private emit(reason: WorkspaceEventPayload['reason']): void {
    const payload: WorkspaceEventPayload = { reason, snapshot: this.snapshot() }
    for (const listener of this.listeners) {
      try {
        listener(payload)
      } catch {
        // Workspace observers cannot disrupt the main-owned runtime lifecycle.
      }
    }
  }

  private invalidateRuntimeScope(): void {
    if (this.runtimeGeneration >= Number.MAX_SAFE_INTEGER) throw new Error('Workspace generation limit reached.')
    this.runtimeGeneration += 1
  }

  private detachActive(): ActiveWorkspace | undefined {
    const active = this.active
    this.active = undefined
    active?.watcher?.close()
    return active
  }

  private async disposeActive(active: ActiveWorkspace | undefined): Promise<void> {
    if (!active) return
    const disposeRuntime = active.disposeRuntime
    active.disposeRuntime = undefined
    try {
      await disposeRuntime?.()
    } finally {
      await active.host.dispose()
    }
  }

  private async invalidateMissingActiveWorkspace(): Promise<void> {
    const active = this.active
    if (!active || this.isIdentityCurrent(active.record)) return
    this.selectionIntent += 1
    this.invalidateRuntimeScope()
    this.replaceExtensionUIBridge(undefined)
    this.detachActive()
    await this.enqueue(async () => {
      await this.disposeActive(active)
      this.emit('missing')
    })
  }

  private watchWorkspace(active: ActiveWorkspace): void {
    try {
      active.watcher = watch(dirname(active.record.path), { persistent: false }, (_event, filename) => {
        if (filename && filename.toString() !== basename(active.record.path)) return
        if (this.active !== active || active.generation !== this.runtimeGeneration || this.isIdentityCurrent(active.record)) return
        const intent = ++this.selectionIntent
        this.invalidateRuntimeScope()
        this.replaceExtensionUIBridge(undefined)
        this.detachActive()
        this.pendingPath = null
        void this.enqueue(async () => {
          await this.disposeActive(active)
          if (intent === this.selectionIntent) this.emit('missing')
        })
      })
      active.watcher.on('error', () => {
        if (this.active === active && !this.isIdentityCurrent(active.record)) {
          const intent = ++this.selectionIntent
          this.invalidateRuntimeScope()
          this.replaceExtensionUIBridge(undefined)
          this.detachActive()
          void this.enqueue(async () => {
            await this.disposeActive(active)
            if (intent === this.selectionIntent) this.emit('missing')
          })
        }
      })
    } catch {
      // List/switch validation remains authoritative when filesystem watching is unavailable.
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private replaceExtensionUIBridge(bridge: ExtensionUIBridge | undefined): void {
    if (this.extensionUIBridge === bridge) return
    const previous = this.extensionUIBridge
    this.extensionUIBridge = bridge
    try {
      this.setExtensionUIBridge?.(bridge)
    } finally {
      previous?.dispose()
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Workspace service has been disposed.')
  }
}
