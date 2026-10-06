import { AgentSession, type AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { readNativeSessionSnapshot, type NativeManager, type RetainedPartial } from './session-snapshot.ts'
import type { Json, NativePiSnapshot, SnapshotRequest } from '../../src/shared/native-pi.ts'

export type NativeObservedEvent = {
  sessionId: string
  eventName: AgentSessionEvent['type']
  payload: AgentSessionEvent
}

let processSequence = 0
export type SessionObserver = {
  bindRoot(manager: NativeManager): void
  snapshot(request: SnapshotRequest): NativePiSnapshot
  generationOf(sessionId: string): number | null
  nextSequence(): number
  dispose(): void
}

/**
 * Supported lifecycle fence: the TUI host. Interactive-ownership conflicts make
 * telemetry unsupported; this observer never takes ownership from another UI.
 * Public event names in agent-session.d.ts: agent_start, agent_end, turn_start,
 * turn_end, message_start, message_update, message_end, tool_execution_start,
 * tool_execution_update, tool_execution_end, agent_settled, queue_update,
 * compaction_start, entry_appended, session_info_changed,
 * thinking_level_changed, compaction_end, auto_retry_start, auto_retry_end,
 * summarization_retry_scheduled, summarization_retry_attempt_start,
 * summarization_retry_finished, bash_execution_update.
 */
export function createSessionObserver(
  manager: NativeManager,
  processGeneration: number,
  collector: (event: NativeObservedEvent) => void,
): SessionObserver {
  if (!Number.isSafeInteger(processGeneration) || processGeneration < 0) {
    throw new Error('process generation must be a nonnegative safe integer')
  }

  const prototype = AgentSession.prototype
  const originalPrompt = prototype.prompt
  const subscribed = new WeakSet<AgentSession>()
  const unsubscriptions = new Set<() => void>()
  const generations = new Map<string, number>()
  const partials = new Map<string, RetainedPartial>()
  let root = manager
  let generationOrdinal = 0
  let disposed = false

  const ensureGeneration = (sessionId: string): number => {
    let ordinal = generations.get(sessionId)
    if (ordinal === undefined) {
      if (generationOrdinal === Number.MAX_SAFE_INTEGER) throw new Error('session generation ordinal exhausted')
      ordinal = ++generationOrdinal
      generations.set(sessionId, ordinal)
    }
    return ordinal
  }

  // Prototype identity may differ from the live host under jiti moduleCache:false;
  // the failure mode is a no-op wrapper, never an error into Pi.
  const wrappedPrompt = function (this: AgentSession, ...args: Parameters<AgentSession['prompt']>) {
    try {
      if (!disposed && this.sessionManager === root && !subscribed.has(this)) {
        const session = this
        const unsubscribe = session.subscribe(event => {
          const sessionId = session.sessionId
          try {
            ensureGeneration(sessionId)
            // Concurrent messages in one session are indistinguishable without ids: only the
            // latest streaming state is retained; other in-flight messages appear once persisted.
            if (event.type === 'message_start' || event.type === 'message_update') {
              // Clone-on-receipt protects frozen snapshots from native in-place mutation; cost is deliberate (perf refinement deferred).
              partials.set(sessionId, {
                sessionId,
                processGeneration,
                payload: structuredClone(event.message) as Json,
              })
            } else if (event.type === 'message_end' || event.type === 'turn_end'
              || (event.type === 'entry_appended' && event.entry.type === 'message')) {
              partials.delete(sessionId)
            }
          } catch {}
          try { collector({ sessionId, eventName: event.type, payload: event }) } catch {}
        })
        subscribed.add(this)
        unsubscriptions.add(unsubscribe)
      }
    } catch {}
    // Preserve receiver, arguments, return value, and rejection unchanged.
    return originalPrompt.apply(this, args)
  }
  prototype.prompt = wrappedPrompt

  return {
    bindRoot(nextManager) {
      if (nextManager === root) return
      root = nextManager
    },
    snapshot(request) {
      void request
      try {
        const sessionId = root.getSessionId()
        // Ordinals are observer-assigned because the native API exposes no session generation.
        const sessionGeneration = ensureGeneration(sessionId)
        const partial = partials.get(sessionId) ?? null
        const snapshot = readNativeSessionSnapshot(root, processGeneration, partial)
        const sequence = processSequence === Number.MAX_SAFE_INTEGER ? (() => { throw new Error('observer sequence exhausted') })() : ++processSequence
        const sessions = snapshot.sessions.map(session => ({ ...session, sessionGeneration }))
        // Snapshot cutoffs share the same process sequence as events and model state.
        const result: NativePiSnapshot = { ...snapshot, snapshotId: `${processGeneration}:${sessionId}:${sequence}`, sequence, state: 'ready', sessions, nextCursor: null, error: null }
        const freeze = (value: unknown): void => {
          if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
          for (const child of Object.values(value)) freeze(child)
          Object.freeze(value)
        }
        freeze(result)
        return result
      } catch (error) {
        return { snapshotId: 'error', processGeneration, sequence: 0, state: 'gap', rootSessionId: null, sessions: [], nextCursor: null, error: error instanceof Error ? error.message : String(error) }
      }
    },
    generationOf(sessionId) {
      return ensureGeneration(sessionId)
    },
    nextSequence() {
      if (processSequence === Number.MAX_SAFE_INTEGER) throw new Error('observer sequence exhausted')
      return ++processSequence
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (prototype.prompt === wrappedPrompt) {
        prototype.prompt = originalPrompt
      } else {
        try { console.warn('native session observer: prompt wrapper changed; leaving wrapper chain intact') } catch {}
      }
      for (const unsubscribe of unsubscriptions) {
        try { unsubscribe() } catch {}
      }
      unsubscriptions.clear()
      partials.clear()
    },
  }
}

/** Compatibility entry point for callers that only need raw event collection. */
export function installSessionObserver(manager: NativeManager, collector: (event: NativeObservedEvent) => void): { dispose(): void } {
  return createSessionObserver(manager, 0, collector)
}
