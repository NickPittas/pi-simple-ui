import type {
  NativePiAck,
  NativePiEnvelope,
  NativePiSessionSnapshot,
  NativePiSnapshot,
  NativeTransportStatus,
  NativeModelChoice,
  NativeModelState,
  NativeModelStateResult,
  NativeSessionSummary,
  NativeSessionsResult,
  NativeCommandsResult,
  AbortRequest,
  NativeThinkingLevel,
  OpenSessionRequest,
  OpenSessionResult,
  SetModelRequest,
  SetThinkingRequest,
  NativeBridgeCommand,
  NativeBridgeRequest,
  SnapshotRequest,
  SubmitRequest,
  TerminalInput,
  TerminalOutput,
  TerminalSize,
} from './native-pi.ts'
import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'
import { isWorkspaceSnapshot } from './workspaces.ts'

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const generation = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const identifierList = (value: unknown): value is string[] => Array.isArray(value) && isJson(value) && value.every(nonempty)

function isJson(value: unknown): boolean {
  const active = new WeakSet<object>()
  const stack: { value: unknown; exit?: object }[] = [{ value }]
  try {
    while (stack.length) {
      const item = stack.pop()!
      if (item.exit) { active.delete(item.exit); continue }
      const current = item.value
      if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
      if (typeof current === 'number') { if (!Number.isFinite(current)) return false; continue }
      if (typeof current !== 'object' || active.has(current)) return false
      if (!Array.isArray(current) && !isPlainRecord(current)) return false
      active.add(current)
      stack.push({ value: null, exit: current })
      if (Array.isArray(current)) {
        for (let i = 0; i < current.length; i++) {
          if (!Object.hasOwn(current, i)) return false
          const descriptor = Object.getOwnPropertyDescriptor(current, String(i))
          if (!descriptor || !('value' in descriptor)) return false
          stack.push({ value: descriptor.value })
        }
      } else {
        for (const key of Object.keys(current)) {
          const descriptor = Object.getOwnPropertyDescriptor(current, key)
          if (!descriptor || !('value' in descriptor)) return false
          stack.push({ value: descriptor.value })
        }
      }
    }
    return true
  } catch { return false }
}

function isSession(value: unknown): value is NativePiSessionSnapshot {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['sessionId', 'sessionGeneration', 'name', 'file', 'cwd', 'classification', 'parentSessionId', 'entries', 'activeLeaf', 'activeBranch', 'partial', 'metadata'])) return false
  return nonempty(value.sessionId) && generation(value.sessionGeneration)
    && (value.name === null || typeof value.name === 'string')
    && (value.file === null || typeof value.file === 'string')
    && (value.cwd === null || typeof value.cwd === 'string')
    && ['root', 'child', 'unknown'].includes(value.classification as string)
    && (value.parentSessionId === null || nonempty(value.parentSessionId))
    && Array.isArray(value.entries) && isJson(value.entries)
    && (value.activeLeaf === null || nonempty(value.activeLeaf))
    && (value.activeBranch === null || identifierList(value.activeBranch))
    && (value.partial === null || isJson(value.partial)) && isJson(value.metadata)
}

export function isNativePiEnvelope(value: unknown): value is NativePiEnvelope {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['version', 'processGeneration', 'sequence', 'sessionId', 'sessionGeneration', 'kind', 'payload'])) return false
  return value.version === 1 && generation(value.processGeneration) && generation(value.sequence)
    && (value.sessionId === null ? value.sessionGeneration === null : nonempty(value.sessionId) && generation(value.sessionGeneration))
    && ['root', 'snapshot', 'event', 'status', 'gap'].includes(value.kind as string) && isJson(value.payload)
}

export function isNativePiSnapshot(value: unknown): value is NativePiSnapshot {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['snapshotId', 'processGeneration', 'sequence', 'state', 'rootSessionId', 'sessions', 'nextCursor', 'error'])) return false
  return nonempty(value.snapshotId) && generation(value.processGeneration) && generation(value.sequence)
    && ['starting', 'ready', 'disconnected', 'unsupported', 'exited', 'gap'].includes(value.state as string)
    && (value.rootSessionId === null || nonempty(value.rootSessionId))
    && Array.isArray(value.sessions) && isJson(value.sessions) && value.sessions.every(isSession)
    && (value.nextCursor === null || nonempty(value.nextCursor)) && (value.error === null || typeof value.error === 'string')
}

export function isSnapshotRequest(value: unknown): value is SnapshotRequest {
  return isPlainRecord(value) && (hasExactKeys(value, []) || (hasExactKeys(value, ['cursor']) && nonempty(value.cursor)))
}

export function isSubmitRequest(value: unknown): value is SubmitRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['requestId', 'sessionId', 'sessionGeneration', 'text'])
    && nonempty(value.requestId) && nonempty(value.sessionId) && generation(value.sessionGeneration) && typeof value.text === 'string'
}

export function isNativePiAck(value: unknown): value is NativePiAck {
  return isPlainRecord(value) && hasExactKeys(value, ['requestId', 'outcome', 'reason'])
    && nonempty(value.requestId) && ['accepted', 'rejected', 'unknown'].includes(value.outcome as string)
    && (value.reason === null || typeof value.reason === 'string')
}

const thinkingLevels: NativeThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const isNativeThinkingLevel = (value: unknown): value is NativeThinkingLevel => thinkingLevels.includes(value as NativeThinkingLevel)
const isEmpty = (value: unknown): boolean => isPlainRecord(value) && hasExactKeys(value, [])
const hasSessionTarget = (value: Record<string, unknown>): boolean => nonempty(value.sessionId) && generation(value.sessionGeneration)

export function isNativePiSessionTarget(value: unknown): value is { sessionId: string; sessionGeneration: number } {
  return isPlainRecord(value) && hasExactKeys(value, ['sessionId', 'sessionGeneration']) && hasSessionTarget(value)
}

export function isNativePiModelChoice(value: unknown): value is NativeModelChoice {
  return isPlainRecord(value) && hasExactKeys(value, ['provider', 'id', 'name'])
    && nonempty(value.provider) && nonempty(value.id) && typeof value.name === 'string'
}

export function isNativePiModelState(value: unknown): value is NativeModelState {
  return isPlainRecord(value) && hasExactKeys(value, ['sessionId', 'sessionGeneration', 'processGeneration', 'sequence', 'model', 'models', 'allModels', 'scoped', 'thinkingLevel', 'thinkingLevels', 'busy'])
    && hasSessionTarget(value) && generation(value.processGeneration) && generation(value.sequence)
    && (value.model === null || isNativePiModelChoice(value.model))
    && Array.isArray(value.models) && isJson(value.models) && value.models.every(isNativePiModelChoice)
    && Array.isArray(value.allModels) && isJson(value.allModels) && value.allModels.every(isNativePiModelChoice)
    && typeof value.scoped === 'boolean'
    && (value.thinkingLevel === null || isNativeThinkingLevel(value.thinkingLevel))
    && Array.isArray(value.thinkingLevels) && isJson(value.thinkingLevels) && value.thinkingLevels.every(isNativeThinkingLevel)
    && typeof value.busy === 'boolean'
}

export function isNativePiModelStateResult(value: unknown): value is NativeModelStateResult {
  return isPlainRecord(value) && hasExactKeys(value, ['state', 'error'])
    && (value.state === null ? nonempty(value.error) : isNativePiModelState(value.state) && value.error === null)
}

export function isNativePiSessionSummary(value: unknown): value is NativeSessionSummary {
  const isoTime = (time: unknown): boolean => typeof time === 'string' && time.length <= 64
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(time) && !Number.isNaN(Date.parse(time))
  return isPlainRecord(value) && hasExactKeys(value, ['sessionId', 'file', 'name', 'created', 'modified', 'firstMessage', 'messageCount', 'branched'])
    && nonempty(value.sessionId) && value.sessionId.length <= 256
    && typeof value.file === 'string' && value.file.length <= 4096
    && (value.name === null || (typeof value.name === 'string' && value.name.length <= 1000))
    && isoTime(value.created) && isoTime(value.modified)
    && typeof value.firstMessage === 'string' && value.firstMessage.length <= 200
    && typeof value.messageCount === 'number' && Number.isSafeInteger(value.messageCount) && value.messageCount >= 0
    && typeof value.branched === 'boolean'
}

export function isNativePiSessionsResult(value: unknown): value is NativeSessionsResult {
  return isPlainRecord(value) && hasExactKeys(value, ['sessions', 'error'])
    && Array.isArray(value.sessions) && value.sessions.length <= 200 && isJson(value.sessions) && value.sessions.every(isNativePiSessionSummary)
    && (value.error === null || nonempty(value.error))
    && (value.error === null || value.sessions.length === 0)
}

export const NATIVE_COMMANDS_MAX = 2000
export function isNativeCommandSourceInfo(value: unknown): boolean {
  return isPlainRecord(value) && hasExactKeys(value, ['path', 'source', 'scope', 'origin', 'baseDir'])
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096 && !value.path.includes('\0')
    && typeof value.source === 'string' && value.source.length <= 2048
    && (value.scope === 'user' || value.scope === 'project' || value.scope === 'temporary')
    && (value.origin === 'package' || value.origin === 'top-level')
    && (value.baseDir === null || (typeof value.baseDir === 'string' && value.baseDir.length > 0 && value.baseDir.length <= 4096 && !value.baseDir.includes('\0')))
}
export function isNativePiCommandsResult(value: unknown): value is NativeCommandsResult {
  return isPlainRecord(value) && hasExactKeys(value, ['commands', 'error'])
    && Array.isArray(value.commands) && value.commands.length <= NATIVE_COMMANDS_MAX
    && value.commands.every((entry) => isPlainRecord(entry)
      && hasExactKeys(entry, Object.hasOwn(entry, 'sourceInfo') ? ['name', 'description', 'source', 'sourceInfo'] : ['name', 'description', 'source'])
      && (!Object.hasOwn(entry, 'sourceInfo') || entry.sourceInfo === null || isNativeCommandSourceInfo(entry.sourceInfo))
      && nonempty(entry.name) && (entry.description === null || typeof entry.description === 'string')
      && ['extension', 'prompt', 'skill'].includes(entry.source as string))
    && (value.error === null || nonempty(value.error))
    && (value.error === null || value.commands.length === 0)
}

export function isAbortRequest(value: unknown): value is AbortRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['sessionId', 'sessionGeneration', 'requestId'])
    && hasSessionTarget(value) && nonempty(value.requestId)
}

export function isSetModelRequest(value: unknown): value is SetModelRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['sessionId', 'sessionGeneration', 'requestId', 'provider', 'modelId'])
    && hasSessionTarget(value) && nonempty(value.requestId) && nonempty(value.provider) && nonempty(value.modelId)
}

export function isSetThinkingRequest(value: unknown): value is SetThinkingRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['sessionId', 'sessionGeneration', 'requestId', 'level'])
    && hasSessionTarget(value) && nonempty(value.requestId) && isNativeThinkingLevel(value.level)
}

export function isOpenSessionRequest(value: unknown): value is OpenSessionRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['workspaceId', 'expectedProcessGeneration', 'expectedSessionId', 'file'])
    && nonempty(value.workspaceId) && generation(value.expectedProcessGeneration) && nonempty(value.expectedSessionId)
    && (value.file === null || typeof value.file === 'string')
}

export function isOpenSessionResult(value: unknown): value is OpenSessionResult {
  return isPlainRecord(value) && hasExactKeys(value, ['outcome', 'reason', 'snapshot'])
    && ['opened', 'failed'].includes(value.outcome as string)
    && (value.outcome === 'opened' ? value.reason === null : nonempty(value.reason))
    && isWorkspaceSnapshot(value.snapshot)
}

export function isNativePiControlCommand(value: unknown): value is Extract<NativeBridgeCommand, { operation: 'model-state' | 'set-model' | 'set-thinking' | 'sessions-list' | 'commands-list' | 'abort' }> {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['operation', 'payload'])) return false
  if (value.operation === 'model-state' || value.operation === 'sessions-list' || value.operation === 'commands-list') return isEmpty(value.payload)
  if (value.operation === 'abort') return isAbortRequest(value.payload)
  if (value.operation === 'set-model') return isSetModelRequest(value.payload)
  if (value.operation === 'set-thinking') return isSetThinkingRequest(value.payload)
  return false
}

export function isNativePiControlRequest(value: unknown): value is Extract<NativeBridgeRequest, { operation: 'model-state' | 'set-model' | 'set-thinking' | 'sessions-list' | 'commands-list' | 'abort' }> {
  if (!isPlainRecord(value) || !nonempty(value.requestId)) return false
  if (value.operation === 'abort')
    return hasExactKeys(value, ['requestId', 'operation', 'payload']) && isAbortRequest(value.payload)
  if (value.operation === 'model-state' || value.operation === 'sessions-list' || value.operation === 'commands-list')
    return hasExactKeys(value, ['requestId', 'operation', 'payload']) && isEmpty(value.payload)
  if (value.operation === 'set-model' || value.operation === 'set-thinking')
    return hasExactKeys(value, ['requestId', 'operation', 'payload'])
      && (value.operation === 'set-model' ? isSetModelRequest(value.payload) : isSetThinkingRequest(value.payload))
  return false
}

export function isNativePiControlReply(request: Extract<NativeBridgeRequest, { operation: 'model-state' | 'set-model' | 'set-thinking' | 'sessions-list' | 'commands-list' | 'abort' }>, value: unknown): boolean {
  if (request.operation === 'model-state') return isNativePiModelStateResult(value)
  if (request.operation === 'sessions-list') return isNativePiSessionsResult(value)
  if (request.operation === 'commands-list') return isNativePiCommandsResult(value)
  if (request.operation === 'abort') return isNativePiAck(value) && value.requestId === request.payload.requestId
  if (request.operation === 'set-model' || request.operation === 'set-thinking')
    return isNativePiAck(value) && value.requestId === request.payload.requestId
  return false
}

export function isTerminalInput(value: unknown): value is TerminalInput {
  return isPlainRecord(value) && hasExactKeys(value, ['requestId', 'data']) && nonempty(value.requestId) && typeof value.data === 'string'
}

export function isTerminalSize(value: unknown): value is TerminalSize {
  return isPlainRecord(value) && hasExactKeys(value, ['columns', 'rows'])
    && Number.isSafeInteger(value.columns) && (value.columns as number) > 0
    && Number.isSafeInteger(value.rows) && (value.rows as number) > 0
}

export function isTerminalOutput(value: unknown): value is TerminalOutput {
  return isPlainRecord(value) && hasExactKeys(value, ['processGeneration', 'sequence', 'data', 'gap'])
    && generation(value.processGeneration) && generation(value.sequence) && typeof value.data === 'string' && typeof value.gap === 'boolean'
}

export function isNativeTransportStatus(value: unknown): value is NativeTransportStatus {
  return isPlainRecord(value) && hasExactKeys(value, ['processGeneration', 'state', 'reason'])
    && generation(value.processGeneration) && ['waiting', 'connected', 'disconnected', 'disposed'].includes(value.state as string)
    && (value.reason === null || typeof value.reason === 'string')
}
