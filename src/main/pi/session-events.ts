import type {
  AgentSession,
  AgentSessionEvent,
} from '@earendil-works/pi-coding-agent'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type {
  SessionContentPart,
  SessionEvent,
  SessionEventEnvelope,
  SessionJsonValue,
  SessionUsageDTO,
} from '../../shared/sessions.ts'

const MAX_TEXT_LENGTH = 8192
const MAX_COLLECTION_ITEMS = 50
const MAX_OBJECT_KEYS = 50
const REDACTED = '[redacted]'
const SENSITIVE_KEY = /(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|credential|password|secret|cookie)/i

function boundedText(value: string, limit = MAX_TEXT_LENGTH): string {
  return value
    .replace(/(\bBearer\s+)[^\s,;"']+/gi, `$1${REDACTED}`)
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/((?:api[-_ ]?key|token|secret|password)\s*[:=]\s*)[^\s,;"']+/gi, `$1${REDACTED}`)
    .slice(0, limit)
}

export function toSessionJson(value: unknown, depth = 0, seen = new WeakSet<object>()): SessionJsonValue {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return boundedText(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return null
  if (depth >= 6) return '[truncated]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    return (value as unknown[])
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => toSessionJson(item, depth + 1, seen))
  }
  const result: Record<string, SessionJsonValue> = {}
  for (const [rawKey, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
    const key = boundedText(rawKey, 128)
    if (SENSITIVE_KEY.test(key)) {
      result[key] = REDACTED
    } else if (key === 'base64' || key === 'data' && typeof item === 'string' && item.length > 256) {
      result[key] = '[omitted]'
    } else {
      result[key] = toSessionJson(item, depth + 1, seen)
    }
  }
  return result
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function toSessionContentParts(value: unknown): SessionContentPart[] {
  if (typeof value === 'string') return [{ type: 'text', text: boundedText(value) }]
  if (!Array.isArray(value)) return []
  const result: SessionContentPart[] = []
  for (const partValue of (value as unknown[]).slice(0, MAX_COLLECTION_ITEMS)) {
    const part = objectRecord(partValue)
    if (!part || typeof part.type !== 'string') continue
    if (part.type === 'text' && typeof part.text === 'string') {
      result.push({ type: 'text', text: boundedText(part.text) })
    } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
      result.push({ type: 'thinking', text: boundedText(part.thinking) })
    } else if (part.type === 'image') {
      result.push({ type: 'image', mimeType: typeof part.mimeType === 'string' ? boundedText(part.mimeType, 128) : 'application/octet-stream' })
    } else if (part.type === 'toolCall') {
      result.push({ type: 'structured', value: toSessionJson(part) })
    } else {
      result.push({ type: 'structured', value: toSessionJson(part) })
    }
  }
  return result
}

function usageDto(message: unknown): SessionUsageDTO {
  const usage = objectRecord(objectRecord(message)?.usage)
  const number = (key: string): number => {
    const value = usage?.[key]
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  }
  return {
    input: number('input'),
    output: number('output'),
    cacheRead: number('cacheRead'),
    cacheWrite: number('cacheWrite'),
    total: number('totalTokens') || number('input') + number('output'),
  }
}

function toolResultDto(value: unknown): SessionJsonValue {
  const result = objectRecord(value)
  if (!result) return toSessionJson(value)
  const content = toSessionContentParts(result.content)
  return {
    ...(content.length > 0 ? { content: content.map((part) => toSessionJson(part)) } : {}),
    ...(Object.hasOwn(result, 'structuredContent') ? { structuredContent: toSessionJson(result.structuredContent) } : {}),
    ...(Object.hasOwn(result, 'details') ? { details: toSessionJson(result.details) } : {}),
    ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}),
  }
}

function safeError(value: unknown): string {
  return boundedText(typeof value === 'string' ? value : 'The Pi runtime reported an error.')
}

function normalizeMessageUpdate(event: Extract<AgentSessionEvent, { type: 'message_update' }>): SessionEvent[] {
  const part = event.assistantMessageEvent
  switch (part.type) {
    case 'text_delta':
      return [{ type: 'text-delta', contentIndex: part.contentIndex, delta: boundedText(part.delta) }]
    case 'thinking_delta':
      return [{ type: 'thinking-delta', contentIndex: part.contentIndex, delta: boundedText(part.delta) }]
    case 'toolcall_start': {
      const content = objectRecord(event.message)?.content
      return [{
        type: 'structured-content',
        contentIndex: part.contentIndex,
        value: toSessionJson(Array.isArray(content) ? (content as unknown[])[part.contentIndex] : null),
      }]
    }
    case 'toolcall_delta':
      return [{ type: 'structured-content', contentIndex: part.contentIndex, delta: boundedText(part.delta) }]
    case 'toolcall_end':
      return [{ type: 'structured-content', contentIndex: part.contentIndex, value: toSessionJson(part.toolCall) }]
    default:
      return []
  }
}

function normalizeEvent(
  event: AgentSessionEvent,
  toolArguments: Map<string, SessionJsonValue>,
): SessionEvent[] {
  if (event.type === 'turn_start') return [{ type: 'turn-start' }]
  if (event.type === 'message_update') return normalizeMessageUpdate(event)
  if (event.type === 'turn_end') {
    const message = objectRecord(event.message)
    if (message?.role === 'assistant') {
      const stopReason = typeof message.stopReason === 'string' ? message.stopReason : 'unknown'
      return [{ type: 'turn-end', stopReason, usage: usageDto(message) }]
    }
    return []
  }
  if (event.type === 'tool_execution_start') {
    const args = toSessionJson(event.args)
    toolArguments.set(event.toolCallId, args)
    return [{
      type: 'tool-start',
      toolCallId: boundedText(event.toolCallId, 256),
      toolName: boundedText(event.toolName, 256),
      arguments: args,
    }]
  }
  if (event.type === 'tool_execution_update') {
    return [{
      type: 'tool-update',
      toolCallId: boundedText(event.toolCallId, 256),
      toolName: boundedText(event.toolName, 256),
      arguments: toSessionJson(event.args),
      result: toolResultDto(event.partialResult),
    }]
  }
  if (event.type === 'tool_execution_end') {
    const result = toolResultDto(event.result)
    const args = toolArguments.get(event.toolCallId) ?? null
    toolArguments.delete(event.toolCallId)
    const errorText = event.isError
      ? safeError(objectRecord(event.result)?.error ?? objectRecord(event.result)?.message)
      : undefined
    return [
      {
        type: 'tool-end',
        toolCallId: boundedText(event.toolCallId, 256),
        toolName: boundedText(event.toolName, 256),
        arguments: args,
        result,
        isError: event.isError,
        ...(errorText ? { error: errorText } : {}),
      },
      ...(event.isError && errorText ? [{ type: 'error' as const, message: errorText, source: 'tool' as const }] : []),
    ]
  }
  if (event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled') {
    return [{
      type: 'retry',
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      message: safeError(event.errorMessage),
    }]
  }
  if (event.type === 'auto_retry_end') {
    return event.success || !event.finalError
      ? []
      : [{ type: 'error', message: safeError(event.finalError), source: 'runtime' }]
  }
  if (event.type === 'summarization_retry_attempt_start') {
    return [{ type: 'retry', attempt: 0, maxAttempts: 0, delayMs: 0, message: `Summary retry (${event.source}).` }]
  }
  if (event.type === 'compaction_start') {
    return [{ type: 'compaction', phase: 'start', reason: event.reason }]
  }
  if (event.type === 'compaction_end') {
    return [
      {
        type: 'compaction',
        phase: 'end',
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        ...(event.errorMessage ? { message: safeError(event.errorMessage) } : {}),
      },
      ...(event.errorMessage ? [{ type: 'error' as const, message: safeError(event.errorMessage), source: 'runtime' as const }] : []),
    ]
  }
  if (event.type === 'entry_appended') {
    if (event.entry.type === 'compaction' || event.entry.type === 'branch_summary') {
      return [{ type: 'summary', kind: event.entry.type === 'compaction' ? 'compaction' : 'branch', text: boundedText(event.entry.summary) }]
    }
    return []
  }
  if (event.type === 'message_end') {
    const message = objectRecord(event.message)
    if (message?.role === 'assistant' && message.stopReason === 'error') {
      return [{ type: 'error', message: safeError(message.errorMessage), source: 'assistant' }]
    }
    return []
  }
  if (event.type === 'bash_execution_update') {
    return [{
      type: 'tool-update',
      toolCallId: boundedText(event.id ?? 'bash', 256),
      toolName: 'bash',
      arguments: null,
      result: toSessionJson({ delta: event.delta }),
    }]
  }
  return []
}

function sameScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return left.ownerId === right.ownerId && left.generation === right.generation
}

export class PiSessionEventStream {
  private session: AgentSession | undefined
  private unsubscribeSession: (() => void) | undefined
  private runtimeScopeProvider: () => RuntimeScope | undefined = () => undefined
  private readonly listeners = new Set<(event: SessionEventEnvelope) => void>()
  private generation = 0
  private lastStopReason = 'stop'
  private toolArguments = new Map<string, SessionJsonValue>()

  constructor(session: AgentSession) {
    this.bind(session)
  }

  get sessionGeneration(): number {
    return this.generation
  }

  setRuntimeScopeProvider(provider: () => RuntimeScope | undefined): void {
    this.runtimeScopeProvider = provider
  }

  subscribe(listener: (event: SessionEventEnvelope) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  invalidate(): void {
    this.generation += 1
    this.unsubscribeSession?.()
    this.unsubscribeSession = undefined
    this.session = undefined
    this.toolArguments.clear()
  }

  rebind(session: AgentSession): void {
    if (this.session === session && this.unsubscribeSession) return
    this.bind(session)
  }

  close(): void {
    this.invalidate()
    this.listeners.clear()
  }

  private bind(session: AgentSession): void {
    this.unsubscribeSession?.()
    this.unsubscribeSession = undefined
    this.generation += 1
    const generation = this.generation
    this.session = session
    this.lastStopReason = 'stop'
    this.toolArguments = new Map()
    const sessionId = session.sessionId
    this.unsubscribeSession = session.subscribe((event) => {
      if (generation !== this.generation || this.session !== session) return
      const liveScope = this.runtimeScopeProvider()
      if (!liveScope) return
      const scope = Object.freeze({ ownerId: liveScope.ownerId, generation: liveScope.generation })
      const currentScope = this.runtimeScopeProvider()
      if (!currentScope || !sameScope(scope, currentScope)) return
      if (event.type === 'turn_end') {
        const message = objectRecord(event.message)
        if (message?.role === 'assistant' && typeof message.stopReason === 'string') {
          this.lastStopReason = message.stopReason
        }
      } else if (event.type === 'message_end') {
        const message = objectRecord(event.message)
        if (message?.role === 'assistant' && typeof message.stopReason === 'string') {
          this.lastStopReason = message.stopReason
        }
      }
      const normalized = normalizeEvent(event, this.toolArguments)
      for (const dto of normalized) this.publish(scope, generation, sessionId, dto)
      if (event.type === 'agent_settled') {
        const reason = this.lastStopReason === 'aborted'
          ? 'aborted'
          : this.lastStopReason === 'error'
            ? 'error'
            : 'completed'
        this.publish(scope, generation, sessionId, { type: 'terminal', reason })
        this.lastStopReason = 'stop'
      }
    })
  }

  private publish(scope: RuntimeScope, generation: number, sessionId: string, event: SessionEvent): void {
    if (generation !== this.generation) return
    const envelope: SessionEventEnvelope = { runtime: scope, sessionGeneration: generation, sessionId, event }
    for (const listener of this.listeners) {
      try {
        listener(envelope)
      } catch {
        // Renderer observers cannot disrupt Pi's session event dispatch.
      }
    }
  }
}
