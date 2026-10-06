import type { CapabilityDefinition, EventDefinition } from './register.ts'
import {
  hasExactKeys,
  isPlainRecord,
  isRuntimeScope,
  type RuntimeScope,
} from '../../shared/ipc-contracts.ts'
import {
  CODEMODE_IPC,
  type CodemodeAbortRequest,
  type CodemodeAbortResponse,
  type CodemodeCallTrace,
  type CodemodeCapabilityContracts,
  type CodemodeCatalogRequest,
  type CodemodeCatalogResponse,
  type CodemodeEventPayload,
  type CodemodeExecutionSummary,
  type CodemodeGetRequest,
  type CodemodeGetResponse,
  type CodemodeJsonValue,
  type CodemodeListRequest,
  type CodemodeListResponse,
  type CodemodeTrace,
} from '../../shared/codemode.ts'
import type { CodemodeService } from '../codemode/codemode-service.ts'

export type CodemodeCapabilityDefinition = {
  [K in keyof CodemodeCapabilityContracts]: CapabilityDefinition<
    CodemodeCapabilityContracts[K]['request'],
    CodemodeCapabilityContracts[K]['response']
  >
}[keyof CodemodeCapabilityContracts]

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(value)
}

function isExecutionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0')
}

function isJsonValue(value: unknown): value is CodemodeJsonValue {
  const pending: unknown[] = [value]
  const visited = new WeakSet<object>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false
      continue
    }
    if (typeof current !== 'object') return false
    if (visited.has(current)) return false
    visited.add(current)
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item)
    } else {
      if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) return false
      for (const item of Object.values(current)) pending.push(item)
    }
  }
  return true
}

function hasOnlyAllowedKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const actual = Object.keys(value)
  return required.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => required.includes(key) || optional.includes(key))
}

function isSettings(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ['mode', 'inlineBudget', 'modelsEnabled'])
    && (value.mode === 'on' || value.mode === 'only')
    && typeof value.inlineBudget === 'number'
    && Number.isFinite(value.inlineBudget)
    && value.inlineBudget >= 0
    && typeof value.modelsEnabled === 'boolean'
}

function isBudgets(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      'timeoutMs', 'maxOutputTokens', 'memoryLimitBytes', 'maxOutputChars', 'maxOutputItems',
      'maxConcurrentModelCalls', 'maxToolCalls',
    ])
    && (value.timeoutMs === null || Number.isSafeInteger(value.timeoutMs) && (value.timeoutMs as number) > 0)
    && Number.isSafeInteger(value.maxOutputTokens)
    && (value.maxOutputTokens as number) >= 0
    && Number.isSafeInteger(value.memoryLimitBytes)
    && (value.memoryLimitBytes as number) > 0
    && Number.isSafeInteger(value.maxOutputChars)
    && (value.maxOutputChars as number) > 0
    && Number.isSafeInteger(value.maxOutputItems)
    && (value.maxOutputItems as number) > 0
    && Number.isSafeInteger(value.maxConcurrentModelCalls)
    && (value.maxConcurrentModelCalls as number) > 0
    && value.maxToolCalls === null
}

function isCallTrace(value: unknown): value is CodemodeCallTrace {
  if (!isPlainRecord(value)
    || !hasOnlyAllowedKeys(
      value,
      ['id', 'name', 'args', 'status', 'startedAt'],
      ['parentId', 'namespace', 'output', 'partialOutput', 'error', 'durationMs'],
    )) return false
  return typeof value.id === 'string'
    && typeof value.name === 'string'
    && (!Object.hasOwn(value, 'parentId') || typeof value.parentId === 'string')
    && (!Object.hasOwn(value, 'namespace') || typeof value.namespace === 'string')
    && isJsonValue(value.args)
    && (!Object.hasOwn(value, 'output') || isJsonValue(value.output))
    && (!Object.hasOwn(value, 'partialOutput') || isJsonValue(value.partialOutput))
    && (!Object.hasOwn(value, 'error') || typeof value.error === 'string')
    && ['running', 'completed', 'failed', 'aborted'].includes(String(value.status))
    && typeof value.startedAt === 'string'
    && (!Object.hasOwn(value, 'durationMs') || Number.isFinite(value.durationMs) && (value.durationMs as number) >= 0)
}

function isCodemodeTrace(value: unknown): value is CodemodeTrace {
  if (!isPlainRecord(value)
    || !hasOnlyAllowedKeys(
      value,
      ['executionId', 'sessionId', 'script', 'status', 'startedAt', 'calls', 'budgets', 'settings'],
      ['durationMs', 'output', 'fullOutput', 'partialOutput', 'error'],
    )) return false
  return isExecutionId(value.executionId)
    && isSessionId(value.sessionId)
    && typeof value.script === 'string'
    && ['running', 'completed', 'failed', 'aborted'].includes(String(value.status))
    && typeof value.startedAt === 'string'
    && Array.isArray(value.calls)
    && value.calls.every(isCallTrace)
    && isBudgets(value.budgets)
    && isSettings(value.settings)
    && (!Object.hasOwn(value, 'durationMs') || Number.isFinite(value.durationMs) && (value.durationMs as number) >= 0)
    && (!Object.hasOwn(value, 'output') || isJsonValue(value.output))
    && (!Object.hasOwn(value, 'fullOutput') || typeof value.fullOutput === 'string')
    && (!Object.hasOwn(value, 'partialOutput') || isJsonValue(value.partialOutput))
    && (!Object.hasOwn(value, 'error') || typeof value.error === 'string')
}

function isExecutionSummary(value: unknown): value is CodemodeExecutionSummary {
  if (!isPlainRecord(value)
    || !hasOnlyAllowedKeys(value, ['executionId', 'status', 'startedAt', 'callCount'], ['durationMs', 'error'])) return false
  return isExecutionId(value.executionId)
    && ['running', 'completed', 'failed', 'aborted'].includes(String(value.status))
    && typeof value.startedAt === 'string'
    && Number.isSafeInteger(value.callCount)
    && (value.callCount as number) >= 0
    && (!Object.hasOwn(value, 'durationMs') || Number.isFinite(value.durationMs) && (value.durationMs as number) >= 0)
    && (!Object.hasOwn(value, 'error') || typeof value.error === 'string')
}

function isListRequest(value: unknown): value is CodemodeListRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['sessionId']) && isSessionId(value.sessionId)
}

function isGetRequest(value: unknown): value is CodemodeGetRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['executionId']) && isExecutionId(value.executionId)
}

function isCatalogRequest(value: unknown): value is CodemodeCatalogRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['sessionId']) && isSessionId(value.sessionId)
}

function isAbortRequest(value: unknown): value is CodemodeAbortRequest {
  return isGetRequest(value)
}

function isListResponse(value: unknown): value is CodemodeListResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['sessionId', 'executions'])
    && isSessionId(value.sessionId)
    && Array.isArray(value.executions)
    && value.executions.every(isExecutionSummary)
}

function isGetResponse(value: unknown): value is CodemodeGetResponse {
  return value === null || isCodemodeTrace(value)
}

function isCatalogTool(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !hasOnlyAllowedKeys(value, ['name', 'description', 'exposure', 'parameters'], ['namespace', 'outputSchema'])) return false
  return typeof value.name === 'string'
    && typeof value.description === 'string'
    && typeof value.exposure === 'string'
    && (!Object.hasOwn(value, 'namespace') || typeof value.namespace === 'string')
    && isJsonValue(value.parameters)
    && (!Object.hasOwn(value, 'outputSchema') || isJsonValue(value.outputSchema))
}

function isCatalogNamespace(value: unknown): value is CodemodeCatalogResponse['namespaces'][number] {
  if (!isPlainRecord(value)
    || !hasOnlyAllowedKeys(value, ['name', 'tools'], ['description', 'instructions'])) return false
  return typeof value.name === 'string'
    && Array.isArray(value.tools)
    && value.tools.every((tool) => typeof tool === 'string')
    && (!Object.hasOwn(value, 'description') || typeof value.description === 'string')
    && (!Object.hasOwn(value, 'instructions') || typeof value.instructions === 'string')
}

function isCatalogResponse(value: unknown): value is CodemodeCatalogResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['sessionId', 'settings', 'namespaces', 'tools'])
    && isSessionId(value.sessionId)
    && isSettings(value.settings)
    && Array.isArray(value.namespaces)
    && value.namespaces.every(isCatalogNamespace)
    && Array.isArray(value.tools)
    && value.tools.every(isCatalogTool)
}

function isAbortResponse(value: unknown): value is CodemodeAbortResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['aborted', 'scope'])
    && typeof value.aborted === 'boolean'
    && (value.scope === 'turn' || value.scope === 'none')
}

function isEventPayload(value: unknown): value is CodemodeEventPayload {
  return isPlainRecord(value)
    && hasExactKeys(value, ['runtime', 'sessionId', 'execution'])
    && isRuntimeScope(value.runtime)
    && isSessionId(value.sessionId)
    && isCodemodeTrace(value.execution)
    && value.execution.sessionId === value.sessionId
}

function requireScope(scope: RuntimeScope | undefined): RuntimeScope {
  if (!scope) throw new Error('A runtime scope is required for Code Mode operations.')
  return scope
}

export function registerCodemodeCapabilities(service: CodemodeService): readonly CodemodeCapabilityDefinition[] {
  const list: CapabilityDefinition<CodemodeListRequest, CodemodeListResponse> = {
    id: CODEMODE_IPC.list,
    scope: 'runtime',
    validateRequest: isListRequest,
    validateResponse: isListResponse,
    handle: ({ scope }, request) => service.list(requireScope(scope), request.sessionId),
  }
  const get: CapabilityDefinition<CodemodeGetRequest, CodemodeGetResponse> = {
    id: CODEMODE_IPC.get,
    scope: 'runtime',
    validateRequest: isGetRequest,
    validateResponse: isGetResponse,
    handle: ({ scope }, request) => service.get(requireScope(scope), request.executionId),
  }
  const catalog: CapabilityDefinition<CodemodeCatalogRequest, CodemodeCatalogResponse> = {
    id: CODEMODE_IPC.catalog,
    scope: 'runtime',
    validateRequest: isCatalogRequest,
    validateResponse: isCatalogResponse,
    handle: ({ scope }, request) => service.catalog(requireScope(scope), request.sessionId),
  }
  const abort: CapabilityDefinition<CodemodeAbortRequest, CodemodeAbortResponse> = {
    id: CODEMODE_IPC.abort,
    scope: 'runtime',
    validateRequest: isAbortRequest,
    validateResponse: isAbortResponse,
    handle: ({ scope }, request) => service.abort(requireScope(scope), request.executionId),
  }
  return [list, get, catalog, abort]
}

export function registerCodemodeEvents(service: CodemodeService): readonly EventDefinition<CodemodeEventPayload>[] {
  const events: EventDefinition<CodemodeEventPayload> = {
    id: CODEMODE_IPC.events,
    scope: 'runtime',
    validatePayload: isEventPayload,
    subscribe: (context, publish) => service.subscribe(
      context.caller,
      requireScope(context.scope),
      publish,
    ),
  }
  return [events]
}
