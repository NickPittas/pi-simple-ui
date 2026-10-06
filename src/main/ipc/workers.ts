import type { CapabilityDefinition, EventDefinition } from './register.ts'
import {
  hasExactKeys,
  isPlainRecord,
  type RuntimeScope,
} from '../../shared/ipc-contracts.ts'
import {
  WORKERS_IPC,
  type WorkerCapabilityContracts,
  type WorkerControlCapabilityContracts,
  type WorkerAbortRequest,
  type WorkerAbortResponse,
  type WorkerEvent,
  type WorkerListRequest,
  type WorkerListResponse,
  type WorkerResumeRequest,
  type WorkerResumeResponse,
  type WorkerSnapshot,
  type WorkerSnapshotRequest,
  type WorkerSteerRequest,
  type WorkerSteerResponse,
  type WorkerControlResponse,
  type WorkerUsage,
  WORKER_SNAPSHOT_DEFAULT_LIMIT,
  WORKER_SNAPSHOT_MAX_OFFSET,
  isWorkerSnapshotRequest,
  isWorkerAbortRequest,
  isWorkerAbortResponse,
  isWorkerResumeRequest,
  isWorkerResumeResponse,
  isWorkerSteerRequest,
  isWorkerSteerResponse,
} from '../../shared/workers.ts'
import type { WorkerRegistry } from '../workers/worker-registry.ts'
import type { WorkerControlHandler } from '../workers/worker-controls.ts'

export type WorkerCapabilityDefinition = {
  [K in keyof WorkerCapabilityContracts]: CapabilityDefinition<
    WorkerCapabilityContracts[K]['request'],
    WorkerCapabilityContracts[K]['response']
  >
}[keyof WorkerCapabilityContracts]

export type WorkerEventsDefinition = EventDefinition<WorkerEvent>

export type WorkerControlCapabilityDefinition = {
  [K in keyof WorkerControlCapabilityContracts]: CapabilityDefinition<
    WorkerControlCapabilityContracts[K]['request'],
    WorkerControlCapabilityContracts[K]['response']
  >
}[keyof WorkerControlCapabilityContracts]

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 100) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1))
  return isPlainRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1))
}

function isWorkerStatus(value: unknown): boolean {
  return value === 'running' || value === 'blocked-wait' || value === 'idle'
    || value === 'completed' || value === 'failed' || value === 'aborted'
}

function isWorkerUsage(value: unknown): value is WorkerUsage {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['input', 'output', 'cacheWrite', 'cost'])) return false
  return ['input', 'output', 'cacheWrite', 'cost'].every((key) => {
    const amount = value[key]
    return typeof amount === 'number' && Number.isFinite(amount)
  })
}

function hasRequiredOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
}

function isWorkerControlAvailability(value: unknown): boolean {
  return isPlainRecord(value)
    && hasRequiredOptionalKeys(value, ['available'], ['reason'])
    && typeof value.available === 'boolean'
    && (value.reason === undefined || (typeof value.reason === 'string' && value.reason.length <= 1_000))
}

function isHerdrWorkerDetails(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasRequiredOptionalKeys(value, [
    'paneId', 'kind', 'nativeState', 'nativeSessionId', 'nativeSessionPath', 'nativeStateMessage',
    'detached', 'persistent', 'lifetime', 'transcript', 'childPid', 'controls',
  ], [])) return false
  if (typeof value.paneId !== 'string' || value.paneId.length === 0 || value.paneId.length > 256
    || !['fresh', 'resume', 'handoff'].includes(value.kind as string)
    || !(value.nativeState === null || value.nativeState === 'working' || value.nativeState === 'blocked' || value.nativeState === 'idle')
    || !(value.nativeSessionId === null || (typeof value.nativeSessionId === 'string' && value.nativeSessionId.length <= 256))
    || !(value.nativeSessionPath === null || (typeof value.nativeSessionPath === 'string' && value.nativeSessionPath.length <= 4_096))
    || !(value.nativeStateMessage === null || (typeof value.nativeStateMessage === 'string' && value.nativeStateMessage.length <= 1_000))
    || typeof value.detached !== 'boolean'
    || typeof value.persistent !== 'boolean'
    || !['launch-issued', 'session-observed', 'process-alive', 'process-exited', 'unknown'].includes(value.lifetime as string)
    || !['unavailable', 'file-restored', 'file-live'].includes(value.transcript as string)
    || !(value.childPid === null || (typeof value.childPid === 'number' && Number.isSafeInteger(value.childPid) && value.childPid > 0))
    || !isPlainRecord(value.controls)
    || !hasExactKeys(value.controls, ['steer', 'abort', 'resume'])) return false
  return isWorkerControlAvailability(value.controls.steer)
    && isWorkerControlAvailability(value.controls.abort)
    && isWorkerControlAvailability(value.controls.resume)
}

function isNicobailonWorkerDetails(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasRequiredOptionalKeys(value, [
    'asyncRunId', 'stepIndex', 'nativeSessionId', 'nativeSessionPath', 'transcript', 'controls',
  ], ['rootSessionId', 'rootToolCallId'])) return false
  if (!(value.asyncRunId === null || (typeof value.asyncRunId === 'string' && value.asyncRunId.length <= 256))
    || !(value.stepIndex === null || (typeof value.stepIndex === 'number' && Number.isSafeInteger(value.stepIndex) && value.stepIndex >= 0))
    || !(value.nativeSessionId === null || (typeof value.nativeSessionId === 'string' && value.nativeSessionId.length <= 4_096))
    || !(value.nativeSessionPath === null || (typeof value.nativeSessionPath === 'string' && value.nativeSessionPath.length <= 4_096))
    || !(value.rootSessionId === undefined || (typeof value.rootSessionId === 'string' && value.rootSessionId.length <= 256))
    || !(value.rootToolCallId === undefined || (typeof value.rootToolCallId === 'string' && value.rootToolCallId.length <= 256))
    || !['unavailable', 'event-live', 'file-live', 'file-restored'].includes(value.transcript as string)
    || !isPlainRecord(value.controls)
    || !hasExactKeys(value.controls, ['steer', 'abort', 'resume'])) return false
  return isWorkerControlAvailability(value.controls.steer)
    && isWorkerControlAvailability(value.controls.abort)
    && isWorkerControlAvailability(value.controls.resume)
}

function isWorkerSummary(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasRequiredOptionalKeys(value, [
    'id', 'parentId', 'rootId', 'name', 'type', 'description', 'status', 'model',
    'startedAt', 'completedAt', 'usage', 'error', 'source',
  ], ['provider', 'providerDetails'])) return false
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 128
    || !(value.parentId === null || (typeof value.parentId === 'string' && value.parentId.length <= 128))
    || typeof value.rootId !== 'string' || value.rootId.length === 0 || value.rootId.length > 128
    || typeof value.name !== 'string' || value.name.length > 512
    || typeof value.type !== 'string' || value.type.length > 256
    || typeof value.description !== 'string' || value.description.length > 20_000
    || !isWorkerStatus(value.status)
    || !(value.model === null || (typeof value.model === 'string' && value.model.length <= 512))
    || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)
    || !(value.completedAt === null || (typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)))
    || !(value.error === null || (typeof value.error === 'string' && value.error.length <= 20_000))
    || (value.source !== 'live' && value.source !== 'recovered')
    || (value.provider !== undefined && !['native', 'tintinweb', 'herdr', 'nicobailon'].includes(value.provider as string))) return false
  if (value.providerDetails !== undefined) {
    if (!isPlainRecord(value.providerDetails)) return false
    if (value.provider === 'herdr') {
      if (!hasExactKeys(value.providerDetails, ['herdr']) || !isHerdrWorkerDetails(value.providerDetails.herdr)) return false
    } else if (value.provider === 'nicobailon') {
      if (!hasExactKeys(value.providerDetails, ['nicobailon']) || !isNicobailonWorkerDetails(value.providerDetails.nicobailon)) return false
    } else return false
  }
  if (value.usage === null) return true
  return isWorkerUsage(value.usage)
}

function isWorkerSnapshot(value: unknown): value is WorkerSnapshot {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      'summary', 'ancestry', 'messages', 'nextCursor', 'historyComplete', 'totalMessages',
    ])
    && isWorkerSummary(value.summary)
    && Array.isArray(value.ancestry)
    && value.ancestry.length <= 64
    && value.ancestry.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
    && Array.isArray(value.messages)
    && value.messages.every((message) => isJsonValue(message))
    && (value.nextCursor === null
      || (typeof value.nextCursor === 'string'
        && /^(0|[1-9][0-9]{0,6})$/.test(value.nextCursor)
        && Number(value.nextCursor) <= WORKER_SNAPSHOT_MAX_OFFSET))
    && (value.historyComplete === null || typeof value.historyComplete === 'boolean')
    && (value.totalMessages === null
      || (typeof value.totalMessages === 'number' && Number.isSafeInteger(value.totalMessages) && value.totalMessages >= 0))
    && (value.nextCursor === null || value.historyComplete === false)
    && (value.historyComplete !== true || value.nextCursor === null)
    && (value.historyComplete !== false || value.nextCursor !== null)
}

function isWorkerListRequest(value: unknown): value is WorkerListRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

function isWorkerListResponse(value: unknown): value is WorkerListResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['providerState', 'workers'])
    && (value.providerState === 'available'
      || value.providerState === 'partial'
      || value.providerState === 'provider-unavailable')
    && Array.isArray(value.workers)
    && value.workers.length <= 10_000
    && value.workers.every(isWorkerSummary)
}

function isWorkerEvent(value: unknown): value is WorkerEvent {
  if (!isPlainRecord(value)
    || typeof value.workerId !== 'string'
    || value.workerId.length === 0
    || value.workerId.length > 128
    || typeof value.timestamp !== 'number'
    || !Number.isFinite(value.timestamp)
    || typeof value.type !== 'string') return false

  const base = ['workerId', 'type', 'timestamp']
  if (['agent-started', 'turn-started', 'turn-ended', 'agent-ended', 'settled'].includes(value.type)) {
    return hasExactKeys(value, Object.hasOwn(value, 'details') ? [...base, 'details'] : base)
      && (value.details === undefined || isJsonValue(value.details))
  }
  if (value.type === 'message-started' || value.type === 'message-updated' || value.type === 'message-ended') {
    return hasExactKeys(value, [
      ...base,
      'message',
      ...(Object.hasOwn(value, 'update') ? ['update'] : []),
      ...(Object.hasOwn(value, 'delta') ? ['delta'] : []),
      ...(Object.hasOwn(value, 'channel') ? ['channel'] : []),
    ])
      && isJsonValue(value.message)
      && (value.update === undefined || isJsonValue(value.update))
      && (value.delta === undefined || (typeof value.delta === 'string' && value.delta.length <= 100_000))
      && (value.channel === undefined || value.channel === 'text' || value.channel === 'thinking' || value.channel === 'other')
  }
  if (value.type === 'tool-started' || value.type === 'tool-updated' || value.type === 'tool-ended') {
    return hasExactKeys(value, [
      ...base,
      'toolCallId', 'toolName',
      ...(Object.hasOwn(value, 'arguments') ? ['arguments'] : []),
      ...(Object.hasOwn(value, 'result') ? ['result'] : []),
      ...(Object.hasOwn(value, 'isError') ? ['isError'] : []),
    ])
      && typeof value.toolCallId === 'string'
      && value.toolCallId.length <= 256
      && typeof value.toolName === 'string'
      && value.toolName.length <= 256
      && (value.arguments === undefined || isJsonValue(value.arguments))
      && (value.result === undefined || isJsonValue(value.result))
      && (value.isError === undefined || typeof value.isError === 'boolean')
  }
  if (value.type === 'queue-updated') {
    return hasExactKeys(value, [...base, 'steering', 'followUp'])
      && Array.isArray(value.steering)
      && value.steering.every((item) => typeof item === 'string')
      && Array.isArray(value.followUp)
      && value.followUp.every((item) => typeof item === 'string')
  }
  if (value.type === 'compaction-started' || value.type === 'compaction-ended') {
    return hasExactKeys(value, [
      ...base,
      'reason',
      ...(Object.hasOwn(value, 'aborted') ? ['aborted'] : []),
      ...(Object.hasOwn(value, 'details') ? ['details'] : []),
    ])
      && (value.reason === 'manual' || value.reason === 'threshold' || value.reason === 'overflow')
      && (value.aborted === undefined || typeof value.aborted === 'boolean')
      && (value.details === undefined || isJsonValue(value.details))
  }
  if (value.type === 'retry-started' || value.type === 'retry-ended') {
    return hasExactKeys(value, [...base, 'details']) && isJsonValue(value.details)
  }
  if (value.type === 'error') {
    return hasExactKeys(value, [...base, 'message'])
      && typeof value.message === 'string'
      && value.message.length <= 20_000
  }
  if (value.type === 'session-event') {
    return hasExactKeys(value, [...base, 'event']) && isJsonValue(value.event)
  }
  return false
}

function requireCurrentScope(scope: RuntimeScope | undefined, registry: WorkerRegistry): RuntimeScope {
  if (!scope || !registry.isCurrentScope(scope)) throw new Error('The worker runtime scope is no longer current.')
  return scope
}

/** Register read-only worker capabilities and the caller/runtime-scoped event stream. */
export function registerWorkerCapabilities(registry: WorkerRegistry): readonly WorkerCapabilityDefinition[] {
  const list: CapabilityDefinition<WorkerListRequest, WorkerListResponse> = {
    id: WORKERS_IPC.list,
    scope: 'runtime',
    validateRequest: isWorkerListRequest,
    validateResponse: isWorkerListResponse,
    handle: async ({ scope }) => {
      const currentScope = requireCurrentScope(scope, registry)
      await registry.ready
      requireCurrentScope(currentScope, registry)
      return registry.list()
    },
  }
  const snapshot: CapabilityDefinition<WorkerSnapshotRequest, WorkerSnapshot | null> = {
    id: WORKERS_IPC.snapshot,
    scope: 'runtime',
    validateRequest: isWorkerSnapshotRequest,
    validateResponse: (value): value is WorkerSnapshot | null => value === null || isWorkerSnapshot(value),
    handle: async ({ scope }, request) => {
      const currentScope = requireCurrentScope(scope, registry)
      await registry.ready
      requireCurrentScope(currentScope, registry)
      const isPaged = request.cursor !== undefined || request.limit !== undefined
      if (!isPaged) return registry.snapshot(request.workerId)

      const offset = request.cursor === undefined ? 0 : Number(request.cursor)
      const limit = request.limit ?? WORKER_SNAPSHOT_DEFAULT_LIMIT
      const page = await registry.snapshotPage?.(request.workerId, offset, limit)
      requireCurrentScope(currentScope, registry)
      if (page) {
        const nextCursor = page.nextOffset !== null && page.nextOffset <= WORKER_SNAPSHOT_MAX_OFFSET
          ? String(page.nextOffset)
          : null
        return {
          summary: page.summary,
          ancestry: page.ancestry,
          messages: page.messages,
          nextCursor,
          historyComplete: page.nextOffset === null ? page.historyComplete : nextCursor === null ? null : false,
          totalMessages: page.total,
        }
      }

      // The composition proxy predates snapshot paging and forwards only workerId.
      // Keep the wire response compatible while paging its current native snapshot.
      const snapshot = registry.snapshot(request.workerId)
      if (!snapshot) return null
      const lookahead = snapshot.messages.slice(offset, offset + limit + 1)
      const hasLookahead = lookahead.length > limit
      const knownTotal = snapshot.totalMessages !== null && snapshot.historyComplete === true
        ? snapshot.totalMessages
        : null
      const end = knownTotal === null
        ? offset + Math.min(lookahead.length, limit)
        : Math.min(knownTotal, offset + limit)
      const hasMore = knownTotal === null ? hasLookahead : end < knownTotal
      const nextCursor = hasMore && end <= WORKER_SNAPSHOT_MAX_OFFSET ? String(end) : null
      return {
        summary: snapshot.summary,
        ancestry: snapshot.ancestry,
        messages: knownTotal === null ? lookahead.slice(0, limit) : snapshot.messages.slice(offset, end),
        nextCursor,
        historyComplete: hasMore ? nextCursor === null ? null : false : knownTotal === null ? null : true,
        totalMessages: snapshot.totalMessages,
      }
    },
  }
  return [list, snapshot]
}

export function registerWorkerEvents(registry: WorkerRegistry): readonly WorkerEventsDefinition[] {
  const events: EventDefinition<WorkerEvent> = {
    id: WORKERS_IPC.events,
    scope: 'runtime',
    validatePayload: isWorkerEvent,
    subscribe: (context, publish) => registry.subscribe(
      context.caller,
      requireCurrentScope(context.scope, registry),
      publish,
    ),
  }
  return [events]
}

export interface WorkerControlRoutingOptions {
  readonly registry?: WorkerRegistry
  /** App-local adapter for native Herdr controls; never falls through to AgentManager. */
  readonly herdr?: WorkerControlHandler
  /** Native nicobailon controls; never fall through to the generic Pi manager. */
  readonly nicobailon?: WorkerControlHandler
}

function isHerdrWorker(workerId: string, registry?: WorkerRegistry): boolean {
  return workerId.startsWith('herdr:')
    || registry?.snapshot(workerId)?.summary.provider === 'herdr'
}

function isNicobailonWorker(workerId: string, registry?: WorkerRegistry): boolean {
  return workerId.startsWith('nicobailon:')
    || registry?.snapshot(workerId)?.summary.provider === 'nicobailon'
}

function herdrUnavailable(
  registry: WorkerRegistry | undefined,
  workerId: string,
  operation: 'steer' | 'abort' | 'resume',
): WorkerControlResponse {
  const reason = registry?.snapshot(workerId)?.summary.providerDetails?.herdr?.controls[operation].reason
  return {
    accepted: false,
    reason: 'control-unavailable',
    error: reason ?? 'No native Herdr control adapter is wired for this child.',
  }
}

function nicobailonUnavailable(
  registry: WorkerRegistry | undefined,
  workerId: string,
  operation: 'steer' | 'abort' | 'resume',
): WorkerControlResponse {
  const reason = registry?.snapshot(workerId)?.summary.providerDetails?.nicobailon?.controls[operation].reason
  return {
    accepted: false,
    reason: 'control-unavailable',
    error: reason ?? 'No native nicobailon control adapter is wired for this child.',
  }
}

/** Register the T17 control surface; the parent supplies the active host manager accessor. */
export function registerWorkerControlCapabilities(
  controls: WorkerControlHandler,
  routing: WorkerControlRoutingOptions = {},
): readonly WorkerControlCapabilityDefinition[] {
  const steer: CapabilityDefinition<WorkerSteerRequest, WorkerSteerResponse> = {
    id: WORKERS_IPC.steer,
    scope: 'runtime',
    validateRequest: isWorkerSteerRequest,
    validateResponse: isWorkerSteerResponse,
    handle: ({ caller, scope }, request) => {
      if (!scope) return { accepted: false, reason: 'operation-cancelled' }
      if (isNicobailonWorker(request.workerId, routing.registry)) {
        return routing.nicobailon?.steer(caller, scope, request)
          ?? Promise.resolve(nicobailonUnavailable(routing.registry, request.workerId, 'steer'))
      }
      if (isHerdrWorker(request.workerId, routing.registry)) {
        return routing.herdr?.steer(caller, scope, request)
          ?? Promise.resolve(herdrUnavailable(routing.registry, request.workerId, 'steer'))
      }
      return controls.steer(caller, scope, request)
    },
  }
  const abort: CapabilityDefinition<WorkerAbortRequest, WorkerAbortResponse> = {
    id: WORKERS_IPC.abort,
    scope: 'runtime',
    validateRequest: isWorkerAbortRequest,
    validateResponse: isWorkerAbortResponse,
    handle: ({ caller, scope }, request) => {
      if (!scope) return { accepted: false, reason: 'operation-cancelled' }
      if (isNicobailonWorker(request.workerId, routing.registry)) {
        return routing.nicobailon?.abort(caller, scope, request)
          ?? Promise.resolve(nicobailonUnavailable(routing.registry, request.workerId, 'abort'))
      }
      if (isHerdrWorker(request.workerId, routing.registry)) {
        return routing.herdr?.abort(caller, scope, request)
          ?? Promise.resolve(herdrUnavailable(routing.registry, request.workerId, 'abort'))
      }
      return controls.abort(caller, scope, request)
    },
  }
  const resume: CapabilityDefinition<WorkerResumeRequest, WorkerResumeResponse> = {
    id: WORKERS_IPC.resume,
    scope: 'runtime',
    validateRequest: isWorkerResumeRequest,
    validateResponse: isWorkerResumeResponse,
    handle: ({ caller, scope }, request) => {
      if (!scope) return { accepted: false, reason: 'operation-cancelled' }
      if (isNicobailonWorker(request.workerId, routing.registry)) {
        return routing.nicobailon?.resume(caller, scope, request)
          ?? Promise.resolve(nicobailonUnavailable(routing.registry, request.workerId, 'resume'))
      }
      if (isHerdrWorker(request.workerId, routing.registry)) {
        return routing.herdr?.resume(caller, scope, request)
          ?? Promise.resolve(herdrUnavailable(routing.registry, request.workerId, 'resume'))
      }
      return controls.resume(caller, scope, request)
    },
  }
  return [steer, abort, resume]
}
