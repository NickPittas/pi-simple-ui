import { readdirSync, lstatSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentSession, AgentSessionEvent, JSONValue } from '@earendil-works/pi-coding-agent'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { WorkerEvent, WorkerStatus, WorkerSummary } from '../../shared/workers.ts'
import type { WorkerRegistry } from './worker-registry.ts'
import { WorkerHistory } from './worker-history.ts'
import { WorkerIdentityStore, type WorkerIdentityOwnership } from './worker-identity.ts'
import { toWorkerEvents, toWorkerJson } from './worker-events.ts'

const MANAGER_REGISTRY_KEY = Symbol.for('pi-subagents:manager')
const MANAGER_READY_EVENT = 'subagents:ready'
const MANAGER_EVENTS = [
  'subagents:created',
  'subagents:started',
  'subagents:completed',
  'subagents:failed',
  'subagents:compacted',
  'subagents:steered',
] as const
const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_500
const DEFAULT_SCAN_INTERVAL_MS = 300
const TINTINWEB_PROVIDER = 'tintinweb'

export interface WorkerHistoryServices {
  readonly identities: WorkerIdentityStore
  readonly history: WorkerHistory
  readonly ownership: WorkerIdentityOwnership
}

/** Create runtime-owned identity/history services using an app-data sidecar. */
export function createWorkerHistoryServices(
  registry: WorkerRegistry,
  sessionDirectories: readonly string[] | undefined,
  userDataDirectory: string,
  ownership: WorkerIdentityOwnership,
): WorkerHistoryServices {
  const identities = new WorkerIdentityStore(join(userDataDirectory, 'worker-identities.json'))
  const canonicalOwnership: WorkerIdentityOwnership = {
    ...ownership,
    workspacePath: resolve(ownership.workspacePath),
  }
  const history = new WorkerHistory({ identities, sessionDirectories, ownership: canonicalOwnership })
  registry.setHistoryPageReader?.((workerId, offset, limit) => history.page(registry, workerId, offset, limit))
  return {
    identities,
    history,
    ownership: canonicalOwnership,
  }
}

export interface TintinwebEventBus {
  on(event: string, handler: (data: unknown) => void): () => void
}

export interface TintinwebRecoverySource {
  readonly cwd: string
  readonly rootSessionId: string
  readonly readEntries: () => readonly unknown[]
}

export interface TintinwebObserverOptions {
  readonly events: TintinwebEventBus
  readonly registry: WorkerRegistry
  readonly scope: RuntimeScope
  /** Used only to recover completed transcript output after the manager is ready. */
  readonly recovery?: TintinwebRecoverySource
  readonly history?: WorkerHistoryServices
  readonly discoveryTimeoutMs?: number
  readonly scanIntervalMs?: number
}

interface NativeWorkerRecord {
  readonly id: string
  readonly type: string
  readonly description: string
  readonly status: string
  readonly startedAt: number
  readonly completedAt?: number
  readonly parentAgentId?: string
  readonly workflowId?: string
  readonly toolCallId?: string
  readonly sessionFile?: string
  readonly alias?: string
  readonly handle?: string
  readonly session?: AgentSession
  readonly invocation?: { readonly modelId?: string }
  readonly lifetimeUsage?: {
    readonly input?: number
    readonly output?: number
    readonly cacheWrite?: number
    readonly cost?: number
  }
  readonly error?: string
}

interface ManagerRegistry {
  listAgents?: () => unknown
  getRecord?: (id: string) => unknown
}

interface RecoveredTranscript {
  readonly messages: JSONValue[]
  firstTimestamp: number
  lastTimestamp: number
  firstUserText?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSession(value: unknown): value is AgentSession {
  return isRecord(value)
    && typeof value.subscribe === 'function'
    && Array.isArray(value.messages)
}

function isManager(value: unknown): value is ManagerRegistry {
  return isRecord(value)
    && (typeof value.listAgents === 'function' || typeof value.getRecord === 'function')
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nativeRecord(value: unknown): NativeWorkerRecord | undefined {
  if (!isRecord(value)) return undefined
  const id = string(value.id)
  const type = string(value.type)
  if (!id || !type) return undefined
  const invocation = isRecord(value.invocation) ? value.invocation : undefined
  const usage = isRecord(value.lifetimeUsage) ? value.lifetimeUsage : undefined
  return {
    id,
    type,
    description: string(value.description) ?? '',
    status: string(value.status) ?? 'running',
    startedAt: finite(value.startedAt) ?? Date.now(),
    ...(finite(value.completedAt) !== undefined ? { completedAt: finite(value.completedAt) } : {}),
    ...(string(value.parentAgentId) ? { parentAgentId: string(value.parentAgentId) } : {}),
    ...(string(value.workflowId) ? { workflowId: string(value.workflowId) } : {}),
    ...(string(value.toolCallId) ? { toolCallId: string(value.toolCallId) } : {}),
    ...(string(value.sessionFile) ? { sessionFile: string(value.sessionFile) } : {}),
    ...(string(value.alias) ? { alias: string(value.alias) } : {}),
    ...(string(value.handle) ? { handle: string(value.handle) } : {}),
    ...(isSession(value.session) ? { session: value.session } : {}),
    ...(invocation ? { invocation: { modelId: string(invocation.modelId) } } : {}),
    ...(usage ? { lifetimeUsage: {
      input: finite(usage.input),
      output: finite(usage.output),
      cacheWrite: finite(usage.cacheWrite),
      cost: finite(usage.cost),
    } } : {}),
    ...(string(value.error) ? { error: string(value.error) } : {}),
  }
}

function workerStatus(status: string): WorkerStatus {
  if (status === 'completed' || status === 'steered') return 'completed'
  if (status === 'error') return 'failed'
  if (status === 'aborted' || status === 'stopped') return 'aborted'
  return 'running'
}

function usageFor(record: NativeWorkerRecord): WorkerSummary['usage'] {
  const usage = record.lifetimeUsage
  if (!usage) return null
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: usage.cost ?? 0,
  }
}

function parentIdFor(record: NativeWorkerRecord): string | null {
  return record.parentAgentId ?? record.workflowId ?? null
}

function summaryFor(
  record: NativeWorkerRecord,
  rootId: string,
  workerId = record.id,
  parentId = parentIdFor(record),
): WorkerSummary {
  const terminal = workerStatus(record.status) !== 'running'
  return {
    id: workerId,
    parentId,
    rootId,
    name: record.alias ?? record.handle ?? record.type,
    type: record.type,
    description: record.description.slice(0, 20_000),
    status: workerStatus(record.status),
    model: record.session?.model
      ? `${record.session.model.provider}/${record.session.model.id}`
      : record.invocation?.modelId ?? null,
    startedAt: record.startedAt,
    completedAt: record.completedAt ?? (terminal ? Date.now() : null),
    usage: usageFor(record),
    error: record.error?.slice(0, 20_000) ?? null,
    source: 'live',
  }
}

function statusFromValue(value: unknown): WorkerStatus {
  if (value === 'failed' || value === 'error') return 'failed'
  if (value === 'aborted' || value === 'stopped') return 'aborted'
  if (value === 'completed' || value === 'steered') return 'completed'
  return 'running'
}

function recoveredSummary(data: Record<string, unknown>): WorkerSummary | undefined {
  const id = string(data.id)
  const type = string(data.type)
  if (!id || !type) return undefined
  const status = statusFromValue(data.status)
  if (status === 'running') return undefined
  const startedAt = finite(data.startedAt) ?? 0
  return {
    id,
    parentId: null,
    rootId: id,
    name: type,
    type,
    description: string(data.description) ?? '',
    status,
    model: null,
    startedAt,
    completedAt: finite(data.completedAt) ?? null,
    usage: null,
    error: string(data.error) ?? null,
    source: 'recovered',
  }
}

function entryData(entry: unknown): Record<string, unknown> | undefined {
  if (!isRecord(entry)) return undefined
  const isSubagentsRecord = entry.customType === 'subagents:record'
    || (entry.type === 'custom' && entry.customType === 'subagents:record')
    || entry.type === 'subagents:record'
  if (!isSubagentsRecord) return undefined
  return isRecord(entry.data) ? entry.data : entry
}

function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, '-')
    .replace(/^[A-Za-z]:-/, '')
    .replace(/^-+/, '')
}

function outputFileMessages(recovery: TintinwebRecoverySource): Map<string, RecoveredTranscript> {
  const transcripts = new Map<string, RecoveredTranscript>()
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(recovery.rootSessionId)) return transcripts
  const taskDirectory = join(
    tmpdir(),
    `pi-subagents-${process.getuid?.() ?? 0}`,
    encodeCwd(recovery.cwd),
    recovery.rootSessionId,
    'tasks',
  )
  let names: string[]
  try {
    names = readdirSync(taskDirectory)
  } catch {
    return transcripts
  }

  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+\.output$/.test(name)) continue
    const path = join(taskDirectory, name)
    try {
      if (!lstatSync(path).isFile()) continue
      const lines = readFileSync(path, 'utf8').split(/\r?\n/)
      for (const line of lines) {
        if (!line) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (!isRecord(parsed) || !isRecord(parsed.message)) continue
        const agentId = string(parsed.agentId)
        if (!agentId || agentId !== name.slice(0, -'.output'.length) || agentId.length > 128) continue
        const timestamp = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : finite(parsed.timestamp)
        const observedAt = Number.isFinite(timestamp) ? timestamp! : 0
        let transcript = transcripts.get(agentId)
        if (!transcript) {
          transcript = { messages: [], firstTimestamp: observedAt, lastTimestamp: observedAt }
          transcripts.set(agentId, transcript)
        }
        transcript.messages.push(toWorkerJson(parsed.message))
        if (observedAt > 0) {
          transcript.firstTimestamp = transcript.firstTimestamp > 0
            ? Math.min(transcript.firstTimestamp, observedAt)
            : observedAt
          transcript.lastTimestamp = Math.max(transcript.lastTimestamp, observedAt)
        }
        if (!transcript.firstUserText && parsed.message.role === 'user' && typeof parsed.message.content === 'string') {
          transcript.firstUserText = parsed.message.content.slice(0, 2_000)
        }
      }
    } catch {
      // A partial output file is expected if the process ended mid-write.
    }
  }
  return transcripts
}

function recoverCompletedWorkers(
  recovery: TintinwebRecoverySource,
  registry: WorkerRegistry,
  identities?: WorkerIdentityStore,
): void {
  let entries: readonly unknown[] = []
  try {
    entries = recovery.readEntries()
  } catch { /* transcript files can still recover messages without session entries */ }
  const summaries = entries
    .map(entryData)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map(recoveredSummary)
    .filter((summary): summary is WorkerSummary => summary !== undefined)

  const transcripts = outputFileMessages(recovery)
  const recoveredIds = new Set<string>()
  for (const summary of summaries) {
    const workerId = identities?.findByNative(TINTINWEB_PROVIDER, summary.id)?.workerId ?? summary.id
    recoveredIds.add(summary.id)
    registry.upsert({ ...summary, id: workerId, rootId: workerId }, [], transcripts.get(summary.id)?.messages ?? [])
  }
  for (const [id, transcript] of transcripts) {
    if (recoveredIds.has(id) || transcript.messages.length === 0) continue
    const workerId = identities?.findByNative(TINTINWEB_PROVIDER, id)?.workerId ?? id
    registry.upsert({
      id: workerId,
      parentId: null,
      rootId: workerId,
      name: workerId,
      type: 'unknown',
      description: transcript.firstUserText ?? 'Recovered child-session transcript; manager metadata was not persisted.',
      status: 'aborted',
      model: null,
      startedAt: transcript.firstTimestamp,
      completedAt: transcript.lastTimestamp || null,
      usage: null,
      error: null,
      source: 'recovered',
    }, [], transcript.messages)
  }
}

function eventToWorkerEvent(
  eventName: string,
  data: Record<string, unknown>,
  workerId = string(data.id),
): WorkerEvent | undefined {
  if (!workerId) return undefined
  const timestamp = Date.now()
  if (eventName === 'subagents:started') return { workerId, type: 'agent-started', timestamp }
  if (eventName === 'subagents:completed') return { workerId, type: 'agent-ended', timestamp }
  if (eventName === 'subagents:failed') {
    const message = string(data.error)
    return message
      ? { workerId, type: 'error', timestamp, message }
      : { workerId, type: 'agent-ended', timestamp }
  }
  return {
    workerId,
    type: 'session-event',
    timestamp,
    event: toWorkerJson({ name: eventName, data }),
  }
}

/**
 * Observe the pi-subagents manager without replacing its callbacks. The bus's
 * lifecycle events discover top-level workers; manager.listAgents() (when the
 * registered manager exposes it) discovers nested and workflow-owned records.
 */
export function createTintinwebObserver(options: TintinwebObserverOptions): {
  refresh(): void
  dispose(): void
  ready: Promise<void>
} {
  const { events, registry } = options
  const managerById = new Map<string, NativeWorkerRecord>()
  const sessionSubscriptions = new Map<string, { readonly session: AgentSession; readonly unsubscribe: () => void }>()
  const eventUnsubscribers: (() => void)[] = []
  const timeout = Math.max(0, options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS)
  const interval = Math.max(100, options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS)
  let manager: ManagerRegistry | undefined
  let readinessSeen = false
  let disposed = false
  let recovered = false
  let poll: ReturnType<typeof setInterval> | undefined
  let unavailableTimer: ReturnType<typeof setTimeout> | undefined
  let resolveReady!: () => void
  let readyResolved = false
  let initialization: Promise<void> | undefined
  const ready = new Promise<void>((resolve) => { resolveReady = resolve })
  registry.ready = ready

  const completeReady = (): void => {
    if (readyResolved) return
    readyResolved = true
    resolveReady()
  }

  const applicationIdFor = (nativeId: string): string =>
    options.history?.identities.findByNative(TINTINWEB_PROVIDER, nativeId)?.workerId ?? nativeId

  const rememberNativeIdentity = (record: NativeWorkerRecord): string => {
    const historyServices = options.history
    const identities = historyServices?.identities
    if (!historyServices || !identities || !registry.isCurrentScope(options.scope)) return record.id
    const prior = identities.findByNative(TINTINWEB_PROVIDER, record.id)
    let nativeSessionId: string | undefined
    let nativeSessionCwd: string | undefined
    let sessionFile = record.sessionFile
    try {
      const sessionManager = record.session?.sessionManager
      nativeSessionId = sessionManager?.getSessionId?.()
      nativeSessionCwd = sessionManager?.getCwd?.()
      sessionFile = sessionManager?.getSessionFile?.() ?? sessionFile
    } catch {
      nativeSessionId = undefined
      nativeSessionCwd = undefined
    }
    const reference = sessionFile
      ? historyServices.history.captureSessionReference(record.id, sessionFile, nativeSessionId, nativeSessionCwd)
      : null
    const refreshReference = !!sessionFile || !!record.session
    const parentAgentId = record.parentAgentId ?? prior?.parentAgentId ?? undefined
    const workflowId = record.workflowId ?? prior?.workflowId ?? undefined
    const parentSessionId = parentAgentId || workflowId
      ? prior?.parentSessionId ?? undefined
      : options.recovery?.rootSessionId ?? prior?.parentSessionId ?? undefined
    const toolCallId = record.toolCallId ?? prior?.toolCallId ?? undefined
    const effectiveSessionId = reference?.nativeSessionId ?? nativeSessionId ?? prior?.nativeSessionId ?? undefined
    const owner = historyServices.ownership
    const nativeSessionPath = refreshReference ? reference?.nativeSessionPath ?? null : prior?.nativeSessionPath ?? null
    const nativeSessionDirectory = refreshReference
      ? reference?.nativeSessionDirectory ?? null
      : prior?.nativeSessionDirectory ?? null
    const effectiveSessionCwd = refreshReference
      ? reference?.nativeSessionCwd ?? null
      : prior?.nativeSessionCwd ?? null
    if (prior
      && prior.nativeAgentId === record.id
      && prior.nativeSessionId === (effectiveSessionId ?? null)
      && prior.parentAgentId === (parentAgentId ?? null)
      && prior.parentSessionId === (parentSessionId ?? null)
      && prior.workflowId === (workflowId ?? null)
      && prior.toolCallId === (toolCallId ?? null)
      && prior.nativeSessionPath === nativeSessionPath
      && prior.nativeSessionDirectory === nativeSessionDirectory
      && prior.nativeSessionCwd === effectiveSessionCwd
      && prior.ownerWorkspaceId === owner.workspaceId
      && prior.ownerWorkspacePath === owner.workspacePath
      && prior.ownerRuntimeId === owner.runtimeId) return prior.workerId

    try {
      return identities.remember({
        provider: TINTINWEB_PROVIDER,
        nativeAgentId: record.id,
        ...(effectiveSessionId ? { nativeSessionId: effectiveSessionId } : {}),
        preferredWorkerId: record.id,
        ...(parentAgentId ? { parentAgentId } : {}),
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(options.recovery?.rootSessionId ? { rootSessionId: options.recovery.rootSessionId } : {}),
        ...(workflowId ? { workflowId } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        ...(refreshReference ? {
          nativeSessionPath,
          nativeSessionDirectory,
          nativeSessionCwd: effectiveSessionCwd,
        } : {}),
        ownerWorkspaceId: owner.workspaceId,
        ownerWorkspacePath: owner.workspacePath,
        ownerRuntimeId: owner.runtimeId,
      }).workerId
    } catch {
      return record.id
    }
  }

  const findManager = (): ManagerRegistry | undefined => {
    const value = Reflect.get(globalThis, MANAGER_REGISTRY_KEY) as unknown
    return isManager(value) ? value : undefined
  }

  const getKnownRecord = (id: string): NativeWorkerRecord | undefined => {
    try {
      const record = nativeRecord(manager?.getRecord?.(id))
      if (record) managerById.set(record.id, record)
      return record
    } catch {
      return undefined
    }
  }

  const refresh = (): void => {
    if (disposed || !registry.isCurrentScope(options.scope) || !readinessSeen || !manager) return
    let records: NativeWorkerRecord[] = []
    let canEnumerateAll = typeof manager.listAgents === 'function'
    if (canEnumerateAll) {
      try {
        const listed = manager.listAgents?.()
        if (Array.isArray(listed)) records = listed.map(nativeRecord).filter((item): item is NativeWorkerRecord => item !== undefined)
        else canEnumerateAll = false
      } catch {
        canEnumerateAll = false
      }
    }

    if (!canEnumerateAll) {
      for (const id of managerById.keys()) {
        const record = getKnownRecord(id)
        if (record) records.push(record)
      }
    }
    registry.setProviderState(canEnumerateAll ? 'available' : 'partial')

    if (options.history && registry.isCurrentScope(options.scope)) {
      for (const record of records) rememberNativeIdentity(record)
    }
    const byId = new Map(records.map((record) => [record.id, record]))
    for (const record of records) managerById.set(record.id, record)
    for (const record of records) {
      const ancestors: string[] = []
      const visited = new Set([record.id])
      let nativeParentId = parentIdFor(record)
      let rootId = record.id
      while (nativeParentId && !visited.has(nativeParentId) && ancestors.length < 64) {
        visited.add(nativeParentId)
        ancestors.unshift(nativeParentId)
        const parent = byId.get(nativeParentId) ?? getKnownRecord(nativeParentId)
        if (parent && options.history) rememberNativeIdentity(parent)
        rootId = parent?.id ?? rootId
        nativeParentId = parent ? parentIdFor(parent) : null
      }
      if (ancestors.length > 0 && rootId === record.id) rootId = ancestors[0]!

      const workerId = options.history ? applicationIdFor(record.id) : record.id
      const appParentId = record.parentAgentId
        ? applicationIdFor(record.parentAgentId)
        : record.workflowId ?? null
      registry.upsert(summaryFor(record, applicationIdFor(rootId), workerId, appParentId), ancestors.map(applicationIdFor))
      if (record.session && workerStatus(record.status) === 'running') attachSession(workerId, record.session)
      else {
        sessionSubscriptions.get(workerId)?.unsubscribe()
        sessionSubscriptions.delete(workerId)
        if (options.history) void options.history.history.restoreWorker(registry, workerId)
      }
    }
  }

  const attachSession = (workerId: string, session: AgentSession): void => {
    const existing = sessionSubscriptions.get(workerId)
    if (existing?.session === session) {
      registry.replaceMessages(workerId, session.messages.map((message) => toWorkerJson(message)))
      return
    }
    existing?.unsubscribe()
    try {
      registry.replaceMessages(workerId, session.messages.map((message) => toWorkerJson(message)))
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (disposed || !registry.isCurrentScope(options.scope)) return
        if (event.type !== 'message_update' && event.type !== 'tool_execution_update') {
          registry.replaceMessages(workerId, session.messages.map((message) => toWorkerJson(message)))
        }
        for (const workerEvent of toWorkerEvents(workerId, event)) registry.appendEvent(workerEvent)
      })
      sessionSubscriptions.set(workerId, { session, unsubscribe })
    } catch {
      // A session being disposed during discovery should not interrupt rescans.
    }
  }

  const handleManagerEvent = (eventName: string, value: unknown): void => {
    if (disposed || !registry.isCurrentScope(options.scope)) return
    const data = isRecord(value) ? value : undefined
    if (!data) return
    const id = string(data.id)
    if (id) {
      const native = getKnownRecord(id)
      if (native && options.history) rememberNativeIdentity(native)
      const workerId = applicationIdFor(id)
      if (native) {
        const parentId = parentIdFor(native)
        registry.upsert(
          summaryFor(
            native,
            applicationIdFor(parentId ?? native.id),
            workerId,
            native.parentAgentId ? applicationIdFor(native.parentAgentId) : native.workflowId ?? null,
          ),
          parentId ? [applicationIdFor(parentId)] : [],
        )
        if (native.session && workerStatus(native.status) === 'running') attachSession(workerId, native.session)
      } else {
        const declaredStatus = string(data.status)
        const status = declaredStatus
          ? statusFromValue(declaredStatus)
          : eventName === 'subagents:completed' ? 'completed'
            : eventName === 'subagents:failed' ? 'failed' : 'running'
        const fallback: WorkerSummary = {
          id: workerId,
          parentId: null,
          rootId: workerId,
          name: string(data.type) ?? 'agent',
          type: string(data.type) ?? 'unknown',
          description: (string(data.description) ?? '').slice(0, 20_000),
          status,
          model: null,
          startedAt: finite(data.startedAt) ?? Date.now(),
          completedAt: finite(data.completedAt) ?? (status === 'running' ? null : Date.now()),
          usage: null,
          error: string(data.error)?.slice(0, 20_000) ?? null,
          source: 'live',
        }
        registry.upsert(fallback, [])
      }
      managerById.set(id, native ?? managerById.get(id) ?? {
        id,
        type: string(data.type) ?? 'unknown',
        description: string(data.description) ?? '',
        status: string(data.status) ?? (eventName === 'subagents:started' ? 'running' : 'completed'),
        startedAt: finite(data.startedAt) ?? Date.now(),
      })
      const workerEvent = eventToWorkerEvent(eventName, data, workerId)
      if (workerEvent) registry.appendEvent(workerEvent)
      refresh()
    }
  }

  const initialize = (): Promise<void> => {
    if (initialization) return initialization
    initialization = (async () => {
      if (!registry.isCurrentScope(options.scope)) {
        completeReady()
        return
      }
      const prepareManagerState = (): void => {
        if (!manager || !registry.isCurrentScope(options.scope)) return
        if (!recovered && options.recovery) {
          recovered = true
          recoverCompletedWorkers(options.recovery, registry, options.history?.identities)
        }
        refresh()
        const identities = options.history?.identities
        if (identities?.requiresNativeRecovery && identities.list().length > 0) identities.finishNativeRecovery()
      }
      const managerAtStart = manager
      prepareManagerState()
      try {
        await options.history?.history.restore(registry)
      } catch {
        // Keep startup available; worker history remains unavailable for this scan.
      }
      if (!registry.isCurrentScope(options.scope)) {
        completeReady()
        return
      }
      if (manager && manager !== managerAtStart) {
        prepareManagerState()
        try {
          await options.history?.history.restore(registry)
        } catch {
          // A late native manager must not hold runtime startup indefinitely.
        }
      }
      if (!registry.isCurrentScope(options.scope)) {
        completeReady()
        return
      }
      if (manager) {
        refresh()
        if (!poll) {
          poll = setInterval(refresh, interval)
          poll.unref?.()
        }
      } else {
        registry.setProviderState('provider-unavailable')
      }
      completeReady()
    })().finally(() => { initialization = undefined })
    return initialization
  }

  const attachReadyManager = (): void => {
    if (disposed) return
    readinessSeen = true
    manager = findManager()
    if (!manager) {
      registry.setProviderState('provider-unavailable')
      void initialize()
      return
    }
    if (unavailableTimer) clearTimeout(unavailableTimer)
    void initialize()
  }

  eventUnsubscribers.push(events.on(MANAGER_READY_EVENT, attachReadyManager))
  for (const eventName of MANAGER_EVENTS) {
    eventUnsubscribers.push(events.on(eventName, (data) => handleManagerEvent(eventName, data)))
  }

  unavailableTimer = setTimeout(() => {
    if (!disposed && !readinessSeen && !findManager()) {
      registry.setProviderState('provider-unavailable')
      void initialize()
    }
  }, timeout)
  unavailableTimer.unref?.()

  return {
    refresh,
    ready,
    dispose() {
      if (disposed) return
      disposed = true
      completeReady()
      if (poll) clearInterval(poll)
      if (unavailableTimer) clearTimeout(unavailableTimer)
      for (const unsubscribe of eventUnsubscribers) unsubscribe()
      for (const subscription of sessionSubscriptions.values()) subscription.unsubscribe()
      sessionSubscriptions.clear()
      managerById.clear()
      registry.dispose()
    },
  }
}
