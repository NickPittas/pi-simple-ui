import type { JSONValue } from '@earendil-works/pi-coding-agent'
import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

export const WORKERS_IPC = Object.freeze({
  list: 'workers.list',
  snapshot: 'workers.snapshot',
  events: 'workers.events',
  steer: 'workers.steer',
  abort: 'workers.abort',
  resume: 'workers.resume',
})

export type WorkerStatus = 'running' | 'blocked-wait' | 'idle' | 'completed' | 'failed' | 'aborted'
export type WorkerProviderState = 'available' | 'partial' | 'provider-unavailable'
export type WorkerProvider = 'native' | 'tintinweb' | 'herdr' | 'nicobailon'

export interface WorkerControlAvailability {
  readonly available: boolean
  readonly reason?: string
}

export interface HerdrWorkerDetails {
  readonly paneId: string
  readonly kind: 'fresh' | 'resume' | 'handoff'
  /** Raw Herdr label; summary.status uses the shared worker status mapping. */
  readonly nativeState: 'working' | 'blocked' | 'idle' | null
  readonly nativeSessionId: string | null
  readonly nativeSessionPath: string | null
  readonly nativeStateMessage: string | null
  readonly detached: boolean
  readonly persistent: boolean
  readonly lifetime: 'launch-issued' | 'session-observed' | 'process-alive' | 'process-exited' | 'unknown'
  readonly transcript: 'unavailable' | 'file-restored' | 'file-live'
  readonly childPid: number | null
  readonly controls: {
    readonly steer: WorkerControlAvailability
    readonly abort: WorkerControlAvailability
    readonly resume: WorkerControlAvailability
  }
}

export interface NicobailonWorkerDetails {
  readonly asyncRunId: string | null
  readonly stepIndex: number | null
  readonly nativeSessionId: string | null
  readonly nativeSessionPath: string | null
  /** Native Pi session that originated this observed worker tree, when known. */
  readonly rootSessionId?: string
  /** Native Pi tool call at the root of this observed worker tree, when known. */
  readonly rootToolCallId?: string
  readonly transcript: 'unavailable' | 'event-live' | 'file-live' | 'file-restored'
  readonly controls: {
    readonly steer: WorkerControlAvailability
    readonly abort: WorkerControlAvailability
    readonly resume: WorkerControlAvailability
  }
}

export interface WorkerProviderDetails {
  readonly herdr?: HerdrWorkerDetails
  readonly nicobailon?: NicobailonWorkerDetails
}

export interface WorkerUsage {
  readonly input: number
  readonly output: number
  readonly cacheWrite: number
  readonly cost: number
}

export interface WorkerSummary {
  readonly id: string
  /** Worker ID, workflow ID, or null for a top-level worker. */
  readonly parentId: string | null
  /** Top-level worker ID, or this worker's own ID when it has no worker ancestor. */
  readonly rootId: string
  readonly name: string
  readonly type: string
  readonly description: string
  readonly status: WorkerStatus
  readonly model: string | null
  readonly startedAt: number
  readonly completedAt: number | null
  readonly usage: WorkerUsage | null
  readonly error: string | null
  readonly source: 'live' | 'recovered'
  /** Provider identifies the child-management backend when not Pi-native. */
  readonly provider?: WorkerProvider
  readonly providerDetails?: WorkerProviderDetails
}

/**
 * Per-worker event stream. The lifecycle variants parallel ChatLifecycleEvent;
 * message and tool variants carry the native AgentSession stream payloads needed
 * for live conversation rendering.
 */
export type WorkerEvent =
  | {
      readonly workerId: string
      readonly type: 'agent-started' | 'turn-started' | 'turn-ended' | 'agent-ended' | 'settled'
      readonly timestamp: number
      readonly details?: JSONValue
    }
  | {
      readonly workerId: string
      readonly type: 'message-started' | 'message-updated' | 'message-ended'
      readonly timestamp: number
      readonly message: JSONValue
      readonly update?: JSONValue
      readonly delta?: string
      readonly channel?: 'text' | 'thinking' | 'other'
    }
  | {
      readonly workerId: string
      readonly type: 'tool-started' | 'tool-updated' | 'tool-ended'
      readonly timestamp: number
      readonly toolCallId: string
      readonly toolName: string
      readonly arguments?: JSONValue
      readonly result?: JSONValue
      readonly isError?: boolean
    }
  | {
      readonly workerId: string
      readonly type: 'queue-updated'
      readonly timestamp: number
      readonly steering: readonly string[]
      readonly followUp: readonly string[]
    }
  | {
      readonly workerId: string
      readonly type: 'compaction-started' | 'compaction-ended'
      readonly timestamp: number
      readonly reason: 'manual' | 'threshold' | 'overflow'
      readonly aborted?: boolean
      readonly details?: JSONValue
    }
  | {
      readonly workerId: string
      readonly type: 'retry-started' | 'retry-ended'
      readonly timestamp: number
      readonly details: JSONValue
    }
  | {
      readonly workerId: string
      readonly type: 'error'
      readonly timestamp: number
      readonly message: string
    }
  | {
      readonly workerId: string
      readonly type: 'session-event'
      readonly timestamp: number
      readonly event: JSONValue
    }

export interface WorkerSnapshot {
  readonly summary: WorkerSummary
  /** Ancestor worker IDs ordered from root to immediate parent. */
  readonly ancestry: readonly string[]
  /** JSON-safe projections of the native AgentSession messages array. */
  readonly messages: readonly JSONValue[]
  /** Decimal message offset for the next page, or null when no next page is known. */
  readonly nextCursor: string | null
  /** True/false when extent is known; null when the available transcript may be partial. */
  readonly historyComplete: boolean | null
  /** Full native message count when known. */
  readonly totalMessages: number | null
}

export interface WorkerListRequest {}

export interface WorkerListResponse {
  readonly providerState: WorkerProviderState
  readonly workers: readonly WorkerSummary[]
}

export interface WorkerSnapshotRequest {
  readonly workerId: string
  /** Decimal message offset. Omit cursor and limit to preserve the full-snapshot behavior. */
  readonly cursor?: string
  readonly limit?: number
}

export interface WorkerSteerRequest {
  readonly workerId: string
  readonly message: string
}

export interface WorkerAbortRequest {
  readonly workerId: string
}

export interface WorkerResumeRequest {
  readonly workerId: string
  readonly message: string
  readonly isBackground?: boolean
}

export type WorkerControlRejectionReason =
  | 'worker-not-observed'
  | 'worker-not-running'
  | 'worker-not-resumable'
  | 'manager-unavailable'
  | 'runtime-policy-unavailable'
  | 'runtime-not-trusted'
  | 'runtime-revoked'
  | 'control-unavailable'
  | 'operation-cancelled'
  | 'operation-failed'

export type WorkerControlResponse =
  | { readonly accepted: true; readonly delivery?: 'queued' }
  | {
      readonly accepted: false
      readonly reason: WorkerControlRejectionReason
      readonly error?: string
    }

export type WorkerSteerResponse = WorkerControlResponse
export type WorkerAbortResponse = WorkerControlResponse
export type WorkerResumeResponse = WorkerControlResponse

const MAX_WORKER_ID_LENGTH = 128
const MAX_WORKER_CONTROL_MESSAGE_LENGTH = 20_000
const MAX_WORKER_CONTROL_ERROR_LENGTH = 1_000
export const WORKER_SNAPSHOT_DEFAULT_LIMIT = 50
export const WORKER_SNAPSHOT_MAX_LIMIT = 100
export const WORKER_SNAPSHOT_MAX_OFFSET = 1_000_000

function isWorkerId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_WORKER_ID_LENGTH
    && !value.includes('\0')
}

function isControlMessage(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_WORKER_CONTROL_MESSAGE_LENGTH
}

function isWorkerControlResponse(value: unknown): value is WorkerControlResponse {
  if (!isPlainRecord(value) || typeof value.accepted !== 'boolean') return false
  if (value.accepted) {
    return hasExactKeys(value, ['accepted'])
      || (hasExactKeys(value, ['accepted', 'delivery']) && value.delivery === 'queued')
  }
  return hasExactKeys(value, Object.hasOwn(value, 'error') ? ['accepted', 'reason', 'error'] : ['accepted', 'reason'])
    && typeof value.reason === 'string'
    && [
      'worker-not-observed', 'worker-not-running', 'worker-not-resumable', 'manager-unavailable',
      'runtime-policy-unavailable', 'runtime-not-trusted', 'runtime-revoked',
      'control-unavailable', 'operation-cancelled', 'operation-failed',
    ].includes(value.reason)
    && (value.error === undefined || (typeof value.error === 'string' && value.error.length <= MAX_WORKER_CONTROL_ERROR_LENGTH))
}

export function isWorkerSteerRequest(value: unknown): value is WorkerSteerRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['workerId', 'message'])
    && isWorkerId(value.workerId)
    && isControlMessage(value.message)
}

export function isWorkerAbortRequest(value: unknown): value is WorkerAbortRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['workerId'])
    && isWorkerId(value.workerId)
}

export function isWorkerSnapshotRequest(value: unknown): value is WorkerSnapshotRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, Object.hasOwn(value, 'cursor') || Object.hasOwn(value, 'limit')
      ? ['workerId', ...(Object.hasOwn(value, 'cursor') ? ['cursor'] : []), ...(Object.hasOwn(value, 'limit') ? ['limit'] : [])]
      : ['workerId'])
    && isWorkerId(value.workerId)
    && (value.cursor === undefined
      || (typeof value.cursor === 'string'
        && /^(0|[1-9][0-9]{0,6})$/.test(value.cursor)
        && Number(value.cursor) <= WORKER_SNAPSHOT_MAX_OFFSET))
    && (value.limit === undefined
      || (typeof value.limit === 'number'
        && Number.isSafeInteger(value.limit)
        && value.limit >= 1
        && value.limit <= WORKER_SNAPSHOT_MAX_LIMIT))
}

export function isWorkerResumeRequest(value: unknown): value is WorkerResumeRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, Object.hasOwn(value, 'isBackground')
      ? ['workerId', 'message', 'isBackground']
      : ['workerId', 'message'])
    && isWorkerId(value.workerId)
    && isControlMessage(value.message)
    && (value.isBackground === undefined || typeof value.isBackground === 'boolean')
}

export function isWorkerSteerResponse(value: unknown): value is WorkerSteerResponse {
  return isWorkerControlResponse(value)
}

export function isWorkerAbortResponse(value: unknown): value is WorkerAbortResponse {
  return isWorkerControlResponse(value)
}

export function isWorkerResumeResponse(value: unknown): value is WorkerResumeResponse {
  return isWorkerControlResponse(value)
}

/** Host control adapter contract used by T17 worker IPC handlers. */
export interface WorkerControlAdapter {
  steer(request: WorkerSteerRequest): WorkerSteerResponse | Promise<WorkerSteerResponse>
  abort(request: WorkerAbortRequest): WorkerAbortResponse | Promise<WorkerAbortResponse>
  resume(request: WorkerResumeRequest): WorkerResumeResponse | Promise<WorkerResumeResponse>
}

/** Control capability contracts; handlers are supplied by the active runtime. */
export interface WorkerControlCapabilityContracts {
  'workers.steer': { readonly request: WorkerSteerRequest; readonly response: WorkerSteerResponse }
  'workers.abort': { readonly request: WorkerAbortRequest; readonly response: WorkerAbortResponse }
  'workers.resume': { readonly request: WorkerResumeRequest; readonly response: WorkerResumeResponse }
}

export interface WorkerCapabilityContracts {
  'workers.list': { readonly request: WorkerListRequest; readonly response: WorkerListResponse }
  'workers.snapshot': { readonly request: WorkerSnapshotRequest; readonly response: WorkerSnapshot | null }
}

export interface WorkerEventContracts {
  'workers.events': { readonly payload: WorkerEvent }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends WorkerCapabilityContracts, WorkerControlCapabilityContracts {}
  interface IpcEventContracts extends WorkerEventContracts {}
}
