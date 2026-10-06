import type {
  AgentSession,
  AgentSessionEventListener,
  AgentSessionRuntime,
} from '@earendil-works/pi-coding-agent'
import type { CustomViewHost } from '../extensions/custom-view-host.ts'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { SessionSwitchPort, SessionTransitionRequest, SessionTransitionResult } from '../sessions/session-service.ts'
import { inspectNativeSessionFile } from '../sessions/session-store.ts'
import { RuntimeOperations } from './runtime-operations.ts'
import { PiSessionEventStream } from './session-events.ts'

export class PiSessionHost {
  readonly runtime: AgentSessionRuntime
  readonly events: PiSessionEventStream
  private disposed = false
  private sessionInvalidated = false
  private disposal: Promise<void> | undefined
  private readonly onDispose: () => void
  private readonly customViewHost?: CustomViewHost
  private readonly setExtensionUIActiveSession?: (sessionId: string | undefined) => void
  private readonly invalidateNativeUi?: () => void
  private readonly onSessionActive?: (session: AgentSession) => void
  private runtimeOperations: RuntimeOperations | undefined

  constructor(
    runtime: AgentSessionRuntime,
    onDispose: () => void,
    customViewHost?: CustomViewHost,
    setExtensionUIActiveSession?: (sessionId: string | undefined) => void,
    invalidateNativeUi?: () => void,
    onSessionActive?: (session: AgentSession) => void,
  ) {
    this.runtime = runtime
    this.onDispose = onDispose
    this.customViewHost = customViewHost
    this.setExtensionUIActiveSession = setExtensionUIActiveSession
    this.invalidateNativeUi = invalidateNativeUi
    this.onSessionActive = onSessionActive
    this.bindExtensionUISession(runtime.session.sessionId)
    this.events = new PiSessionEventStream(runtime.session)
    runtime.setRebindSession(async (session) => {
      if (!this.disposed) {
        this.sessionInvalidated = false
        this.configureActiveSession(session)
        this.events.rebind(session)
        this.bindExtensionUISession(session.sessionId)
      }
    })
    runtime.setBeforeSessionInvalidate(() => {
      this.sessionInvalidated = true
      this.runtime.session.setReloadLifecycleHandlers(undefined)
      if (!this.disposed) this.invalidateExtensionUINativeUi()
      this.events.invalidate()
      if (!this.disposed) this.bindExtensionUISession(undefined)
    })
  }

  get session(): AgentSession {
    return this.runtime.session
  }

  get services(): AgentSessionRuntime['services'] {
    return this.runtime.services
  }

  get diagnostics(): AgentSessionRuntime['diagnostics'] {
    return this.runtime.diagnostics
  }

  get sessionGeneration(): number {
    return this.events.sessionGeneration
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  setRuntimeOperations(operations: RuntimeOperations): void {
    this.assertActive()
    this.runtimeOperations = operations
  }

  setRuntimeScopeProvider(provider: () => RuntimeScope | undefined): void {
    this.assertActive()
    this.events.setRuntimeScopeProvider(provider)
  }

  subscribeSessionEvents(listener: Parameters<PiSessionEventStream['subscribe']>[0]): () => void {
    this.assertActive()
    return this.events.subscribe(listener)
  }

  async bindExtensions(bindings: Parameters<AgentSession['bindExtensions']>[0]): Promise<void> {
    this.assertActive()
    await this.session.bindExtensions(bindings)
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.assertActive()
    return this.session.subscribe(listener)
  }

  prompt(...args: Parameters<AgentSession['prompt']>): ReturnType<AgentSession['prompt']> {
    this.assertActive()
    return this.session.prompt(...args)
  }

  abort(): Promise<void> {
    this.assertActive()
    return this.session.abort()
  }

  newSession(...args: Parameters<AgentSessionRuntime['newSession']>): ReturnType<AgentSessionRuntime['newSession']> {
    return this.runSessionReplacement(() => this.runtime.newSession(...args))
  }

  switchSession(...args: Parameters<AgentSessionRuntime['switchSession']>): ReturnType<AgentSessionRuntime['switchSession']> {
    return this.runSessionReplacement(() => this.runtime.switchSession(...args))
  }

  fork(...args: Parameters<AgentSessionRuntime['fork']>): ReturnType<AgentSessionRuntime['fork']> {
    return this.runSessionReplacement(() => this.runtime.fork(...args))
  }

  importFromJsonl(...args: Parameters<AgentSessionRuntime['importFromJsonl']>): ReturnType<AgentSessionRuntime['importFromJsonl']> {
    return this.runSessionReplacement(() => this.runtime.importFromJsonl(...args))
  }

  reload(...args: Parameters<AgentSession['reload']>): ReturnType<AgentSession['reload']> {
    return this.runMutation(() => this.session.reload(...args))
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive()
    if (!this.runtimeOperations) {
      return Promise.reject(new Error('Runtime lifecycle operations have not been bound to the Pi session host.'))
    }
    return this.runtimeOperations.runLifecycle(async () => {
      this.assertActive()
      this.events.invalidate()
      try {
        return await operation()
      } finally {
        if (!this.disposed) this.events.rebind(this.runtime.session)
      }
    })
  }

  private runSessionReplacement<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive()
    const currentSession = this.runtime.session
    currentSession.setReloadLifecycleHandlers(undefined)
    return this.runMutation(operation).finally(() => {
      if (!this.disposed && !this.sessionInvalidated && this.runtime.session === currentSession) {
        this.configureActiveSession(currentSession)
      }
    })
  }

  private bindExtensionUISession(sessionId: string | undefined): void {
    try {
      this.setExtensionUIActiveSession?.(sessionId)
    } catch {
      // Extension UI state is a passive mirror and must not interrupt Pi session lifecycle.
    }
  }

  private invalidateExtensionUINativeUi(): void {
    try {
      this.invalidateNativeUi?.()
    } catch {
      // Extension UI is a passive mirror and must not interrupt Pi session lifecycle.
    }
  }

  private configureActiveSession(session: AgentSession): void {
    try {
      this.onSessionActive?.(session)
    } catch {
      // Native UI configuration is a passive mirror and must not interrupt Pi session lifecycle.
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('The Pi root session host has been disposed.')
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.runtime.session.setReloadLifecycleHandlers(undefined)
    this.invalidateExtensionUINativeUi()
    this.bindExtensionUISession(undefined)
    this.events.close()
    const disposeRuntime = async (): Promise<void> => {
      this.customViewHost?.dispose()
      try {
        // A workspace switch or trust revocation must stop an in-flight turn before
        // the old runtime is torn down.
        await this.runtime.session.abort()
      } catch {
        // Disposal still has to release the runtime if abort is already settling.
      }
      try {
        await this.runtime.dispose()
      } finally {
        this.onDispose()
      }
    }
    this.disposal = this.runtimeOperations
      ? this.runtimeOperations.runLifecycle(disposeRuntime)
      : disposeRuntime()
    return this.disposal
  }
}

/** Typed bridge for the existing /new, /resume, /fork, /clone and /import command seam. */
export function createPiSessionSwitchPort(getHost: () => PiSessionHost | undefined): SessionSwitchPort {
  return {
    async transition(request: SessionTransitionRequest): Promise<SessionTransitionResult> {
      const host = getHost()
      if (!host) throw new Error('There is no active Pi session host.')
      if ('sourceSessionId' in request && host.session.sessionId !== request.sourceSessionId) {
        throw new Error('The session transition request is stale.')
      }

      if (request.kind === 'new') {
        const result = await host.newSession({
          ...(request.parentSessionFile ? { parentSession: request.parentSessionFile } : {}),
        })
        if (result.cancelled) return { status: 'cancelled' }
        return {
          status: 'applied',
          sessionId: host.session.sessionId,
          ...(host.session.sessionFile ? { sessionFile: host.session.sessionFile } : {}),
        }
      }
      if (request.kind === 'resume') {
        if (await inspectNativeSessionFile(request.sessionFile) !== 'valid') {
          throw new Error('The requested session file is corrupt or unreadable.')
        }
        const result = await host.switchSession(request.sessionFile, { cwdOverride: request.cwd })
        if (result.cancelled) return { status: 'cancelled' }
        return {
          status: 'applied',
          sessionId: host.session.sessionId,
          ...(host.session.sessionFile ? { sessionFile: host.session.sessionFile } : {}),
        }
      }
      if (request.kind === 'import') {
        if (await inspectNativeSessionFile(request.sessionFile) !== 'valid') {
          throw new Error('The requested session file is corrupt or unreadable.')
        }
        const result = await host.importFromJsonl(request.sessionFile, request.cwd)
        if (result.cancelled) return { status: 'cancelled' }
        return {
          status: 'applied',
          sessionId: host.session.sessionId,
          ...(host.session.sessionFile ? { sessionFile: host.session.sessionFile } : {}),
        }
      }
      if (request.kind === 'fork' || request.kind === 'clone') {
        const result = await host.fork(request.entryId, { position: request.position })
        if (result.cancelled) return { status: 'cancelled' }
        return {
          status: 'applied',
          sessionId: host.session.sessionId,
          ...(host.session.sessionFile ? { sessionFile: host.session.sessionFile } : {}),
          ...(result.selectedText ? { selectedText: result.selectedText } : {}),
        }
      }
      throw new Error('The requested session transition is unsupported.')
    },
  }
}
