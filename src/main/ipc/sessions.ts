import type { AuthorizedIpcCaller, CapabilityDefinition, EventDefinition } from './register.ts'
import {
  hasExactKeys,
  isPlainRecord,
  isRuntimeScope,
  type RuntimeScope,
} from '../../shared/ipc-contracts.ts'
import {
  SESSIONS_IPC,
  type SessionEventEnvelope,
  type SessionHistoryEntry,
  type SessionLeafInfo,
  type SessionRecoveryDiagnostic,
  type SessionSnapshot,
  type SessionsCapabilityContracts,
  type SessionsHistoryRequest,
  type SessionsHistoryResponse,
  type SessionsListRequest,
  type SessionsListResponse,
  type SessionsOpenRequest,
  type SessionsOpenResponse,
} from '../../shared/sessions.ts'

export type SessionsCapabilityDefinition = {
  [K in keyof SessionsCapabilityContracts]: CapabilityDefinition<
    SessionsCapabilityContracts[K]['request'],
    SessionsCapabilityContracts[K]['response']
  >
}[keyof SessionsCapabilityContracts]

export interface SessionsIpcService {
  list(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<SessionsListResponse> | SessionsListResponse
  open(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: SessionsOpenRequest): Promise<SessionsOpenResponse>
  history(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: SessionsHistoryRequest): Promise<SessionsHistoryResponse>
  subscribe(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    publish: (event: SessionEventEnvelope) => void,
  ): (() => void) | void
}

function isEmptyRequest(value: unknown): value is SessionsListRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

function isOpenRequest(value: unknown): value is SessionsOpenRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['sessionId'])
    && typeof value.sessionId === 'string'
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(value.sessionId)
}

function isHistoryRequest(value: unknown): value is SessionsHistoryRequest {
  if (!isPlainRecord(value)) return false
  const keys = ['sessionId']
  if (Object.hasOwn(value, 'offset')) keys.push('offset')
  if (Object.hasOwn(value, 'limit')) keys.push('limit')
  return hasExactKeys(value, keys)
    && typeof value.sessionId === 'string'
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(value.sessionId)
    && (!Object.hasOwn(value, 'offset')
      || Number.isSafeInteger(value.offset) && (value.offset as number) >= 0 && (value.offset as number) <= 1_000_000)
    && (!Object.hasOwn(value, 'limit')
      || Number.isSafeInteger(value.limit) && (value.limit as number) > 0 && (value.limit as number) <= 100)
}

function isLeaf(value: unknown): value is SessionLeafInfo {
  if (!isPlainRecord(value)) return false
  const keys = Object.hasOwn(value, 'label') ? ['id', 'type', 'timestamp', 'label'] : ['id', 'type', 'timestamp']
  return hasExactKeys(value, keys)
    && typeof value.id === 'string'
    && typeof value.type === 'string'
    && typeof value.timestamp === 'string'
    && (!Object.hasOwn(value, 'label') || typeof value.label === 'string')
}

function isSnapshot(value: unknown): value is SessionSnapshot {
  if (!isPlainRecord(value)) return false
  const keys = Object.hasOwn(value, 'name')
    ? ['id', 'name', 'cwd', 'createdAt', 'messageCount', 'activeLeaf']
    : ['id', 'cwd', 'createdAt', 'messageCount', 'activeLeaf']
  return hasExactKeys(value, keys)
    && typeof value.id === 'string'
    && (!Object.hasOwn(value, 'name') || typeof value.name === 'string')
    && typeof value.cwd === 'string'
    && typeof value.createdAt === 'string'
    && Number.isSafeInteger(value.messageCount)
    && (value.messageCount as number) >= 0
    && (value.activeLeaf === null || isLeaf(value.activeLeaf))
}

function isRecoveryDiagnostic(value: unknown): value is SessionRecoveryDiagnostic {
  return isPlainRecord(value)
    && hasExactKeys(value, ['file', 'reason'])
    && typeof value.file === 'string'
    && value.file.length <= 256
    && (value.reason === 'invalid-jsonl' || value.reason === 'invalid-session' || value.reason === 'unreadable')
}

function isListResponse(value: unknown): value is SessionsListResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['sessions', 'diagnostics'])
    && Array.isArray(value.sessions)
    && value.sessions.every(isSnapshot)
    && Array.isArray(value.diagnostics)
    && value.diagnostics.every(isRecoveryDiagnostic)
}

function isOpenResponse(value: unknown): value is SessionsOpenResponse {
  if (!isPlainRecord(value)) return false
  const keys = Object.hasOwn(value, 'sessionId') ? ['cancelled', 'sessionId'] : ['cancelled']
  return hasExactKeys(value, keys)
    && typeof value.cancelled === 'boolean'
    && (!Object.hasOwn(value, 'sessionId') || typeof value.sessionId === 'string')
}

function isSessionJsonValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (depth >= 7) return false
  if (Array.isArray(value)) return value.length <= 50 && value.every((item) => isSessionJsonValue(item, depth + 1))
  if (!isPlainRecord(value) || Object.keys(value).length > 50) return false
  return Object.values(value).every((item) => isSessionJsonValue(item, depth + 1))
}

function isContentPart(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'text' || value.type === 'thinking') {
    return hasExactKeys(value, ['type', 'text']) && typeof value.text === 'string' && value.text.length <= 8192
  }
  if (value.type === 'image') {
    return hasExactKeys(value, ['type', 'mimeType']) && typeof value.mimeType === 'string' && value.mimeType.length <= 128
  }
  return value.type === 'structured'
    && hasExactKeys(value, ['type', 'value'])
    && isSessionJsonValue(value.value)
}

function isHistoryEntry(value: unknown): value is SessionHistoryEntry {
  if (!isPlainRecord(value)) return false
  const keys = ['id', 'parentId', 'type', 'timestamp']
  for (const optional of ['label', 'content', 'summary', 'data']) {
    if (Object.hasOwn(value, optional)) keys.push(optional)
  }
  return hasExactKeys(value, keys)
    && typeof value.id === 'string'
    && (value.parentId === null || typeof value.parentId === 'string')
    && typeof value.type === 'string'
    && typeof value.timestamp === 'string'
    && (!Object.hasOwn(value, 'label') || typeof value.label === 'string')
    && (!Object.hasOwn(value, 'content') || Array.isArray(value.content) && value.content.every(isContentPart))
    && (!Object.hasOwn(value, 'summary') || typeof value.summary === 'string')
    && (!Object.hasOwn(value, 'data') || isSessionJsonValue(value.data))
}

function isHistoryResponse(value: unknown): value is SessionsHistoryResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['sessionId', 'offset', 'limit', 'entries', 'nextOffset', 'activeLeaf'])
    && typeof value.sessionId === 'string'
    && Number.isSafeInteger(value.offset)
    && (value.offset as number) >= 0
    && Number.isSafeInteger(value.limit)
    && (value.limit as number) > 0
    && (value.limit as number) <= 100
    && Array.isArray(value.entries)
    && value.entries.every(isHistoryEntry)
    && (value.nextOffset === null || Number.isSafeInteger(value.nextOffset))
    && (value.activeLeaf === null || isLeaf(value.activeLeaf))
}

function isSessionEventEnvelope(value: unknown): value is SessionEventEnvelope {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['runtime', 'sessionGeneration', 'sessionId', 'event'])
    || !isRuntimeScope(value.runtime)
    || !Number.isSafeInteger(value.sessionGeneration)
    || (value.sessionGeneration as number) < 0
    || typeof value.sessionId !== 'string'
    || !isPlainRecord(value.event)
    || typeof value.event.type !== 'string') return false
  const event = value.event
  if (event.type === 'turn-start' || event.type === 'terminal') {
    return event.type === 'turn-start'
      ? hasExactKeys(event, ['type'])
      : hasExactKeys(event, ['type', 'reason'])
        && ['completed', 'aborted', 'error'].includes(String(event.reason))
  }
  if (event.type === 'text-delta' || event.type === 'thinking-delta') {
    return hasExactKeys(event, ['type', 'contentIndex', 'delta'])
      && Number.isSafeInteger(event.contentIndex)
      && typeof event.delta === 'string'
      && event.delta.length <= 8192
  }
  if (event.type === 'structured-content') {
    const keys = Object.hasOwn(event, 'delta') ? ['type', 'contentIndex', 'delta'] : ['type', 'contentIndex', 'value']
    return hasExactKeys(event, keys)
      && Number.isSafeInteger(event.contentIndex)
      && (!Object.hasOwn(event, 'delta') || typeof event.delta === 'string' && event.delta.length <= 8192)
      && (!Object.hasOwn(event, 'value') || isSessionJsonValue(event.value))
  }
  if (event.type === 'tool-start') {
    return hasExactKeys(event, ['type', 'toolCallId', 'toolName', 'arguments'])
      && typeof event.toolCallId === 'string'
      && typeof event.toolName === 'string'
      && isSessionJsonValue(event.arguments)
  }
  if (event.type === 'tool-update') {
    return hasExactKeys(event, ['type', 'toolCallId', 'toolName', 'arguments', 'result'])
      && typeof event.toolCallId === 'string'
      && typeof event.toolName === 'string'
      && isSessionJsonValue(event.arguments)
      && isSessionJsonValue(event.result)
  }
  if (event.type === 'tool-end') {
    const keys = Object.hasOwn(event, 'error')
      ? ['type', 'toolCallId', 'toolName', 'arguments', 'result', 'isError', 'error']
      : ['type', 'toolCallId', 'toolName', 'arguments', 'result', 'isError']
    return hasExactKeys(event, keys)
      && typeof event.toolCallId === 'string'
      && typeof event.toolName === 'string'
      && isSessionJsonValue(event.arguments)
      && isSessionJsonValue(event.result)
      && typeof event.isError === 'boolean'
      && (!Object.hasOwn(event, 'error') || typeof event.error === 'string')
  }
  if (event.type === 'retry') {
    return hasExactKeys(event, ['type', 'attempt', 'maxAttempts', 'delayMs', 'message'])
      && Number.isSafeInteger(event.attempt)
      && Number.isSafeInteger(event.maxAttempts)
      && Number.isSafeInteger(event.delayMs)
      && typeof event.message === 'string'
  }
  if (event.type === 'compaction') {
    const keys = ['type', 'phase', 'reason']
    if (Object.hasOwn(event, 'aborted')) keys.push('aborted')
    if (Object.hasOwn(event, 'willRetry')) keys.push('willRetry')
    if (Object.hasOwn(event, 'message')) keys.push('message')
    return hasExactKeys(event, keys)
      && (event.phase === 'start' || event.phase === 'end')
      && ['manual', 'threshold', 'overflow'].includes(String(event.reason))
      && (!Object.hasOwn(event, 'aborted') || typeof event.aborted === 'boolean')
      && (!Object.hasOwn(event, 'willRetry') || typeof event.willRetry === 'boolean')
      && (!Object.hasOwn(event, 'message') || typeof event.message === 'string')
  }
  if (event.type === 'summary') {
    return hasExactKeys(event, ['type', 'kind', 'text'])
      && (event.kind === 'compaction' || event.kind === 'branch')
      && typeof event.text === 'string'
  }
  if (event.type === 'turn-end') {
    return hasExactKeys(event, ['type', 'stopReason', 'usage'])
      && typeof event.stopReason === 'string'
      && isPlainRecord(event.usage)
      && hasExactKeys(event.usage, ['input', 'output', 'cacheRead', 'cacheWrite', 'total'])
      && Object.values(event.usage).every((item) => typeof item === 'number' && Number.isFinite(item))
  }
  return event.type === 'error'
    && hasExactKeys(event, ['type', 'message', 'source'])
    && typeof event.message === 'string'
    && (event.source === 'assistant' || event.source === 'tool' || event.source === 'runtime')
}

function requireScope(scope: RuntimeScope | undefined): RuntimeScope {
  if (!scope) throw new Error('A runtime scope is required for session operations.')
  return scope
}

export function registerSessionsCapabilities(service: SessionsIpcService): readonly SessionsCapabilityDefinition[] {
  const list: CapabilityDefinition<SessionsListRequest, SessionsListResponse> = {
    id: SESSIONS_IPC.list,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isListResponse,
    handle: ({ caller, scope }) => service.list(caller, requireScope(scope)),
  }
  const open: CapabilityDefinition<SessionsOpenRequest, SessionsOpenResponse> = {
    id: SESSIONS_IPC.open,
    scope: 'runtime',
    validateRequest: isOpenRequest,
    validateResponse: isOpenResponse,
    handle: ({ caller, scope }, request) => service.open(caller, requireScope(scope), request),
  }
  const history: CapabilityDefinition<SessionsHistoryRequest, SessionsHistoryResponse> = {
    id: SESSIONS_IPC.history,
    scope: 'runtime',
    validateRequest: isHistoryRequest,
    validateResponse: isHistoryResponse,
    handle: ({ caller, scope }, request) => service.history(caller, requireScope(scope), request),
  }
  return [list, open, history]
}

export function registerSessionsEvents(service: SessionsIpcService): readonly EventDefinition<SessionEventEnvelope>[] {
  const events: EventDefinition<SessionEventEnvelope> = {
    id: SESSIONS_IPC.events,
    scope: 'runtime',
    validatePayload: isSessionEventEnvelope,
    subscribe: (context, publish) => service.subscribe(
      context.caller,
      requireScope(context.scope),
      publish,
    ),
  }
  return [events]
}
