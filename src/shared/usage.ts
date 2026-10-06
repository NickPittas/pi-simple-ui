import { hasExactKeys, isPlainRecord, isRuntimeScope } from './ipc-contracts.ts'
import type { RuntimeScope } from './ipc-contracts.ts'

export const USAGE_IPC = Object.freeze({
  session: 'usage.session',
  turn: 'usage.turn',
  workers: 'usage.workers',
  models: 'usage.models',
  events: 'usage.events',
})

/** Null means the native record did not provide enough data for this value. */
export interface UsageTotals {
  readonly input: number | null
  readonly output: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
  /** Native USD cost converted to integer micro-dollars; never priced by this app. */
  readonly costMicros: number | null
  readonly turns: number | null
}

export type UsageUnknownMarker =
  | 'usage-unavailable'
  | 'cost-unavailable'
  | 'model-attribution-incomplete'
  | 'tool-usage-unattributed'
  | 'worker-provider-unavailable'
  | 'worker-usage-incomplete'

export type UsageMarker =
  | {
      readonly kind: 'compaction'
      readonly phase: 'start' | 'end' | 'recorded'
      readonly reason: 'manual' | 'threshold' | 'overflow' | null
      readonly timestamp: number
      readonly aborted?: boolean
      readonly willRetry?: boolean
    }
  | {
      readonly kind: 'retry'
      readonly phase: 'start' | 'end'
      readonly timestamp: number
      readonly attempt?: number
      readonly maxAttempts?: number
      readonly delayMs?: number
    }

export interface UsageWorkerTotals {
  readonly id: string
  readonly parentId: string | null
  readonly rootId: string
  /** Ancestor worker IDs ordered from root to immediate parent. */
  readonly ancestry: readonly string[]
  readonly name: string
  readonly model: string | null
  /** Includes this worker's descendants. Each row is hierarchical, not additive across rows. */
  readonly totals: UsageTotals
}

export interface UsageSessionRequest {
  readonly sessionId: string
}

export interface UsageTurnResponse {
  readonly runtime: RuntimeScope
  readonly sessionId: string
  readonly turn: UsageTotals
  readonly unknown: readonly UsageUnknownMarker[]
}

export interface UsageSessionResponse {
  readonly runtime: RuntimeScope
  readonly sessionId: string
  readonly branch: UsageTotals
  readonly session: UsageTotals
  readonly markers: readonly UsageMarker[]
  readonly unknown: readonly UsageUnknownMarker[]
}

export interface UsageWorkersResponse {
  readonly runtime: RuntimeScope
  readonly sessionId: string
  readonly workers: Readonly<Record<string, UsageWorkerTotals>>
  readonly unknown: readonly UsageUnknownMarker[]
}

export interface UsageModelsResponse {
  readonly runtime: RuntimeScope
  readonly sessionId: string
  readonly branch: Readonly<Record<string, UsageTotals>>
  readonly session: Readonly<Record<string, UsageTotals>>
  readonly unknown: readonly UsageUnknownMarker[]
}

export interface UsageEventPayload {
  readonly runtime: RuntimeScope
  readonly sessionId: string
  readonly turn: UsageTotals
  readonly branch: UsageTotals
  readonly session: UsageTotals
  readonly models: Readonly<Record<string, UsageTotals>>
  readonly workers: Readonly<Record<string, UsageWorkerTotals>>
  readonly markers: readonly UsageMarker[]
  readonly unknown: readonly UsageUnknownMarker[]
}

export interface UsageCapabilityContracts {
  'usage.session': {
    readonly request: UsageSessionRequest
    readonly response: UsageSessionResponse
  }
  'usage.turn': {
    readonly request: UsageSessionRequest
    readonly response: UsageTurnResponse
  }
  'usage.workers': {
    readonly request: UsageSessionRequest
    readonly response: UsageWorkersResponse
  }
  'usage.models': {
    readonly request: UsageSessionRequest
    readonly response: UsageModelsResponse
  }
}

export interface UsageEventContracts {
  'usage.events': { readonly payload: UsageEventPayload }
}

export function isUsageTotals(value: unknown): value is UsageTotals {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['input', 'output', 'cacheRead', 'cacheWrite', 'costMicros', 'turns'])) return false
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const item = value[key]
    if (item !== null && (typeof item !== 'number' || !Number.isFinite(item) || item < 0)) return false
  }
  const costMicros = value.costMicros
  const turns = value.turns
  return (costMicros === null || typeof costMicros === 'number'
    && Number.isSafeInteger(costMicros) && costMicros >= 0)
    && (turns === null || typeof turns === 'number'
      && Number.isSafeInteger(turns) && turns >= 0)
}

export function isUsageUnknownMarkers(value: unknown): value is readonly UsageUnknownMarker[] {
  return Array.isArray(value) && value.every((item) => [
    'usage-unavailable', 'cost-unavailable', 'model-attribution-incomplete', 'tool-usage-unattributed',
    'worker-provider-unavailable', 'worker-usage-incomplete',
  ].includes(String(item)))
}

export function isUsageModelMap(value: unknown): value is Readonly<Record<string, UsageTotals>> {
  return isPlainRecord(value)
    && Object.keys(value).length <= 10_000
    && Object.entries(value).every(([key, totals]) => key.length > 0 && key.length <= 1_024 && isUsageTotals(totals))
}

export function isUsageMarker(value: unknown): value is UsageMarker {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'compaction') {
    const keys = ['kind', 'phase', 'reason', 'timestamp']
    if (Object.hasOwn(value, 'aborted')) keys.push('aborted')
    if (Object.hasOwn(value, 'willRetry')) keys.push('willRetry')
    return hasExactKeys(value, keys)
      && (value.phase === 'start' || value.phase === 'end' || value.phase === 'recorded')
      && (value.reason === null || value.reason === 'manual' || value.reason === 'threshold' || value.reason === 'overflow')
      && Number.isFinite(value.timestamp)
      && (!Object.hasOwn(value, 'aborted') || typeof value.aborted === 'boolean')
      && (!Object.hasOwn(value, 'willRetry') || typeof value.willRetry === 'boolean')
  }
  if (value.kind === 'retry') {
    const keys = ['kind', 'phase', 'timestamp']
    for (const optional of ['attempt', 'maxAttempts', 'delayMs']) {
      if (Object.hasOwn(value, optional)) keys.push(optional)
    }
    return hasExactKeys(value, keys)
      && (value.phase === 'start' || value.phase === 'end')
      && Number.isFinite(value.timestamp)
      && ['attempt', 'maxAttempts', 'delayMs'].every((key) => !Object.hasOwn(value, key)
        || Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
  }
  return false
}

export function isUsageWorkerTotals(value: unknown): value is UsageWorkerTotals {
  return isPlainRecord(value)
    && hasExactKeys(value, ['id', 'parentId', 'rootId', 'ancestry', 'name', 'model', 'totals'])
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128
    && (value.parentId === null || typeof value.parentId === 'string' && value.parentId.length <= 128)
    && typeof value.rootId === 'string' && value.rootId.length > 0 && value.rootId.length <= 128
    && Array.isArray(value.ancestry) && value.ancestry.length <= 64
    && value.ancestry.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 128)
    && typeof value.name === 'string' && value.name.length <= 512
    && (value.model === null || typeof value.model === 'string' && value.model.length <= 512)
    && isUsageTotals(value.totals)
}

function isBaseResponse(value: unknown, extra: readonly string[]): value is Record<string, unknown> {
  return isPlainRecord(value)
    && hasExactKeys(value, ['runtime', 'sessionId', ...extra])
    && isRuntimeScope(value.runtime)
    && typeof value.sessionId === 'string'
    && /^[A-Za-z0-9._-]{1,128}$/.test(value.sessionId)
}

export function isUsageSessionRequest(value: unknown): value is UsageSessionRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['sessionId'])
    && typeof value.sessionId === 'string'
    && /^[A-Za-z0-9._-]{1,128}$/.test(value.sessionId)
}

export function isUsageTurnResponse(value: unknown): value is UsageTurnResponse {
  return isBaseResponse(value, ['turn', 'unknown'])
    && isUsageTotals(value.turn)
    && isUsageUnknownMarkers(value.unknown)
}

export function isUsageSessionResponse(value: unknown): value is UsageSessionResponse {
  return isBaseResponse(value, ['branch', 'session', 'markers', 'unknown'])
    && isUsageTotals(value.branch)
    && isUsageTotals(value.session)
    && Array.isArray(value.markers) && value.markers.length <= 500
    && value.markers.every(isUsageMarker)
    && isUsageUnknownMarkers(value.unknown)
}

export function isUsageWorkersResponse(value: unknown): value is UsageWorkersResponse {
  return isBaseResponse(value, ['workers', 'unknown'])
    && isPlainRecord(value.workers)
    && Object.keys(value.workers).length <= 10_000
    && Object.entries(value.workers).every(([id, worker]) => id === (worker as UsageWorkerTotals)?.id && isUsageWorkerTotals(worker))
    && isUsageUnknownMarkers(value.unknown)
}

export function isUsageModelsResponse(value: unknown): value is UsageModelsResponse {
  return isBaseResponse(value, ['branch', 'session', 'unknown'])
    && isUsageModelMap(value.branch)
    && isUsageModelMap(value.session)
    && isUsageUnknownMarkers(value.unknown)
}

export function isUsageEventPayload(value: unknown): value is UsageEventPayload {
  return isBaseResponse(value, ['turn', 'branch', 'session', 'models', 'workers', 'markers', 'unknown'])
    && isUsageTotals(value.turn)
    && isUsageTotals(value.branch)
    && isUsageTotals(value.session)
    && isUsageModelMap(value.models)
    && isPlainRecord(value.workers)
    && Object.keys(value.workers).length <= 10_000
    && Object.entries(value.workers).every(([id, worker]) => id === (worker as UsageWorkerTotals)?.id && isUsageWorkerTotals(worker))
    && Array.isArray(value.markers) && value.markers.length <= 500
    && value.markers.every(isUsageMarker)
    && isUsageUnknownMarkers(value.unknown)
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends UsageCapabilityContracts {}
  interface IpcEventContracts extends UsageEventContracts {}
}
