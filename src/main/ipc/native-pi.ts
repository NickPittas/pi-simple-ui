import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { CapabilityDefinition, EventDefinition } from './register.ts'
import { CONTENT_LIMITS } from '../../shared/content.ts'
import { hasExactKeys, isPlainRecord, type RuntimeScope } from '../../shared/ipc-contracts.ts'
import {
  isNativePiEnvelope,
  isNativePiAck,
  isNativePiSnapshot,
  isNativePiModelStateResult,
  isNativePiSessionsResult,
  isNativePiCommandsResult,
  isAbortRequest,
  isOpenSessionRequest,
  isOpenSessionResult,
  isSetModelRequest,
  isSetThinkingRequest,
  isNativeTransportStatus,
  isSnapshotRequest,
  isSubmitRequest,
  isTerminalInput,
  isTerminalOutput,
  isTerminalSize,
} from '../../shared/native-pi-validation.ts'
import type {
  NativePiEnvelope,
  NativePiAck,
  NativePiSnapshot,
  NativeModelStateResult,
  NativeSessionsResult,
  OpenSessionRequest,
  OpenSessionResult,
  SetModelRequest,
  SetThinkingRequest,
  StageAttachmentRequest,
  StageAttachmentResult,
  NativeTransportStatus,
  SnapshotRequest,
  SubmitRequest,
  TerminalInput,
  TerminalOutput,
  TerminalSize,
} from '../../shared/native-pi.ts'
import type { WorkspaceSnapshot } from '../../shared/workspaces.ts'
import type { NativeProcessHost } from '../pi/native-process-host.ts'

export interface NativePiOperations {
  activeHost(): NativeProcessHost | null
  workspaceSnapshot(): WorkspaceSnapshot
  openSession(request: OpenSessionRequest): Promise<{ outcome: 'opened'; processGeneration: number } | { outcome: 'failed'; reason: string }>
}

const isStageAttachmentRequest = (value: unknown): value is StageAttachmentRequest => isPlainRecord(value)
  && hasExactKeys(value, ['name', 'bytesBase64'])
  && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= CONTENT_LIMITS.attachmentNameCharacters
  && typeof value.bytesBase64 === 'string' && value.bytesBase64.length <= CONTENT_LIMITS.attachmentBase64Characters
  && /^[A-Za-z0-9+/]*={0,2}$/.test(value.bytesBase64)
const isStageAttachmentResult = (value: unknown): value is StageAttachmentResult => isPlainRecord(value)
  && hasExactKeys(value, ['path']) && typeof value.path === 'string' && value.path.length > 0

const isEmptyRequest = (value: unknown): value is Record<string, never> => isPlainRecord(value) && hasExactKeys(value, [])

function requireScope(scope: RuntimeScope | undefined): RuntimeScope {
  if (!scope) throw new Error('A native runtime scope is required for native Pi operations.')
  return scope
}

function ownedHost(operations: Pick<NativePiOperations, 'activeHost'>, scope: RuntimeScope | undefined): NativeProcessHost {
  const runtime = requireScope(scope)
  const host = operations.activeHost()
  if (!host || host.scope.processGeneration !== runtime.generation) {
    throw new Error('A native runtime scope is required for native Pi operations.')
  }
  return host
}

export function registerNativePiCapabilities(operations: NativePiOperations): CapabilityDefinition<any, any>[] {
  return [
    {
      id: 'native.pi.snapshot',
      scope: 'runtime',
      validateRequest: isSnapshotRequest,
      validateResponse: isNativePiSnapshot,
      handle: async ({ scope }, request) => {
        const host = ownedHost(operations, scope)
        const snapshot = await host.snapshot(request)
        if (operations.activeHost() !== host || host.scope.processGeneration !== requireScope(scope).generation) {
          throw new Error('The native runtime scope is no longer current.')
        }
        return snapshot
      },
    },
    {
      id: 'native.pi.submit',
      scope: 'runtime',
      validateRequest: isSubmitRequest,
      validateResponse: isNativePiAck,
      handle: async ({ scope }, request) => {
        const host = ownedHost(operations, scope)
        const ack = await host.submit(request)
        if (operations.activeHost() !== host || host.scope.processGeneration !== requireScope(scope).generation) {
          throw new Error('The native runtime scope is no longer current.')
        }
        return ack
      },
    },
    {
      id: 'native.pi.model-state', scope: 'runtime', validateRequest: isEmptyRequest,
      validateResponse: isNativePiModelStateResult,
      handle: async ({ scope }) => {
        const host = ownedHost(operations, scope)
        const reply = await host.controlRequest({ operation: 'model-state', payload: {} })
        if (operations.activeHost() !== host || host.scope.processGeneration !== requireScope(scope).generation) throw new Error('The native runtime scope is no longer current.')
        if (!isNativePiModelStateResult(reply.value)) throw new Error('Native model state is unavailable.')
        return reply.value
      },
    },
    {
      id: 'native.pi.set-model', scope: 'runtime', validateRequest: isSetModelRequest, validateResponse: isNativePiAck,
      handle: async ({ scope }, request) => {
        const host = ownedHost(operations, scope)
        const reply = await host.controlRequest({ operation: 'set-model', payload: request })
        if (operations.activeHost() !== host || host.scope.processGeneration !== requireScope(scope).generation) throw new Error('The native runtime scope is no longer current.')
        if (!isNativePiAck(reply.value) || reply.value.requestId !== request.requestId) throw new Error('Native model selection is unavailable.')
        return reply.value
      },
    },
    {
      id: 'native.pi.set-thinking', scope: 'runtime', validateRequest: isSetThinkingRequest, validateResponse: isNativePiAck,
      handle: async ({ scope }, request) => {
        const host = ownedHost(operations, scope)
        const reply = await host.controlRequest({ operation: 'set-thinking', payload: request })
        if (operations.activeHost() !== host || host.scope.processGeneration !== requireScope(scope).generation) throw new Error('The native runtime scope is no longer current.')
        if (!isNativePiAck(reply.value) || reply.value.requestId !== request.requestId) throw new Error('Native thinking selection is unavailable.')
        return reply.value
      },
    },
    {
      id: 'native.pi.sessions-list', scope: 'runtime', validateRequest: isEmptyRequest,
      validateResponse: isNativePiSessionsResult,
      handle: async ({ scope }) => {
        const host = ownedHost(operations, scope)
        const reply = await host.controlRequest({ operation: 'sessions-list', payload: {} })
        if (operations.activeHost() !== host || host.scope.processGeneration !== requireScope(scope).generation) throw new Error('The native runtime scope is no longer current.')
        if (!isNativePiSessionsResult(reply.value)) throw new Error('Native sessions are unavailable.')
        return reply.value
      },
    },
    {
      id: 'native.pi.commands-list', scope: 'runtime', validateRequest: isEmptyRequest,
      validateResponse: isNativePiCommandsResult,
      handle: async ({ scope }) => {
        const host = ownedHost(operations, scope)
        const reply = await host.controlRequest({ operation: 'commands-list', payload: {} })
        if (operations.activeHost() !== host || host.scope.processGeneration !== requireScope(scope).generation) throw new Error('The native runtime scope is no longer current.')
        if (!isNativePiCommandsResult(reply.value)) throw new Error('Native commands are unavailable.')
        return reply.value
      },
    },
    {
      id: 'native.pi.abort', scope: 'runtime', validateRequest: isAbortRequest, validateResponse: isNativePiAck,
      handle: async ({ scope }, request) => {
        const host = ownedHost(operations, scope)
        const reply = await host.controlRequest({ operation: 'abort', payload: request })
        if (operations.activeHost() !== host || host.scope.processGeneration !== requireScope(scope).generation) throw new Error('The native runtime scope is no longer current.')
        if (!isNativePiAck(reply.value) || reply.value.requestId !== request.requestId) throw new Error('Native abort is unavailable.')
        return reply.value
      },
    },
    {
      id: 'native.pi.stage-attachment', scope: 'runtime', validateRequest: isStageAttachmentRequest, validateResponse: isStageAttachmentResult,
      handle: async ({ scope }, request) => {
        ownedHost(operations, scope)
        const bytes = Buffer.from(request.bytesBase64, 'base64')
        if (bytes.byteLength > CONTENT_LIMITS.attachmentBytes) throw new Error('The attachment is too large.')
        const safeName = basename(request.name).replace(/[^\w.-]+/g, '_').slice(-120) || 'attachment'
        const dir = join(tmpdir(), 'pi-gui-attachments')
        await mkdir(dir, { recursive: true, mode: 0o700 })
        const path = join(dir, `${randomUUID()}-${safeName}`)
        await writeFile(path, bytes, { mode: 0o600 })
        return { path }
      },
    },
    {
      id: 'native.pi.open-session', scope: 'window', validateRequest: isOpenSessionRequest, validateResponse: isOpenSessionResult,
      handle: async (_context, request) => {
        const before = operations.workspaceSnapshot()
        const host = operations.activeHost()
        if (!host || before.activeWorkspaceId !== request.workspaceId || host.scope.processGeneration !== request.expectedProcessGeneration) {
          return { outcome: 'failed', reason: 'The active workspace or Pi process changed.', snapshot: before }
        }
        try {
          const reply = await host.controlRequest({ operation: 'model-state', payload: {} })
          if (operations.activeHost() !== host || operations.workspaceSnapshot().activeWorkspaceId !== request.workspaceId
            || host.scope.processGeneration !== request.expectedProcessGeneration || !isNativePiModelStateResult(reply.value)
            || !reply.value.state || reply.value.state.processGeneration !== request.expectedProcessGeneration
            || reply.value.state.sessionId !== request.expectedSessionId) {
            return { outcome: 'failed', reason: 'The active Pi session changed or is unavailable.', snapshot: operations.workspaceSnapshot() }
          }
          const result = await operations.openSession(request)
          const snapshot = operations.workspaceSnapshot()
          return result.outcome === 'opened'
            ? { outcome: 'opened', reason: null, snapshot }
            : { outcome: 'failed', reason: result.reason, snapshot }
        } catch {
          return { outcome: 'failed', reason: 'Pi could not open the requested session.', snapshot: operations.workspaceSnapshot() }
        }
      },
    },
    {
      id: 'native.pi.terminal-input',
      scope: 'runtime',
      validateRequest: isTerminalInput,
      validateResponse: isNativePiAck,
      handle: ({ scope }, request) => {
        const host = ownedHost(operations, scope)
        if (operations.activeHost() !== host || host.scope.processGeneration !== requireScope(scope).generation) {
          throw new Error('The native runtime scope is no longer current.')
        }
        // Input goes to the separate workspace shell (pty), which starts lazily when the terminal drawer subscribes; it is not Pi's stdio. write() returns false until that shell is live.
        const delivered = host.write(request.data)
        return delivered
          ? { requestId: request.requestId, outcome: 'accepted', reason: null }
          : { requestId: request.requestId, outcome: 'unknown', reason: 'terminal not live' }
      },
    },
    {
      id: 'native.pi.terminal-resize',
      scope: 'runtime',
      validateRequest: isTerminalSize,
      validateResponse: (value): value is null => value === null,
      handle: ({ scope }, request) => {
        const host = ownedHost(operations, scope)
        if (operations.activeHost() !== host || host.scope.processGeneration !== requireScope(scope).generation) {
          throw new Error('The native runtime scope is no longer current.')
        }
        host.resize(request.columns, request.rows)
        return null
      },
    },
  ]
}

export function registerNativePiEvents(operations: Pick<NativePiOperations, 'activeHost'>): readonly EventDefinition<NativePiEnvelope | TerminalOutput | NativeTransportStatus>[] {
  const events: EventDefinition<NativePiEnvelope | TerminalOutput | NativeTransportStatus>[] = [
    {
      id: 'native.pi.events', scope: 'runtime', validatePayload: isNativePiEnvelope,
      subscribe: ({ scope }, publish) => {
        const host = ownedHost(operations, scope)
        return host.subscribe((event) => {
          try { if (operations.activeHost() === host && event.processGeneration === host.scope.processGeneration) publish(event) } catch {}
        })
      },
    },
    {
      id: 'native.pi.terminal-output', scope: 'runtime', validatePayload: isTerminalOutput,
      subscribe: ({ scope }, publish) => {
        const host = ownedHost(operations, scope)
        let sequence = 0
        return host.subscribeTerminal((data) => {
          try {
            if (operations.activeHost() !== host) return
            publish({ processGeneration: host.scope.processGeneration, sequence: sequence++, data, gap: false })
          } catch {}
        })
      },
    },
    {
      id: 'native.pi.transport-status', scope: 'runtime', validatePayload: isNativeTransportStatus,
      subscribe: ({ scope }, publish) => {
        const host = ownedHost(operations, scope)
        return host.onStatus((status) => {
          try { if (operations.activeHost() === host && status.processGeneration === host.scope.processGeneration) publish(status) } catch {}
        })
      },
    },
  ]
  return events
}
