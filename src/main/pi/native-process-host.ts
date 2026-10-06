import { randomUUID } from 'node:crypto'
import { createRpcProjection } from './rpc-projection.ts'
import { createWorkspaceTerminal } from './workspace-terminal.ts'
import { listWorkspaceSessions } from './session-catalog.ts'
import { startRpcTransport, type RpcRecord } from './rpc-transport.ts'
import type {
  NativeBridgeCommand,
  NativeBridgeReply,
  NativeCommandEntry,
  NativeCommandSourceInfo,
  NativePiAck,
  NativePiEnvelope,
  NativePiSnapshot,
  NativeTransportStatus,
  SnapshotRequest,
  Stop,
  SubmitRequest,
} from '../../shared/native-pi.ts'

/** Strict projection of Pi's SourceInfo; anything unexpected becomes null rather than being guessed. Credentials in URL sources are redacted. */
function projectSourceInfo(value: unknown): NativeCommandSourceInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const info = value as RpcRecord
  if (typeof info.path !== 'string' || info.path.length === 0 || info.path.length > 4096 || info.path.includes('\0')) return null
  if (typeof info.source !== 'string') return null
  if (info.scope !== 'user' && info.scope !== 'project' && info.scope !== 'temporary') return null
  if (info.origin !== 'package' && info.origin !== 'top-level') return null
  let baseDir: string | null = null
  if (info.baseDir !== undefined && info.baseDir !== null) {
    if (typeof info.baseDir !== 'string' || info.baseDir.length === 0 || info.baseDir.length > 4096 || info.baseDir.includes('\0')) return null
    baseDir = info.baseDir
  }
  const source = info.source.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@').slice(0, 2048)
  return { path: info.path, source, scope: info.scope, origin: info.origin, baseDir }
}

const failure = (error: unknown): string => error instanceof Error ? error.message : 'Native Pi request failed'
let nextProcessGeneration = 1

export type NativeProcessScope = { readonly processGeneration: number }
export type NativeProcessHost = {
  readonly scope: NativeProcessScope
  subscribeTerminal(listener: (data: string) => void): Stop
  subscribe(listener: (event: NativePiEnvelope) => void): Stop
  onStatus(listener: (status: NativeTransportStatus) => void): Stop
  subscribeUi(listener: (record: RpcRecord) => void): Stop
  respondUi(response: RpcRecord & { id: string }): boolean
  snapshot(request: SnapshotRequest): Promise<NativePiSnapshot>
  submit(request: SubmitRequest): Promise<NativePiAck>
  controlRequest(command: Extract<NativeBridgeCommand, { operation: 'model-state' | 'set-model' | 'set-thinking' | 'sessions-list' | 'commands-list' | 'abort' }>): Promise<NativeBridgeReply>
  /** Current Pi session file from get_state, or null when unavailable (e.g. in-memory sessions). */
  sessionFile(): Promise<string | null>
  write(data: string): boolean
  resize(cols: number, rows: number): void
  dispose(): Promise<void>
}

type NativeState = { sessionId: string; isStreaming: boolean; isCompacting: boolean; pendingMessageCount: number }
const ack = (requestId: string, outcome: NativePiAck['outcome'], reason: string | null): NativePiAck => ({ requestId, outcome, reason })

export async function startNativePi(options: {
  cwd: string
  cols?: number
  rows?: number
  onExit: (code: number) => void
  bridgeEntry?: string
  sessionFile?: string
}): Promise<NativeProcessHost> {
  const processGeneration = nextProcessGeneration++
  let projection: ReturnType<typeof createRpcProjection> | undefined
  let pendingExit: number | undefined
  let exitNotified = false
  let live = true
  const rpc = startRpcTransport({ cwd: options.cwd, sessionFile: options.sessionFile, onExit: code => {
    if (exitNotified) return
    exitNotified = true; live = false
    if (projection) projection.exited(code); else pendingExit = code
    try { options.onExit(code) } catch {}
  } })
  projection = createRpcProjection(rpc, processGeneration)
  if (pendingExit !== undefined) projection.exited(pendingExit)

  const freshTarget = async (target: { sessionId: string; sessionGeneration: number }, rejectBusy: boolean): Promise<string | null> => {
    if (!live) return 'Native Pi is not active.'
    try {
      const response = await projection!.readState()
      const state = response.data as NativeState
      const current = projection!.target()
      if (!current || current.sessionId !== target.sessionId || current.sessionGeneration !== target.sessionGeneration
        || !state || typeof state.sessionId !== 'string' || state.sessionId !== target.sessionId) return 'The native Pi session changed or is unavailable.'
      if (rejectBusy && (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0)) return 'Pi has streaming or queued work; wait for it to finish.'
      return null
    } catch (error) { return failure(error) }
  }
  const mutate = async (target: { sessionId: string; sessionGeneration: number; requestId: string }, type: 'set_model' | 'set_thinking_level', fields: RpcRecord): Promise<NativePiAck> => {
    const invalid = await freshTarget(target, true)
    if (invalid) return ack(target.requestId, 'rejected', invalid)
    try {
      const response = await rpc.request({ type, ...fields })
      if (!response.success) return ack(target.requestId, 'rejected', response.error ?? `Pi RPC ${type} rejected`)
      await projection!.refreshModel()
      return ack(target.requestId, 'accepted', null)
    } catch (error) { return ack(target.requestId, 'unknown', failure(error)) }
  }

  void projection.readState().catch(async () => {
    if (live) {
      live = false
      projection!.exited(-1)
      try { await rpc.dispose() } catch {}
    }
  })

  const workspaceTerminal = createWorkspaceTerminal({ cwd: options.cwd, cols: options.cols, rows: options.rows })
  let disposePromise: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise
    live = false
    disposePromise = (async () => { projection!.dispose(); void workspaceTerminal.dispose(); await rpc.dispose() })()
    return disposePromise
  }
  return {
    scope: { processGeneration },
    subscribeTerminal(listener) { return workspaceTerminal.subscribe(listener) },
    subscribe(listener) { return projection!.subscribe(listener) },
    onStatus(listener) { return projection!.onStatus(listener) },
    subscribeUi(listener) { return projection!.subscribeUi(listener) },
    respondUi(response) { return projection!.respondUi(response) },
    snapshot(request) {
      if (!live) return Promise.reject(new Error('Native Pi is not active.'))
      return projection!.snapshot(request)
    },
    async submit(request) {
      if (!live) throw new Error('Native Pi is not active.')
      const invalid = await freshTarget(request, false)
      if (invalid) return ack(request.requestId, 'rejected', invalid)
      try {
        const response = await rpc.request({ type: 'prompt', message: request.text, streamingBehavior: 'steer' })
        if (!response.success) return ack(request.requestId, 'rejected', response.error ?? 'Pi rejected the prompt')
        const disposition = (response.data as RpcRecord | undefined)?.disposition
        return disposition === 'started' || disposition === 'queued' || disposition === 'handled'
          ? ack(request.requestId, 'accepted', null)
          : ack(request.requestId, 'unknown', 'Pi returned an invalid prompt disposition')
      } catch (error) { return ack(request.requestId, 'unknown', failure(error)) }
    },
    async sessionFile() {
      if (!live) throw new Error('Native Pi is not active.')
      const response = await projection!.readState()
      const file = (response.data as RpcRecord | undefined)?.sessionFile
      return typeof file === 'string' && file.length > 0 ? file : null
    },
    async controlRequest(command) {
      if (!live) throw new Error('Native Pi is not active.')
      if (command.operation === 'model-state') return { requestId: randomUUID(), value: await projection!.modelState() }
      if (command.operation === 'sessions-list') return { requestId: randomUUID(), value: await listWorkspaceSessions(options.cwd) }
      if (command.operation === 'commands-list') {
        try {
          const response = await rpc.request({ type: 'get_commands' })
          if (!response.success) return { requestId: randomUUID(), value: { commands: [], error: response.error ?? 'Pi rejected get_commands' } }
          const raw = (response.data as RpcRecord | undefined)?.commands
          if (!Array.isArray(raw)) return { requestId: randomUUID(), value: { commands: [], error: 'Pi returned an invalid command list' } }
          const commands: NativeCommandEntry[] = []
          for (const item of raw) {
            if (commands.length >= 2000) break
            if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
            const entry = item as RpcRecord
            if (typeof entry.name !== 'string' || entry.name.length === 0) continue
            if (entry.source !== 'extension' && entry.source !== 'prompt' && entry.source !== 'skill') continue
            if (entry.description !== undefined && typeof entry.description !== 'string') continue
            commands.push({ name: entry.name, description: typeof entry.description === 'string' ? entry.description : null, source: entry.source, sourceInfo: projectSourceInfo(entry.sourceInfo) })
          }
          return { requestId: randomUUID(), value: { commands, error: null } }
        } catch (error) { return { requestId: randomUUID(), value: { commands: [], error: failure(error) } } }
      }
      if (command.operation === 'abort') {
        const target = command.payload
        const invalid = await freshTarget(target, false)
        if (invalid) return { requestId: randomUUID(), value: ack(target.requestId, 'rejected', invalid) }
        try {
          const response = await rpc.request({ type: 'abort' })
          return { requestId: randomUUID(), value: response.success ? ack(target.requestId, 'accepted', null) : ack(target.requestId, 'rejected', response.error ?? 'Pi rejected abort') }
        } catch (error) { return { requestId: randomUUID(), value: ack(target.requestId, 'unknown', failure(error)) } }
      }
      const value = command.operation === 'set-model'
        ? await mutate(command.payload, 'set_model', { provider: command.payload.provider, modelId: command.payload.modelId })
        : await mutate(command.payload, 'set_thinking_level', { level: command.payload.level })
      return { requestId: randomUUID(), value }
    },
    write(data) { return workspaceTerminal.write(data) },
    resize(cols, rows) { workspaceTerminal.resize(cols, rows) },
    dispose,
  }
}
