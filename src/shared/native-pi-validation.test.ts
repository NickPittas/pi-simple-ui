import { describe, expect, it } from 'vitest'
import {
  isAbortRequest,
  isNativePiAck,
  isNativePiCommandsResult,
  isNativePiControlCommand,
  isNativePiControlReply,
  isNativePiControlRequest,
  isNativePiEnvelope,
  isNativePiModelStateResult,
  isNativePiSessionSummary,
  isNativePiSessionsResult,
  isNativePiSnapshot,
  isNativeThinkingLevel,
  isNativeTransportStatus,
  isOpenSessionRequest,
  isSetModelRequest,
  isSetThinkingRequest,
  isSnapshotRequest,
  isSubmitRequest,
  isTerminalInput,
  isTerminalOutput,
  isTerminalSize,
} from './native-pi-validation.ts'

const envelope = (over: Record<string, unknown> = {}) => ({
  version: 1, processGeneration: 0, sequence: 0, sessionId: null, sessionGeneration: null, kind: 'event', payload: {}, ...over,
})

describe('isNativePiEnvelope', () => {
  it('accepts a valid envelope', () => {
    expect(isNativePiEnvelope(envelope())).toBe(true)
    expect(isNativePiEnvelope(envelope({ sessionId: 's', sessionGeneration: 0 }))).toBe(true)
  })

  it('enforces version, session pairing and kind', () => {
    expect(isNativePiEnvelope(envelope({ version: 2 }))).toBe(false)
    expect(isNativePiEnvelope(envelope({ sessionId: null, sessionGeneration: 0 }))).toBe(false)
    expect(isNativePiEnvelope(envelope({ sessionId: 's', sessionGeneration: null }))).toBe(false)
    expect(isNativePiEnvelope(envelope({ sessionId: 's', sessionGeneration: -1 }))).toBe(false)
    for (const kind of ['root', 'snapshot', 'event', 'status', 'gap']) expect(isNativePiEnvelope(envelope({ kind }))).toBe(true)
    expect(isNativePiEnvelope(envelope({ kind: 'other' }))).toBe(false)
  })

  it('rejects non-JSON payloads', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const getter = {}
    Object.defineProperty(getter, 'x', { get: () => 1, enumerable: true })
    // eslint-disable-next-line no-sparse-arrays
    for (const payload of [{ n: Infinity }, cyclic, [, 1], getter, new Date()]) {
      expect(isNativePiEnvelope(envelope({ payload }))).toBe(false)
    }
  })

  it('accepts shared non-cyclic references', () => {
    const shared = { a: 1 }
    expect(isNativePiEnvelope(envelope({ payload: { x: shared, y: shared } }))).toBe(true)
  })
})

const session = (over: Record<string, unknown> = {}) => ({
  sessionId: 's', sessionGeneration: 0, name: null, file: null, cwd: null, classification: 'root',
  parentSessionId: null, entries: [], activeLeaf: null, activeBranch: null, partial: null, metadata: {}, ...over,
})
const snapshot = (over: Record<string, unknown> = {}) => ({
  snapshotId: 'x', processGeneration: 0, sequence: 0, state: 'ready', rootSessionId: null, sessions: [session()], nextCursor: null, error: null, ...over,
})

describe('isNativePiSnapshot', () => {
  it('accepts a valid snapshot', () => {
    expect(isNativePiSnapshot(snapshot())).toBe(true)
  })

  it('enforces state enum', () => {
    for (const state of ['starting', 'ready', 'disconnected', 'unsupported', 'exited', 'gap']) expect(isNativePiSnapshot(snapshot({ state }))).toBe(true)
    expect(isNativePiSnapshot(snapshot({ state: 'bogus' }))).toBe(false)
  })

  it('validates each session', () => {
    expect(isNativePiSnapshot(snapshot({ sessions: [session({ classification: 'child' })] }))).toBe(true)
    expect(isNativePiSnapshot(snapshot({ sessions: [session({ classification: 'bad' })] }))).toBe(false)
    expect(isNativePiSnapshot(snapshot({ sessions: [session({ activeBranch: ['a', 'b'] })] }))).toBe(true)
    expect(isNativePiSnapshot(snapshot({ sessions: [session({ activeBranch: [''] })] }))).toBe(false)
    expect(isNativePiSnapshot(snapshot({ sessions: [{ ...session(), extra: 1 }] }))).toBe(false)
  })
})

describe('simple request validators', () => {
  it('isSnapshotRequest', () => {
    expect(isSnapshotRequest({})).toBe(true)
    expect(isSnapshotRequest({ cursor: 'c' })).toBe(true)
    expect(isSnapshotRequest({ cursor: '' })).toBe(false)
  })

  it('isSubmitRequest', () => {
    const r = { requestId: 'r', sessionId: 's', sessionGeneration: 0, text: '' }
    expect(isSubmitRequest(r)).toBe(true)
    expect(isSubmitRequest({ ...r, sessionGeneration: -1 })).toBe(false)
    expect(isSubmitRequest({ ...r, extra: 1 })).toBe(false)
  })

  it('isNativePiAck', () => {
    for (const outcome of ['accepted', 'rejected', 'unknown']) expect(isNativePiAck({ requestId: 'r', outcome, reason: null })).toBe(true)
    expect(isNativePiAck({ requestId: 'r', outcome: 'x', reason: null })).toBe(false)
    expect(isNativePiAck({ requestId: 'r', outcome: 'accepted', reason: 'why' })).toBe(true)
    expect(isNativePiAck({ requestId: 'r', outcome: 'accepted', reason: 1 })).toBe(false)
  })

  it('isNativeThinkingLevel', () => {
    for (const l of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) expect(isNativeThinkingLevel(l)).toBe(true)
    expect(isNativeThinkingLevel('ultra')).toBe(false)
  })
})

const modelState = {
  sessionId: 's', sessionGeneration: 0, processGeneration: 0, sequence: 0,
  model: { provider: 'p', id: 'm', name: 'M' }, models: [{ provider: 'p', id: 'm', name: 'M' }],
  thinkingLevel: 'low', thinkingLevels: ['off', 'low'], busy: false,
}

describe('isNativePiModelStateResult', () => {
  it('requires exactly one of state/error', () => {
    expect(isNativePiModelStateResult({ state: null, error: 'x' })).toBe(true)
    expect(isNativePiModelStateResult({ state: null, error: null })).toBe(false)
    expect(isNativePiModelStateResult({ state: modelState, error: null })).toBe(true)
    expect(isNativePiModelStateResult({ state: modelState, error: 'x' })).toBe(false)
  })
})

const summary = (over: Record<string, unknown> = {}) => ({
  sessionId: 's', file: '/f', name: null, created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00+02:00',
  firstMessage: 'hi', messageCount: 1, branched: false, ...over,
})

describe('session summaries', () => {
  it('validates timestamps and firstMessage', () => {
    expect(isNativePiSessionSummary(summary())).toBe(true)
    expect(isNativePiSessionSummary(summary({ created: '2026-13-01T00:00:00Z' }))).toBe(false)
    expect(isNativePiSessionSummary(summary({ firstMessage: 'x'.repeat(201) }))).toBe(false)
  })

  it('validates sessions result', () => {
    expect(isNativePiSessionsResult({ sessions: [summary()], error: null })).toBe(true)
    expect(isNativePiSessionsResult({ sessions: Array.from({ length: 201 }, () => summary()), error: null })).toBe(false)
    expect(isNativePiSessionsResult({ sessions: [summary()], error: 'bad' })).toBe(false)
    expect(isNativePiSessionsResult({ sessions: [], error: 'bad' })).toBe(true)
  })
})

describe('isNativePiCommandsResult', () => {
  const cmd = { name: 'c', description: null, source: 'skill' }
  const info = { path: '/p', source: 's', scope: 'user', origin: 'package', baseDir: null }

  it('treats sourceInfo as optional, nullable and validated', () => {
    expect(isNativePiCommandsResult({ commands: [cmd], error: null })).toBe(true)
    expect(isNativePiCommandsResult({ commands: [{ ...cmd, sourceInfo: null }], error: null })).toBe(true)
    expect(isNativePiCommandsResult({ commands: [{ ...cmd, sourceInfo: info }], error: null })).toBe(true)
    expect(isNativePiCommandsResult({ commands: [{ ...cmd, sourceInfo: { ...info, scope: 'x' } }], error: null })).toBe(false)
  })

  it('enforces source enum and max count', () => {
    for (const source of ['extension', 'prompt', 'skill']) expect(isNativePiCommandsResult({ commands: [{ ...cmd, source }], error: null })).toBe(true)
    expect(isNativePiCommandsResult({ commands: [{ ...cmd, source: 'x' }], error: null })).toBe(false)
    expect(isNativePiCommandsResult({ commands: Array.from({ length: 2001 }, () => cmd), error: null })).toBe(false)
  })
})

describe('request validators', () => {
  const target = { sessionId: 's', sessionGeneration: 0, requestId: 'r' }

  it('require exact keys', () => {
    expect(isAbortRequest(target)).toBe(true)
    expect(isAbortRequest({ ...target, x: 1 })).toBe(false)
    expect(isSetModelRequest({ ...target, provider: 'p', modelId: 'm' })).toBe(true)
    expect(isSetModelRequest(target)).toBe(false)
    expect(isSetThinkingRequest({ ...target, level: 'low' })).toBe(true)
    expect(isSetThinkingRequest({ ...target, level: 'ultra' })).toBe(false)
  })

  it('isOpenSessionRequest allows null file', () => {
    const r = { workspaceId: 'w', expectedProcessGeneration: 0, expectedSessionId: 's', file: null }
    expect(isOpenSessionRequest(r)).toBe(true)
    expect(isOpenSessionRequest({ ...r, file: '/f' })).toBe(true)
    expect(isOpenSessionRequest({ ...r, file: 1 })).toBe(false)
  })
})

describe('control command/request/reply routing', () => {
  const target = { sessionId: 's', sessionGeneration: 0, requestId: 'r' }
  const setModel = { ...target, provider: 'p', modelId: 'm' }
  const setThinking = { ...target, level: 'low' }

  it('isNativePiControlCommand routes by operation', () => {
    for (const operation of ['model-state', 'sessions-list', 'commands-list']) {
      expect(isNativePiControlCommand({ operation, payload: {} })).toBe(true)
      expect(isNativePiControlCommand({ operation, payload: { x: 1 } })).toBe(false)
    }
    expect(isNativePiControlCommand({ operation: 'abort', payload: target })).toBe(true)
    expect(isNativePiControlCommand({ operation: 'set-model', payload: setModel })).toBe(true)
    expect(isNativePiControlCommand({ operation: 'set-model', payload: target })).toBe(false)
    expect(isNativePiControlCommand({ operation: 'set-thinking', payload: setThinking })).toBe(true)
    expect(isNativePiControlCommand({ operation: 'bogus', payload: {} })).toBe(false)
  })

  it('isNativePiControlRequest routes by operation', () => {
    expect(isNativePiControlRequest({ requestId: 'r', operation: 'abort', payload: target })).toBe(true)
    expect(isNativePiControlRequest({ requestId: 'r', operation: 'model-state', payload: {} })).toBe(true)
    expect(isNativePiControlRequest({ requestId: 'r', operation: 'set-model', payload: setModel })).toBe(true)
    expect(isNativePiControlRequest({ requestId: 'r', operation: 'set-thinking', payload: setThinking })).toBe(true)
    expect(isNativePiControlRequest({ requestId: 'r', operation: 'set-thinking', payload: setModel })).toBe(false)
    expect(isNativePiControlRequest({ requestId: 'r', operation: 'bogus', payload: {} })).toBe(false)
    expect(isNativePiControlRequest({ requestId: '', operation: 'model-state', payload: {} })).toBe(false)
  })

  it('isNativePiControlReply routes and matches requestId', () => {
    const req = (operation: string, payload: unknown) => ({ requestId: 'r', operation, payload }) as never
    const ack = (requestId: string) => ({ requestId, outcome: 'accepted', reason: null })
    expect(isNativePiControlReply(req('model-state', {}), { state: null, error: 'x' })).toBe(true)
    expect(isNativePiControlReply(req('model-state', {}), ack('r'))).toBe(false)
    expect(isNativePiControlReply(req('sessions-list', {}), { sessions: [], error: null })).toBe(true)
    expect(isNativePiControlReply(req('commands-list', {}), { commands: [], error: null })).toBe(true)
    expect(isNativePiControlReply(req('abort', target), ack('r'))).toBe(true)
    expect(isNativePiControlReply(req('abort', target), ack('other'))).toBe(false)
    expect(isNativePiControlReply(req('set-model', setModel), ack('r'))).toBe(true)
    expect(isNativePiControlReply(req('set-model', setModel), ack('other'))).toBe(false)
    expect(isNativePiControlReply(req('set-thinking', setThinking), ack('r'))).toBe(true)
    expect(isNativePiControlReply(req('set-thinking', setThinking), ack('other'))).toBe(false)
    expect(isNativePiControlReply(req('bogus', {}), ack('r'))).toBe(false)
  })
})

describe('terminal validators', () => {
  it('isTerminalSize requires positive integers', () => {
    expect(isTerminalSize({ columns: 80, rows: 24 })).toBe(true)
    expect(isTerminalSize({ columns: 0, rows: 24 })).toBe(false)
    expect(isTerminalSize({ columns: 80, rows: 0 })).toBe(false)
  })

  it('isTerminalOutput requires boolean gap', () => {
    const o = { processGeneration: 0, sequence: 0, data: 'x', gap: false }
    expect(isTerminalOutput(o)).toBe(true)
    expect(isTerminalOutput({ ...o, gap: 'no' })).toBe(false)
  })

  it('isTerminalInput requires non-empty requestId', () => {
    expect(isTerminalInput({ requestId: 'r', data: 'x' })).toBe(true)
    expect(isTerminalInput({ requestId: '', data: 'x' })).toBe(false)
  })

  it('isNativeTransportStatus enforces state enum', () => {
    for (const state of ['waiting', 'connected', 'disconnected', 'disposed']) {
      expect(isNativeTransportStatus({ processGeneration: 0, state, reason: null })).toBe(true)
    }
    expect(isNativeTransportStatus({ processGeneration: 0, state: 'x', reason: null })).toBe(false)
  })
})
