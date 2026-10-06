import { Buffer } from 'node:buffer'
import type { AgentSessionEvent, JSONValue } from '@earendil-works/pi-coding-agent'
import type { WorkerEvent } from '../../shared/workers.ts'

const BINARY_MARKER = '[binary omitted]'

/** Convert native session payloads into IPC-safe JSON without losing bytes. */
export function toWorkerJson(value: unknown): JSONValue {
  return toWorkerJsonInner(value, new Set<object>(), 0)
}

function toWorkerJsonInner(value: unknown, ancestors: Set<object>, depth: number): JSONValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return null
  if (depth >= 80) return '[maximum nesting depth]'
  if (Buffer.isBuffer(value)) {
    return { type: 'binary', encoding: 'base64', data: value.toString('base64') }
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    return { type: 'binary', encoding: 'base64', data: bytes.toString('base64') }
  }
  if (value instanceof ArrayBuffer) {
    return { type: 'binary', encoding: 'base64', data: Buffer.from(value).toString('base64') }
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    }
  }
  if (typeof value !== 'object') return BINARY_MARKER
  if (ancestors.has(value)) return '[circular reference]'

  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((entry) => toWorkerJsonInner(entry, ancestors, depth + 1))
    const output: Record<string, JSONValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== 'undefined' && typeof entry !== 'function' && typeof entry !== 'symbol') {
        output[key] = toWorkerJsonInner(entry, ancestors, depth + 1)
      }
    }
    return output
  } finally {
    ancestors.delete(value)
  }
}

function sessionEvent(
  workerId: string,
  type: WorkerEvent['type'],
  timestamp: number,
  payload: Readonly<Record<string, unknown>> = {},
): WorkerEvent {
  return { workerId, type, timestamp, ...payload } as WorkerEvent
}

function eventDelta(event: AgentSessionEvent): { delta?: string; channel?: 'text' | 'thinking' | 'other' } {
  if (event.type !== 'message_update') return {}
  const update = event.assistantMessageEvent as unknown as { readonly type?: unknown; readonly delta?: unknown }
  if (typeof update.delta !== 'string') return {}
  const kind = typeof update.type === 'string' ? update.type : ''
  return {
    delta: update.delta,
    channel: kind.includes('thinking') ? 'thinking' : kind.includes('text') ? 'text' : 'other',
  }
}

/** Normalize the public AgentSession stream, retaining its native event payload. */
export function toWorkerEvents(
  workerId: string,
  event: AgentSessionEvent,
  timestamp = Date.now(),
): readonly WorkerEvent[] {
  switch (event.type) {
    case 'agent_start':
      return [sessionEvent(workerId, 'agent-started', timestamp)]
    case 'agent_end':
      return [sessionEvent(workerId, 'agent-ended', timestamp, { details: toWorkerJson(event) })]
    case 'agent_settled':
      return [sessionEvent(workerId, 'settled', timestamp)]
    case 'turn_start':
      return [sessionEvent(workerId, 'turn-started', timestamp)]
    case 'turn_end':
      return [sessionEvent(workerId, 'turn-ended', timestamp, { details: toWorkerJson(event) })]
    case 'message_start':
      return [sessionEvent(workerId, 'message-started', timestamp, { message: toWorkerJson(event.message) })]
    case 'message_update':
    {
      const update = event.assistantMessageEvent as unknown as {
        readonly type?: unknown
        readonly contentIndex?: unknown
        readonly delta?: unknown
        readonly content?: unknown
        readonly error?: { readonly errorMessage?: unknown; readonly message?: unknown }
      }
      const normalized = sessionEvent(workerId, 'message-updated', timestamp, {
        message: toWorkerJson({ role: event.message.role }),
        update: toWorkerJson({
          type: update.type,
          contentIndex: update.contentIndex,
          delta: update.delta,
          content: update.content,
        }),
        ...eventDelta(event),
      })
      if (update.type !== 'error') return [normalized]
      const error = update.error?.errorMessage ?? update.error?.message
      return [normalized, sessionEvent(workerId, 'error', timestamp, {
        message: typeof error === 'string' ? error.slice(0, 20_000) : 'Worker response failed.',
      })]
    }
    case 'message_end': {
      const normalized = sessionEvent(workerId, 'message-ended', timestamp, { message: toWorkerJson(event.message) })
      const message = event.message as unknown as { readonly stopReason?: unknown; readonly errorMessage?: unknown }
      if (message.stopReason !== 'error') return [normalized]
      return [normalized, sessionEvent(workerId, 'error', timestamp, {
        message: typeof message.errorMessage === 'string'
          ? message.errorMessage.slice(0, 20_000)
          : 'Worker message failed.',
      })]
    }
    case 'tool_execution_start':
      return [sessionEvent(workerId, 'tool-started', timestamp, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        arguments: toWorkerJson(event.args),
      })]
    case 'tool_execution_update':
      return [sessionEvent(workerId, 'tool-updated', timestamp, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        arguments: toWorkerJson(event.args),
        result: toWorkerJson(event.partialResult),
      })]
    case 'tool_execution_end':
      return [sessionEvent(workerId, 'tool-ended', timestamp, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: toWorkerJson(event.result),
        isError: event.isError,
      })]
    case 'queue_update':
      return [sessionEvent(workerId, 'queue-updated', timestamp, {
        steering: [...event.steering],
        followUp: [...event.followUp],
      })]
    case 'compaction_start':
      return [sessionEvent(workerId, 'compaction-started', timestamp, { reason: event.reason })]
    case 'compaction_end':
      return [sessionEvent(workerId, 'compaction-ended', timestamp, {
        reason: event.reason,
        aborted: event.aborted,
        ...(event.errorMessage ? { details: toWorkerJson({ errorMessage: event.errorMessage }) } : {}),
      })]
    case 'auto_retry_start':
    case 'summarization_retry_scheduled':
      return [sessionEvent(workerId, 'retry-started', timestamp, { details: toWorkerJson(event) })]
    case 'auto_retry_end':
    case 'summarization_retry_finished':
      return [sessionEvent(workerId, 'retry-ended', timestamp, { details: toWorkerJson(event) })]
    case 'summarization_retry_attempt_start':
      return [sessionEvent(workerId, 'retry-started', timestamp, { details: toWorkerJson(event) })]
    case 'bash_execution_update':
    case 'entry_appended':
    case 'session_info_changed':
    case 'thinking_level_changed':
      return [sessionEvent(workerId, 'session-event', timestamp, { event: toWorkerJson(event) })]
  }
}
