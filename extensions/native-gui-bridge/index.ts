import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { NativePiAck, NativePiEnvelope, SnapshotRequest, SubmitRequest, SetModelRequest, SetThinkingRequest } from '../../src/shared/native-pi.ts'
import { connectDesktopChannel, type DesktopChannel } from './channel.ts'
import { createSessionObserver, type SessionObserver } from './observer.ts'
import { bindNativeControls } from './controls.ts'
import { bindNativeInput } from './native-input.ts'

export default function (pi: ExtensionAPI) {
  let started = false, piUsable = true, currentContext: ExtensionContext | undefined
  let channel: DesktopChannel | undefined, observer: SessionObserver | undefined
  let controls: ReturnType<typeof bindNativeControls> | undefined
  let input: ReturnType<typeof bindNativeInput> | undefined, disposed = false
  const teardown = () => {
    if (disposed) return
    disposed = true; started = false; currentContext = undefined
    try { channel?.close() } catch {}
    try { controls?.dispose() } catch {}
    try { observer?.dispose() } catch {}
    try { input?.dispose() } catch {}
  }
  // Subscribe while the factory API is active; never call pi.on from a session callback.
  pi.on('session_shutdown', teardown)
  pi.on('model_select', () => { try { void controls?.publishState() } catch {} })
  pi.on('thinking_level_select', () => { try { void controls?.publishState() } catch {} })
  pi.on('session_start', (_event, ctx) => {
    // Pi invalidates this factory API on session replacement; event ctx is the fresh session view.
    piUsable = false
    try {
      // Print/non-UI and child processes never acquire observer/channel/editor ownership.
      if (ctx.mode !== 'tui' || !ctx.hasUI) return
      if (started) {
        currentContext = ctx
        try { observer?.bindRoot(ctx.sessionManager) } catch {}
        try { void controls?.publishState() } catch {}
        return
      }
      started = true; currentContext = ctx; disposed = false
      const socket = process.env.PI_GUI_SOCKET, capability = process.env.PI_GUI_CAPABILITY
      const rawGeneration = process.env.PI_GUI_PROCESS_GENERATION
      const generation = rawGeneration && /^(0|[1-9]\d*)$/.test(rawGeneration) ? Number(rawGeneration) : NaN
      const env = { PI_GUI_SOCKET: socket, PI_GUI_CAPABILITY: capability, PI_GUI_PROCESS_GENERATION: rawGeneration }
      const handlers = {
        onSnapshotRequest: async (payload: SnapshotRequest) => {
          try {
            if (!observer) throw new Error('observer unavailable')
            return observer.snapshot(payload)
          } catch (error) {
            return { snapshotId: '', processGeneration: generation, sequence: 0, sessionId: '', state: 'error', sessions: [], nextCursor: null, error: error instanceof Error ? error.message : String(error) }
          }
        },
        onSubmitRequest: async (payload: SubmitRequest): Promise<NativePiAck> => {
          try {
            const target = currentContext && observer?.generationOf(currentContext.sessionManager.getSessionId())
            if (!input) throw new Error('input unavailable')
            if (!currentContext || currentContext.sessionManager.getSessionId() !== payload.sessionId || target !== payload.sessionGeneration) throw new Error('stale session target')
            const result = input.submit(payload.text)
            return result.outcome === 'submitted' ? { requestId: payload.requestId, outcome: 'accepted', reason: null } : { requestId: payload.requestId, outcome: 'rejected', reason: result.reason }
          } catch (error) {
            const reason = String(error instanceof Error ? error.message : error).replaceAll(capability ?? '', '[redacted]')
            return { requestId: payload.requestId, outcome: 'unknown', reason }
          }
        },
        onModelStateRequest: async () => controls?.modelState() ?? { state: null, error: 'controls unavailable' },
        onSetModelRequest: async (payload: SetModelRequest) => controls?.setModel(payload) ?? { requestId: payload.requestId, outcome: 'rejected' as const, reason: 'controls unavailable' },
        onSetThinkingRequest: async (payload: SetThinkingRequest) => controls?.setThinking(payload) ?? { requestId: payload.requestId, outcome: 'rejected' as const, reason: 'controls unavailable' },
        onSessionsListRequest: async () => controls?.sessionsList() ?? { sessions: [], error: 'controls unavailable' },
      }
      // Child-side loss is intentionally silent because the GUI server owns transport-status reporting.
      void connectDesktopChannel(env, handlers, () => {}).then(connected => {
        if (!connected) return
        if (disposed || !Number.isSafeInteger(generation) || generation < 0) { connected.close(); return }
        const activeContext = currentContext
        if (!activeContext) { connected.close(); return }
        channel = connected
        observer = createSessionObserver(activeContext.sessionManager, generation, event => {
          try {
            const sessionGeneration = observer?.generationOf(event.sessionId)
            if (sessionGeneration === null || sessionGeneration === undefined) return
            const payload = structuredClone(event.payload)
            const envelope: NativePiEnvelope = { version: 1, processGeneration: generation, sequence: observer.nextSequence(), sessionId: event.sessionId, sessionGeneration, kind: 'event', payload }
            channel?.publish(envelope)
          } catch { /* Events without a derivable session generation or cloneable payload are omitted. */ }
        })
        try { observer.bindRoot(activeContext.sessionManager) } catch {}
        controls = bindNativeControls(pi, () => {
          if (!currentContext) throw new Error('session context unavailable')
          return currentContext
        }, generation, () => observer!.nextSequence(), () => {
          if (!currentContext || !observer) throw new Error('session context unavailable')
          const sessionId = currentContext.sessionManager.getSessionId()
          return { sessionId, sessionGeneration: observer.generationOf(sessionId) ?? 0 }
        }, event => channel?.publish(event), () => piUsable)
        // getFocusedComponent exists on runtime TUI ui but is absent from declared ExtensionUIContext.
        input = bindNativeInput(activeContext.ui as unknown as Parameters<typeof bindNativeInput>[0])
      }).catch(() => teardown())
    } catch { teardown() }
  })
}
