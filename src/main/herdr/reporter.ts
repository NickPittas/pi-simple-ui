import { randomUUID } from 'node:crypto'
import { posix as posixPath, win32 as win32Path } from 'node:path'
import type {
  AgentSettledEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent'
import {
  createHerdrReportTransport,
  resolveHerdrEndpoint,
  type HerdrAgentReportRequest,
  type HerdrAgentState,
  type HerdrEndpoint,
  type HerdrReportTransport,
} from './transport.ts'

const MAX_BLOCKED_MESSAGE_LENGTH = 256
const REPORT_SOURCE = 'herdr:pi'

interface SessionReference {
  readonly agent_session_path?: string
  readonly agent_session_id?: string
}

interface QueuedState {
  readonly state: HerdrAgentState
  readonly message?: string
  readonly seq: number
}

type PendingRequest =
  | { readonly kind: 'session'; readonly request: HerdrAgentReportRequest; readonly resolve: () => void }
  | { readonly kind: 'state'; readonly state: QueuedState }

export interface HerdrReporterOptions {
  /** An explicit main-process opt-in. The renderer must not control this flag. */
  readonly enabled: boolean
  /** Injectable for isolated tests; production reads process.env by default. */
  readonly environment?: NodeJS.ProcessEnv
  readonly createTransport?: (endpoint: HerdrEndpoint) => HerdrReportTransport
}

function sessionReference(context: ExtensionContext): SessionReference | undefined {
  let sessionPath: string | undefined
  try {
    const candidate = context.sessionManager.getSessionFile()
    if (typeof candidate === 'string'
      && (posixPath.isAbsolute(candidate) || win32Path.isAbsolute(candidate))) {
      sessionPath = candidate
    }
  } catch {
    // Fall back to the session ID when a session file is unavailable.
  }
  if (sessionPath) return { agent_session_path: sessionPath }

  try {
    const sessionId = context.sessionManager.getSessionId()
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      return { agent_session_id: sessionId }
    }
  } catch {
    // A context without a durable reference is not reportable.
  }
  return undefined
}

function blockedEvent(value: unknown): { readonly active: boolean; readonly label?: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.active !== 'boolean') return undefined
  return {
    active: candidate.active,
    ...(typeof candidate.label === 'string'
      ? { label: candidate.label.slice(0, MAX_BLOCKED_MESSAGE_LENGTH) }
      : {}),
  }
}

function createId(): string {
  return `${REPORT_SOURCE}:${randomUUID()}`
}

/** Create a per-Pi-runtime reporter; no module state is shared across workspace sessions. */
export function createHerdrReporterExtension(options: HerdrReporterOptions): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    if (!options.enabled) return
    const endpoint = resolveHerdrEndpoint(options.environment)
    if (!endpoint) return

    const paneId = endpoint.paneId
    const transport = (options.createTransport ?? createHerdrReportTransport)(endpoint)
    let rootRpcSession = false
    let disposed = false
    let agentActive = false
    let blockedCount = 0
    let blockedMessage: string | undefined
    let currentSessionReference: SessionReference | undefined
    let lastState: HerdrAgentState | undefined
    let lastMessage: string | undefined
    let reportSeq = Date.now() * 1_000
    let sendInFlight = false
    const queue: PendingRequest[] = []
    const subscriptions: Array<() => void> = []

    const nextSeq = (): number => {
      reportSeq = Math.max(Date.now() * 1_000, reportSeq + 1)
      return reportSeq
    }

    const dispose = (): void => {
      if (disposed) return
      disposed = true
      rootRpcSession = false
      for (const pending of queue.splice(0)) {
        if (pending.kind === 'session') pending.resolve()
      }
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
      transport.dispose()
    }

    const sendSession = (sessionStartSource?: string): Promise<void> => {
      if (disposed || !rootRpcSession || !currentSessionReference) return Promise.resolve()
      const request: HerdrAgentReportRequest = {
        id: createId(),
        method: 'pane.report_agent_session',
        params: {
          pane_id: paneId,
          source: REPORT_SOURCE,
          agent: 'pi',
          seq: nextSeq(),
          ...(sessionStartSource ? { session_start_source: sessionStartSource } : {}),
          ...currentSessionReference,
        },
      }
      return new Promise((resolve) => {
        queue.push({ kind: 'session', request, resolve })
        void drainQueue()
      })
    }

    const desiredState = (): { readonly state: HerdrAgentState; readonly message?: string } => {
      if (blockedCount > 0) return { state: 'blocked', ...(blockedMessage ? { message: blockedMessage } : {}) }
      return { state: agentActive ? 'working' : 'idle' }
    }

    const publishState = (force = false): void => {
      if (disposed || !rootRpcSession) return
      const next = desiredState()
      if (!force && next.state === lastState && next.message === lastMessage) return
      lastState = next.state
      lastMessage = next.message
      const state: QueuedState = { ...next, seq: nextSeq() }
      const tail = queue[queue.length - 1]
      if (tail?.kind === 'state') queue[queue.length - 1] = { kind: 'state', state }
      else queue.push({ kind: 'state', state })
      void drainQueue()
    }

    async function drainQueue(): Promise<void> {
      if (disposed || sendInFlight) return
      sendInFlight = true
      try {
        while (!disposed && queue.length > 0) {
          const pending = queue.shift()
          if (!pending) continue
          if (pending.kind === 'session') {
            try {
              await transport.send(pending.request)
            } catch {
              // Status reporting must not change the Pi session lifecycle.
            }
            pending.resolve()
            continue
          }
          if (!currentSessionReference) continue
          try {
            await transport.send({
              id: createId(),
              method: 'pane.report_agent',
              params: {
                pane_id: paneId,
                source: REPORT_SOURCE,
                agent: 'pi',
                state: pending.state.state,
                ...(pending.state.message ? { message: pending.state.message } : {}),
                seq: pending.state.seq,
                ...currentSessionReference,
              },
            })
          } catch {
            // A Herdr endpoint can disappear independently of the application session.
          }
        }
      } finally {
        sendInFlight = false
        if (!disposed && queue.length > 0) void drainQueue()
      }
    }

    subscriptions.push(pi.on('session_start', async (event: SessionStartEvent, context: ExtensionContext) => {
      rootRpcSession = context.mode === 'rpc'
      if (!rootRpcSession) {
        currentSessionReference = undefined
        return
      }
      currentSessionReference = sessionReference(context)
      blockedCount = 0
      blockedMessage = undefined
      agentActive = context.isIdle() === false
      await sendSession(event.reason)
      publishState(true)
    }))

    subscriptions.push(pi.on('agent_start', (_event: AgentStartEvent, context: ExtensionContext) => {
      if (disposed || !rootRpcSession) return
      currentSessionReference = sessionReference(context)
      agentActive = true
      publishState()
      void sendSession()
    }))

    subscriptions.push(pi.on('agent_settled', (_event: AgentSettledEvent, context: ExtensionContext) => {
      if (disposed || !rootRpcSession || context.isIdle() !== true) return
      agentActive = false
      publishState()
    }))

    subscriptions.push(pi.on('session_shutdown', (_event: SessionShutdownEvent) => dispose()))
    subscriptions.push(pi.events.on('herdr:blocked', (value: unknown) => {
      if (disposed || !rootRpcSession) return
      const event = blockedEvent(value)
      if (!event) return
      if (event.active) {
        blockedCount += 1
        blockedMessage = event.label
      } else {
        blockedCount = Math.max(0, blockedCount - 1)
        if (blockedCount === 0) blockedMessage = undefined
      }
      publishState()
    }))
  }
}
