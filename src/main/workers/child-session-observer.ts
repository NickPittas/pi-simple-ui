import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SessionManager, type SessionEntry, type JSONValue } from '@earendil-works/pi-coding-agent'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { HerdrAgentReportRequest } from '../herdr/transport.ts'
import type { HerdrLaunchAgentSpec, LaunchScopeDescriptor } from '../../shared/launch.ts'
import type {
  HerdrWorkerDetails,
  WorkerAbortRequest,
  WorkerAbortResponse,
  WorkerControlResponse,
  WorkerEvent,
  WorkerResumeRequest,
  WorkerResumeResponse,
  WorkerSteerRequest,
  WorkerSteerResponse,
  WorkerSummary,
  WorkerStatus,
} from '../../shared/workers.ts'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'
import type { WorkerControlHandler } from './worker-controls.ts'
import type { WorkerRegistry } from './worker-registry.ts'
import { toWorkerJson } from './worker-events.ts'

const MAX_SESSION_HEADER_BYTES = 64 * 1024
const MAX_SESSION_TAIL_BYTES = 4 * 1024 * 1024
const MAX_SESSION_LINE_BYTES = 1024 * 1024
const MAX_SNAPSHOT_MESSAGES = 1_000
const MAX_SESSION_ID_LENGTH = 256
const MAX_CHILD_LAUNCHES = 2_000

export interface HerdrChildLaunchRegistration {
  readonly tokenId: string
  readonly childPid?: number
  readonly agentSpec: HerdrLaunchAgentSpec
  readonly parentWorkerId?: string
  readonly launchScope: LaunchScopeDescriptor
  readonly persistent?: boolean
  readonly name?: string
}

export interface HerdrNativeControlPort {
  /** Maps only to pi-herdr-agents' persistent-idle `subagent_send` operation. */
  readonly sendPersistentTask?: (input: { readonly paneId: string; readonly message: string }) => boolean | Promise<boolean>
  /** Maps only to pi-herdr-agents' graceful persistent `subagent_stop` operation. */
  readonly stopPersistent?: (input: { readonly paneId: string }) => boolean | Promise<boolean>
  /** Maps to `subagent_interrupt`, which sends Escape but does not terminate the process. */
  readonly interruptSubagent?: (input: { readonly paneId: string }) => boolean | Promise<boolean>
  /** Maps to pi-herdr-agents' `subagent_resume` operation using the native session file. */
  readonly resumeSession?: (input: { readonly sessionFile: string; readonly message: string }) => boolean | Promise<boolean>
}

export interface HerdrChildSessionObserverOptions {
  readonly registry: WorkerRegistry
  readonly scope: RuntimeScope
  readonly nativeControls?: HerdrNativeControlPort
  readonly pollIntervalMs?: number
  readonly now?: () => number
  /** The caller must identify the exact Pi process, not the pane shell PID. */
  readonly isChildProcessAlive?: (pid: number) => boolean
}

interface SessionHeader {
  readonly id: string
  readonly cwd: string
}

interface SessionMessage {
  readonly id: string
  readonly timestamp: number
  readonly message: JSONValue
}

interface SessionTail {
  readonly size: number
  readonly modifiedAt: number
  readonly messages: readonly SessionMessage[]
}

interface ChildLaunchRecord {
  readonly tokenId: string
  readonly workerId: string
  readonly agentSpec: HerdrLaunchAgentSpec
  readonly launchScope: LaunchScopeDescriptor
  readonly parentWorkerId: string | undefined
  readonly persistent: boolean
  readonly sessionPath: string
  readonly paneId: string
  readonly startedAt: number
  readonly seenMessageIds: Set<string>
  readonly messages: SessionMessage[]
  lastReportSequence: number
  ancestry: readonly string[]
  rootId: string
  name: string
  childPid: number | undefined
  nativeState: 'working' | 'blocked' | 'idle' | null
  nativeStateMessage: string | null
  reportedSessionId: string | undefined
  sessionId: string | undefined
  lastTail: SessionTail | undefined
  transcript: HerdrWorkerDetails['transcript']
  lifetime: HerdrWorkerDetails['lifetime']
  detached: boolean
  processExited: boolean
  summaryStatus: WorkerStatus
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return left.ownerId === right.ownerId && left.generation === right.generation
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function canonicalDirectory(path: string): string {
  const canonical = realpathSync(path)
  if (!statSync(canonical).isDirectory()) throw new Error('Herdr child observation root is not a directory.')
  return canonical
}

function canonicalSessionPath(path: string, roots: readonly string[]): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Herdr session path is invalid.')
  const resolved = resolve(path)
  let canonical: string
  if (existsSync(resolved)) {
    canonical = realpathSync(resolved)
    if (!statSync(canonical).isFile()) throw new Error('Herdr session target is not a file.')
  } else {
    const parent = realpathSync(dirname(resolved))
    if (!statSync(parent).isDirectory()) throw new Error('Herdr session directory is unavailable.')
    canonical = join(parent, basename(resolved))
  }
  if (!roots.some((root) => isWithin(root, canonical))) {
    throw new Error('Herdr session path is outside the launch scope.')
  }
  return canonical
}

function readSessionHeader(path: string, workspaceRoot: string): SessionHeader | undefined {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return undefined
  }
  try {
    const buffer = Buffer.alloc(MAX_SESSION_HEADER_BYTES)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
    if (newline < 0) return undefined
    let value: unknown
    try {
      value = JSON.parse(buffer.subarray(0, newline).toString('utf8'))
    } catch {
      return undefined
    }
    if (!isRecord(value) || value.type !== 'session'
      || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > MAX_SESSION_ID_LENGTH
      || typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) return undefined
    const cwd = canonicalDirectory(value.cwd)
    if (!isWithin(workspaceRoot, cwd)) return undefined
    return { id: value.id, cwd }
  } finally {
    closeSync(fd)
  }
}

function readSessionTail(path: string): SessionTail | undefined {
  let fd: number
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(path)
    if (!stats.isFile()) return undefined
    fd = openSync(path, 'r')
  } catch {
    return undefined
  }
  try {
    const start = Math.max(0, stats.size - MAX_SESSION_TAIL_BYTES)
    const buffer = Buffer.alloc(stats.size - start)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start)
    let tail = buffer.subarray(0, bytesRead).toString('utf8')
    if (start > 0) {
      const firstNewline = tail.indexOf('\n')
      if (firstNewline < 0) tail = ''
      else tail = tail.slice(firstNewline + 1)
    }
    const messages: SessionMessage[] = []
    let lineIndex = 0
    for (const line of tail.split(/\r?\n/)) {
      if (!line || Buffer.byteLength(line, 'utf8') > MAX_SESSION_LINE_BYTES) continue
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(entry)) continue
      if (entry.type !== 'message' || !isRecord(entry.message)) continue
      const id = typeof entry.id === 'string' && entry.id.length > 0
        ? entry.id
        : `line-${start}-${lineIndex}`
      const parsedTimestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
      messages.push({
        id,
        timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : stats.mtimeMs,
        message: toWorkerJson(entry.message),
      })
      lineIndex += 1
    }
    return {
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      messages: messages.slice(-MAX_SNAPSHOT_MESSAGES),
    }
  } finally {
    closeSync(fd)
  }
}

/** Read the complete active native conversation branch for workers.snapshot. */
function readNativeConversation(path: string, expectedSessionId: string): readonly SessionMessage[] | undefined {
  try {
    const manager = SessionManager.open(path)
    if (manager.getSessionId() !== expectedSessionId) return undefined
    const entries = manager.getEntries()
    const byId = new Map<string, SessionEntry>()
    for (const entry of entries) {
      if (entry.id && !byId.has(entry.id)) byId.set(entry.id, entry)
    }
    const branch: SessionEntry[] = []
    const visited = new Set<string>()
    let entryId = manager.getLeafId()
    while (entryId && !visited.has(entryId) && branch.length <= entries.length) {
      visited.add(entryId)
      const entry = byId.get(entryId)
      if (!entry) break
      branch.push(entry)
      entryId = entry.parentId
    }
    branch.reverse()
    return branch.flatMap((entry) => entry.type === 'message'
      ? [{
          id: entry.id,
          timestamp: Date.parse(entry.timestamp) || 0,
          message: toWorkerJson(entry.message),
        }]
      : [])
  } catch {
    return undefined
  }
}

function statusFor(record: ChildLaunchRecord): WorkerStatus {
  if (record.processExited) return record.nativeState === 'idle' ? 'completed' : 'aborted'
  if (record.nativeState === 'blocked') return 'blocked-wait'
  if (record.nativeState === 'idle') return 'idle'
  return 'running'
}

function controlAvailability(
  record: ChildLaunchRecord,
  controls: HerdrNativeControlPort | undefined,
): HerdrWorkerDetails['controls'] {
  const steerReason = !record.persistent
    ? 'Herdr subagent_send is available only for persistent specialists.'
    : record.nativeState !== 'idle'
      ? 'Herdr subagent_send accepts persistent specialists only while idle.'
      : controls?.sendPersistentTask
        ? undefined
        : 'No app-local bridge to Herdr subagent_send is wired.'
  const abortReason = record.persistent
    ? controls?.stopPersistent
      ? undefined
      : 'Herdr subagent_stop exists for persistent specialists, but no app-local bridge is wired.'
    : controls?.interruptSubagent
      ? undefined
      : 'Herdr subagent_interrupt exists, but no app-local bridge is wired; it sends Escape and does not terminate the process.'
  const resumeReason = record.persistent
    ? 'Herdr persistent sessions cannot be resumed; use subagent_send or create a replacement.'
    : !record.processExited
      ? 'Herdr subagent_resume is for a previous session, not a live child.'
      : controls?.resumeSession
        ? undefined
        : 'No app-local bridge to Herdr subagent_resume is wired.'
  return {
    steer: steerReason ? { available: false, reason: steerReason } : { available: true },
    abort: abortReason ? { available: false, reason: abortReason } : { available: true },
    resume: resumeReason ? { available: false, reason: resumeReason } : { available: true },
  }
}

function makeDetails(
  record: ChildLaunchRecord,
  controls: HerdrNativeControlPort | undefined,
): HerdrWorkerDetails {
  return {
    paneId: record.paneId,
    kind: record.agentSpec.kind,
    nativeState: record.nativeState,
    nativeSessionId: record.sessionId ?? record.reportedSessionId ?? null,
    nativeSessionPath: record.sessionPath,
    nativeStateMessage: record.nativeStateMessage,
    detached: record.detached,
    persistent: record.persistent,
    lifetime: record.lifetime,
    transcript: record.transcript,
    childPid: record.childPid ?? null,
    controls: controlAvailability(record, controls),
  }
}

function reportReference(report: HerdrAgentReportRequest): {
  readonly paneId: string
  readonly sequence: number
  readonly sessionPath?: string
  readonly sessionId?: string
  readonly state?: 'working' | 'blocked' | 'idle'
  readonly message?: string
} | undefined {
  if (!isRecord(report) || !isRecord(report.params)) return undefined
  const params = report.params
  if (params.source !== 'herdr:pi' || params.agent !== 'pi'
    || typeof params.pane_id !== 'string' || params.pane_id.length === 0 || params.pane_id.length > 256
    || !Number.isSafeInteger(params.seq) || params.seq < 0) return undefined
  const sessionPath = typeof params.agent_session_path === 'string' ? params.agent_session_path : undefined
  const sessionId = typeof params.agent_session_id === 'string' ? params.agent_session_id : undefined
  if ((!sessionPath && !sessionId) || (sessionPath && (!isAbsolute(sessionPath) || sessionPath.length > 4_096))
    || (sessionId && (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH))) return undefined
  if (report.method === 'pane.report_agent_session') {
    return { paneId: params.pane_id, sequence: params.seq, ...(sessionPath ? { sessionPath } : {}), ...(sessionId ? { sessionId } : {}) }
  }
  if (report.method === 'pane.report_agent'
    && (params.state === 'working' || params.state === 'blocked' || params.state === 'idle')) {
    return {
      paneId: params.pane_id,
      sequence: params.seq,
      ...(sessionPath ? { sessionPath } : {}),
      ...(sessionId ? { sessionId } : {}),
      state: params.state,
      ...(typeof params.message === 'string' ? { message: params.message.slice(0, 1_000) } : {}),
    }
  }
  return undefined
}

function reportSessionPath(record: ChildLaunchRecord, path: string): boolean {
  try {
    const roots = [
      canonicalDirectory(record.launchScope.workspaceRoot),
      canonicalDirectory(record.launchScope.agentDir),
      canonicalDirectory(record.launchScope.targetAgentDir),
    ]
    return canonicalSessionPath(path, roots) === record.sessionPath
  } catch {
    return false
  }
}

function sessionPathIsAuthorized(record: ChildLaunchRecord): boolean {
  try {
    const roots = [
      canonicalDirectory(record.launchScope.workspaceRoot),
      canonicalDirectory(record.launchScope.agentDir),
      canonicalDirectory(record.launchScope.targetAgentDir),
    ]
    return canonicalSessionPath(record.sessionPath, roots) === record.sessionPath
  } catch {
    return false
  }
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Correlates the launch capability's pane with Herdr's session-reference/state
 * reports and the native Pi JSONL session. It never owns or kills child panes.
 */
export class HerdrChildSessionObserver implements WorkerControlHandler {
  readonly controlHandler: WorkerControlHandler = this
  private readonly registry: WorkerRegistry
  private readonly scope: RuntimeScope
  private readonly controls: HerdrNativeControlPort | undefined
  private readonly now: () => number
  private readonly isChildProcessAlive: (pid: number) => boolean
  private readonly records = new Map<string, ChildLaunchRecord>()
  private readonly recordsByWorkerId = new Map<string, ChildLaunchRecord>()
  private readonly recordsByPane = new Map<string, Set<ChildLaunchRecord>>()
  private readonly recordsBySessionPath = new Map<string, Set<ChildLaunchRecord>>()
  private readonly recordsBySessionId = new Map<string, Set<ChildLaunchRecord>>()
  private readonly poll: ReturnType<typeof setInterval>
  private disposed = false

  constructor(options: HerdrChildSessionObserverOptions) {
    this.registry = options.registry
    this.scope = Object.freeze({ ...options.scope })
    this.controls = options.nativeControls
    this.now = options.now ?? Date.now
    this.isChildProcessAlive = options.isChildProcessAlive ?? defaultPidAlive
    const interval = Math.max(250, Math.min(10_000, options.pollIntervalMs ?? 1_000))
    this.poll = setInterval(() => this.refresh(), interval)
    this.poll.unref?.()
  }

  registerLaunch(input: HerdrChildLaunchRegistration): string {
    if (this.disposed || !this.registry.isCurrentScope(this.scope)
      || !sameScope(input.launchScope.runtimeScope, this.scope)) {
      throw new Error('Herdr child observation scope is no longer current.')
    }
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(input.tokenId)
      || input.launchScope.trustDecision !== 'trusted'
      || this.records.size >= MAX_CHILD_LAUNCHES
      || (input.childPid !== undefined && (!Number.isSafeInteger(input.childPid) || input.childPid <= 0))
      || this.records.has(input.tokenId)) {
      throw new Error('Herdr child launch identity is invalid or already registered.')
    }

    const workspaceRoot = canonicalDirectory(input.launchScope.workspaceRoot)
    const allowedRoots = [
      workspaceRoot,
      canonicalDirectory(input.launchScope.agentDir),
      canonicalDirectory(input.launchScope.targetAgentDir),
    ]
    const sessionPath = canonicalSessionPath(input.agentSpec.sessionFile!, allowedRoots)
    const idHash = createHash('sha256')
      .update(JSON.stringify([this.scope.ownerId, this.scope.generation]))
      .digest('hex')
      .slice(0, 12)
    let workerId = `herdr:${idHash}:${input.tokenId}`
    while (this.registry.snapshot(workerId) || this.recordsByWorkerId.has(workerId)) {
      workerId = `herdr:${idHash}:${input.tokenId}:${randomUUID().slice(0, 8)}`
    }
    const parent = input.parentWorkerId ? this.registry.snapshot(input.parentWorkerId) : null
    const record: ChildLaunchRecord = {
      tokenId: input.tokenId,
      workerId,
      agentSpec: input.agentSpec,
      launchScope: input.launchScope,
      parentWorkerId: parent ? input.parentWorkerId : undefined,
      persistent: input.persistent === true,
      sessionPath,
      paneId: input.agentSpec.herdrPaneId,
      startedAt: input.launchScope.issuedAt,
      seenMessageIds: new Set(),
      messages: [],
      lastReportSequence: -1,
      ancestry: parent ? [...parent.ancestry, parent.summary.id] : [],
      rootId: parent?.summary.rootId ?? workerId,
      name: input.name?.slice(0, 512) || `Herdr ${input.agentSpec.kind} child`,
      childPid: input.childPid,
      nativeState: null,
      nativeStateMessage: null,
      reportedSessionId: undefined,
      sessionId: undefined,
      lastTail: undefined,
      transcript: 'unavailable',
      lifetime: input.childPid ? 'process-alive' : 'launch-issued',
      detached: false,
      processExited: false,
      summaryStatus: 'running',
    }
    this.records.set(input.tokenId, record)
    this.recordsByWorkerId.set(workerId, record)
    this.addIndex(this.recordsByPane, record.paneId, record)
    this.addIndex(this.recordsBySessionPath, record.sessionPath, record)
    const registryState = this.registry.list().providerState
    if (registryState === 'provider-unavailable') this.registry.setProviderState('partial')
    this.refreshRecord(record, true)
    return workerId
  }

  /** The host may attach a PID only after identifying the actual Pi child process. */
  attachChildPid(tokenId: string, childPid: number): boolean {
    const record = this.records.get(tokenId)
    if (!record || !Number.isSafeInteger(childPid) || childPid <= 0) return false
    record.childPid = childPid
    record.lifetime = 'process-alive'
    this.upsert(record)
    return true
  }

  /**
   * Feed validated messages received from pane.report_agent_session or
   * pane.report_agent. Herdr's transport is outbound-only; the parent must route
   * its incoming protocol callback to this method.
   */
  receiveReport(request: HerdrAgentReportRequest): boolean {
    if (this.disposed || !this.registry.isCurrentScope(this.scope)) return false
    const reference = reportReference(request)
    if (!reference) return false
    let candidates = this.recordsByPane.get(reference.paneId)
    if (candidates && reference.sessionPath) {
      candidates = new Set([...candidates].filter((record) => reportSessionPath(record, reference.sessionPath!)))
    } else if (candidates && reference.sessionId) {
      candidates = new Set([...candidates].filter((record) =>
        record.sessionId === reference.sessionId || record.reportedSessionId === reference.sessionId))
    }
    if (!candidates?.size && reference.sessionPath) {
      candidates = new Set([...this.records.values()].filter((record) => reportSessionPath(record, reference.sessionPath!)))
    }
    if (!candidates?.size && reference.sessionId) candidates = this.recordsBySessionId.get(reference.sessionId)
    if (!candidates || candidates.size !== 1) return false
    const record = candidates.values().next().value as ChildLaunchRecord | undefined
    if (!record) return false
    if (reference.sequence <= record.lastReportSequence) return false
    if (reference.sessionPath && !reportSessionPath(record, reference.sessionPath)) return false
    if (reference.sessionId && record.sessionId && reference.sessionId !== record.sessionId) return false
    record.lastReportSequence = reference.sequence
    if (reference.sessionId) record.reportedSessionId = reference.sessionId
    if (reference.sessionPath || reference.sessionId) record.lifetime = 'session-observed'
    if (reference.state) {
      record.nativeState = reference.state
      record.nativeStateMessage = reference.message ?? null
    }
    this.reconcileIdentity(record)
    this.upsert(record)
    if (reference.state) {
      this.registry.appendEvent({
        workerId: record.workerId,
        type: 'session-event',
        timestamp: this.now(),
        event: toWorkerJson({ source: 'herdr-reporter', state: reference.state, message: reference.message ?? null }),
      })
    }
    return true
  }

  workerIdForPane(paneId: string): string | undefined {
    const records = this.recordsByPane.get(paneId)
    return records?.size === 1 ? records.values().next().value?.workerId : undefined
  }

  /** Mark children detached without sending stop/interrupt or closing their panes. */
  detachParent(parentWorkerId: string): void {
    for (const record of this.records.values()) {
      if (record.parentWorkerId === parentWorkerId || record.ancestry.includes(parentWorkerId)) {
        record.detached = true
        this.upsert(record)
      }
    }
  }

  /** Parent shutdown is bookkeeping only: detached Herdr children remain alive. */
  detachAll(): void {
    for (const record of this.records.values()) {
      record.detached = true
      this.upsert(record)
    }
  }

  refresh(): void {
    if (this.disposed || !this.registry.isCurrentScope(this.scope)) return
    for (const record of this.records.values()) {
      if (record.parentWorkerId) {
        const parentStatus = this.registry.snapshot(record.parentWorkerId)?.summary.status
        if (parentStatus === 'completed' || parentStatus === 'failed' || parentStatus === 'aborted') {
          record.detached = true
        }
      }
      this.refreshRecord(record, false)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.detachAll()
    this.disposed = true
    clearInterval(this.poll)
    this.records.clear()
    this.recordsByWorkerId.clear()
    this.recordsByPane.clear()
    this.recordsBySessionPath.clear()
    this.recordsBySessionId.clear()
    // Deliberately do not signal child processes or close Herdr panes.
  }

  steer(
    _caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    request: WorkerSteerRequest,
  ): Promise<WorkerSteerResponse> {
    return this.control(scope, request.workerId, 'steer', request.message)
  }

  abort(
    _caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    request: WorkerAbortRequest,
  ): Promise<WorkerAbortResponse> {
    return this.control(scope, request.workerId, 'abort')
  }

  resume(
    _caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    request: WorkerResumeRequest,
  ): Promise<WorkerResumeResponse> {
    return this.control(scope, request.workerId, 'resume', request.message)
  }

  private async control(
    scope: RuntimeScope,
    workerId: string,
    operation: 'steer' | 'abort' | 'resume',
    message = '',
  ): Promise<WorkerControlResponse> {
    if (!sameScope(scope, this.scope) || !this.registry.isCurrentScope(scope)) {
      return { accepted: false, reason: 'operation-cancelled' }
    }
    const record = this.recordsByWorkerId.get(workerId)
    if (!record) return { accepted: false, reason: 'worker-not-observed' }
    const availability = controlAvailability(record, this.controls)[operation]
    if (!availability.available) {
      return { accepted: false, reason: 'control-unavailable', error: availability.reason }
    }
    try {
      const accepted = operation === 'steer'
        ? await this.controls?.sendPersistentTask?.({ paneId: record.paneId, message })
        : operation === 'abort'
          ? record.persistent
            ? await this.controls?.stopPersistent?.({ paneId: record.paneId })
            : await this.controls?.interruptSubagent?.({ paneId: record.paneId })
          : await this.controls?.resumeSession?.({ sessionFile: record.sessionPath, message })
      return accepted
        ? { accepted: true }
        : { accepted: false, reason: 'operation-failed', error: 'The native Herdr operation was not accepted.' }
    } catch (error) {
      const message = error instanceof Error ? error.message.split(/[\r\n]/, 1)[0] : 'Native Herdr operation failed.'
      return { accepted: false, reason: 'operation-failed', error: message.slice(0, 1_000) }
    }
  }

  private refreshRecord(record: ChildLaunchRecord, force: boolean): void {
    if (record.processExited) return
    this.upsert(record)
    if (record.childPid !== undefined) {
      let alive = false
      try {
        alive = this.isChildProcessAlive(record.childPid)
      } catch {
        alive = true
      }
      if (alive) record.lifetime = 'process-alive'
      else {
        record.lifetime = 'process-exited'
        record.processExited = true
      }
    }

    if (!sessionPathIsAuthorized(record)) {
      record.nativeStateMessage = 'The native session file is no longer within the launch scope.'
      record.summaryStatus = statusFor(record)
      this.upsert(record)
      return
    }

    const tail = readSessionTail(record.sessionPath)
    const changed = tail !== undefined
      && (force || !record.lastTail || tail.size !== record.lastTail.size || tail.modifiedAt !== record.lastTail.modifiedAt)
    if (tail && changed) {
      const header = readSessionHeader(record.sessionPath, record.launchScope.workspaceRoot)
      const identityMatches = header !== undefined
        && header.cwd === record.launchScope.targetCwd
        && (record.reportedSessionId === undefined || record.reportedSessionId === header.id)
      if (!identityMatches || !header) {
        record.nativeState = null
        record.nativeStateMessage = 'Herdr report did not match the authorized native session identity.'
        record.reportedSessionId = undefined
      } else {
        const conversation = readNativeConversation(record.sessionPath, header.id)
        if (conversation) {
          record.sessionId = header.id
          record.lifetime = record.processExited ? 'process-exited' : 'session-observed'
          this.addIndex(this.recordsBySessionId, header.id, record)
          this.reconcileIdentity(record)
          record.messages.splice(0, record.messages.length, ...conversation)

          const firstRead = record.lastTail === undefined
          const activeMessageIds = new Set(conversation.map((message) => message.id))
          const priorIds = new Set(record.seenMessageIds)
          for (const message of tail.messages) {
            if (priorIds.has(message.id) || !activeMessageIds.has(message.id)) continue
            this.registry.appendEvent({
              workerId: record.workerId,
              type: 'message-ended',
              timestamp: message.timestamp || this.now(),
              message: message.message,
            })
            record.seenMessageIds.add(message.id)
          }
          record.lastTail = tail
          record.transcript = firstRead ? 'file-restored' : 'file-live'
          this.registry.replaceMessages(record.workerId, record.messages.map((item) => item.message))
        } else {
          record.nativeStateMessage = 'The authorized native session file could not be read.'
        }
      }
    }
    record.summaryStatus = statusFor(record)
    this.upsert(record)
    if (record.processExited) {
      this.registry.appendEvent({
        workerId: record.workerId,
        type: 'agent-ended',
        timestamp: this.now(),
        details: toWorkerJson({ lifetime: record.lifetime, nativeState: record.nativeState }),
      })
    }
  }

  private reconcileIdentity(record: ChildLaunchRecord): void {
    if (record.sessionId) {
      const matches = this.recordsBySessionId.get(record.sessionId)
      if (!matches) this.addIndex(this.recordsBySessionId, record.sessionId, record)
    }
    if (record.reportedSessionId && record.sessionId && record.reportedSessionId !== record.sessionId) {
      record.nativeStateMessage = 'Herdr session id did not match the authorized native session file.'
      record.nativeState = null
    }
  }

  private upsert(record: ChildLaunchRecord): void {
    record.summaryStatus = statusFor(record)
    const details = makeDetails(record, this.controls)
    const summary: WorkerSummary = {
      id: record.workerId,
      parentId: record.parentWorkerId ?? null,
      rootId: record.rootId,
      name: record.name,
      type: 'herdr-child',
      description: `${record.agentSpec.kind} Pi child in Herdr pane ${record.paneId}`,
      status: record.summaryStatus,
      model: null,
      startedAt: record.startedAt,
      completedAt: record.processExited ? this.now() : null,
      usage: null,
      error: null,
      source: 'live',
      provider: 'herdr',
      providerDetails: { herdr: details },
    }
    this.registry.upsert(summary, record.ancestry, record.messages.map((item) => item.message))
  }

  private addIndex(
    index: Map<string, Set<ChildLaunchRecord>>,
    key: string,
    record: ChildLaunchRecord,
  ): void {
    let records = index.get(key)
    if (!records) {
      records = new Set()
      index.set(key, records)
    }
    records.add(record)
  }
}
