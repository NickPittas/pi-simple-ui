import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { startNativePi, type NativeProcessHost, type NativeProcessScope } from '../pi/native-process-host.ts'
import { NativeWorkspaceRegistry, readWorkspaceIdentity } from './native-workspace-registry.ts'
import type { WorkspaceInfo } from '../../shared/workspaces.ts'
import type { OpenSessionRequest, Stop } from '../../shared/native-pi.ts'
import { validateWorkspaceSessionFile } from '../pi/session-catalog.ts'
import { isNativePiModelStateResult, isNativePiSessionsResult } from '../../shared/native-pi-validation.ts'

export type NativeWorkspaceAuthorization =
  | { readonly granted: true; readonly workspaceId: string; readonly canonicalPath: string }
  | { readonly granted: false; readonly reason: 'invalid' | 'missing' | 'moved' | 'unavailable' }
type Listener = (workspaces: readonly WorkspaceInfo[]) => void
type HostBinding = {
  readonly workspaceId: string; readonly host: NativeProcessHost; readonly canonicalPath: string
  readonly identity: { readonly device: string; readonly inode: string }; readonly owned: boolean; stopStatus: Stop; watcher?: FSWatcher
}
export type NativeWorkspaceOpenResult =
  | { readonly outcome: 'opened'; readonly workspaceId: string; readonly canonicalPath: string; readonly processGeneration: number }
  | { readonly outcome: 'failed'; readonly reason: string }
type OpenOptions = { readonly cols?: number; readonly rows?: number; readonly sessionFile?: string }

export class NativeWorkspaceService {
  private readonly listeners = new Set<Listener>()
  private binding: HostBinding | null = null
  private selectionIntent = 0
  private opening: Promise<void> = Promise.resolve()
  private disposed = false
  private cancelPromise?: Promise<void>
  private cancellingBinding?: HostBinding | null
  private disposePromise?: Promise<void>

  // The injected registry is the authority for path and filesystem-identity resolution.
  constructor(
    private readonly registry: NativeWorkspaceRegistry,
    private readonly hostFactory: typeof startNativePi = startNativePi,
  ) {}

  list(): WorkspaceInfo[] {
    return this.registry.all().map((record) => {
      const info = this.registry.info(record.path)
      return {
        id: record.id,
        path: record.path,
        name: basename(record.path) || record.path,
        status: info.status === 'available' && info.matchesStoredIdentity ? 'available'
          : info.status === 'moved' ? 'moved' : 'missing',
        firstOpenedAt: record.firstOpenedAt,
        lastOpenedAt: record.lastOpenedAt,
        movedFrom: record.previousPaths[0] ?? null,
        trust: { decision: 'native-managed', sourcePath: null, inherited: false, requiresReapproval: false },
      }
    })
  }

  subscribe(listener: Listener): Stop {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  open(path: string, options: OpenOptions = {}): Promise<NativeWorkspaceOpenResult> {
    if (this.disposed) return Promise.resolve({ outcome: 'failed', reason: 'unavailable' })
    const intent = ++this.selectionIntent
    const current = this.binding
    const previous = current?.owned ? current.host : null
    if (current) this.detachBinding(current, false)
    this.emit()
    const operation = this.opening.then(() => this.openSelection(path, options, intent, previous))
    this.opening = operation.then(() => {}, () => {})
    return operation
  }

  async openSession(request: OpenSessionRequest): Promise<NativeWorkspaceOpenResult> {
    const unavailable = (reason: string): NativeWorkspaceOpenResult => ({ outcome: 'failed', reason })
    const binding = this.binding
    if (this.disposed || !binding || !binding.owned || binding.workspaceId !== request.workspaceId
      || binding.host.scope.processGeneration !== request.expectedProcessGeneration) {
      return unavailable('The active workspace or Pi process changed; no session was opened.')
    }
    const authorization = this.authorizeRuntimeScope(binding.canonicalPath)
    if (!authorization.granted || authorization.workspaceId !== request.workspaceId
      || authorization.canonicalPath !== binding.canonicalPath) {
      return unavailable('The active workspace is unavailable; no session was opened.')
    }

    const intent = this.selectionIntent
    let modelReply: Awaited<ReturnType<typeof binding.host.controlRequest>>
    let sessionsReply: Awaited<ReturnType<typeof binding.host.controlRequest>> | null
    try {
      ;[modelReply, sessionsReply] = await Promise.all([
        binding.host.controlRequest({ operation: 'model-state', payload: {} }),
        request.file === null ? Promise.resolve(null) : binding.host.controlRequest({ operation: 'sessions-list', payload: {} }),
      ])
    } catch {
      return unavailable('Native Pi could not refresh session state; no session was opened.')
    }
    if (!isNativePiModelStateResult(modelReply.value) || !modelReply.value.state
      || modelReply.value.state.processGeneration !== request.expectedProcessGeneration
      || modelReply.value.state.sessionId !== request.expectedSessionId) {
      return unavailable('The active Pi session changed or is unavailable; no session was opened.')
    }
    if (modelReply.value.state.busy) {
      return unavailable('Pi has streaming or queued work; wait for it to finish before switching sessions.')
    }
    if (request.file !== null) {
      if (typeof request.file !== 'string') return unavailable('The session file path is invalid; no session was opened.')
      const fileProblem = await validateWorkspaceSessionFile(binding.canonicalPath, request.file)
      if (fileProblem !== null) return unavailable(`${fileProblem} No session was opened.`)
      if (!sessionsReply || !isNativePiSessionsResult(sessionsReply.value) || sessionsReply.value.error !== null) {
        return unavailable('Native Pi could not list saved sessions; no session was opened.')
      }
      if (!sessionsReply.value.sessions.some((session) => session.file === request.file)) {
        return unavailable('That saved session is not available in the active workspace; no session was opened.')
      }
    }

    const currentAuthorization = this.authorizeRuntimeScope(binding.canonicalPath)
    if (this.disposed || this.binding !== binding || this.selectionIntent !== intent
      || currentAuthorization.granted !== true || currentAuthorization.workspaceId !== request.workspaceId
      || currentAuthorization.canonicalPath !== binding.canonicalPath
      || binding.host.scope.processGeneration !== request.expectedProcessGeneration) {
      return unavailable('The active workspace or Pi process changed; no session was opened.')
    }
    return this.open(binding.canonicalPath, request.file === null ? {} : { sessionFile: request.file })
  }

  // Restarts only the app-owned Pi child for the active workspace, resuming the same session file, through the normal open() path.
  async restartActive(): Promise<{ outcome: 'restarted' | 'rejected'; reason: string | null }> {
    const binding = this.binding
    if (this.disposed || !binding || !binding.owned) return { outcome: 'rejected', reason: 'No app-owned Pi process is active.' }
    let sessionFile: string | null
    try { sessionFile = await binding.host.sessionFile() } catch {
      return { outcome: 'rejected', reason: 'Pi could not report its current session; it was not restarted.' }
    }
    if (this.binding !== binding) return { outcome: 'rejected', reason: 'The active workspace or Pi process changed; it was not restarted.' }
    const result = await this.open(binding.canonicalPath, sessionFile ? { sessionFile } : {})
    return result.outcome === 'opened' ? { outcome: 'restarted', reason: null }
      : { outcome: 'rejected', reason: 'Pi could not be restarted (' + result.reason + ').' }
  }

  async openRecent(id?: string): Promise<NativeWorkspaceOpenResult> {
    try {
      const record = id ? this.registry.find(id)
        : this.registry.all().sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)[0]
      return record ? this.open(record.path) : { outcome: 'failed', reason: 'unavailable' }
    } catch {
      return { outcome: 'failed', reason: 'unavailable' }
    }
  }

  private async openSelection(
    path: string, options: OpenOptions, intent: number, previous: NativeProcessHost | null,
  ): Promise<NativeWorkspaceOpenResult> {
    let host: NativeProcessHost | null = null
    try {
      // This checks folder identity only; native Pi trust remains reachable without app approval.
      const authorization = this.authorizeRuntimeScope(path)
      if (previous) {
        await previous.dispose()
        if (intent !== this.selectionIntent) return { outcome: 'failed', reason: 'superseded' }
      }
      if (!authorization.granted) return { outcome: 'failed', reason: authorization.reason }
      if (intent !== this.selectionIntent) return { outcome: 'failed', reason: 'superseded' }
      host = await this.hostFactory({
        cwd: authorization.canonicalPath,
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
        // Exit is reported by transport status; do not infer workspace state from the exit code.
        onExit: () => {},
      })
      if (intent !== this.selectionIntent) {
        try { await host.dispose() } catch {}
        host = null
        return { outcome: 'failed', reason: 'superseded' }
      }
      this.bindHost(authorization.canonicalPath, host, true)
      return {
        outcome: 'opened', workspaceId: authorization.workspaceId,
        canonicalPath: authorization.canonicalPath, processGeneration: host.scope.processGeneration,
      }
    } catch {
      if (host) {
        if (this.binding?.host === host) this.detachBinding(this.binding)
        try { await host.dispose() } catch {}
      }
      return { outcome: 'failed', reason: 'unavailable' }
    }
  }

  cancel(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.cancelPromise && this.cancellingBinding === this.binding) return this.cancelPromise
    ++this.selectionIntent
    const binding = this.binding
    if (binding) this.detachBinding(binding, false)
    const cancelPromise = Promise.resolve().then(() => binding?.owned ? binding.host.dispose() : undefined)
      .catch(() => {}).finally(() => { if (this.cancelPromise === cancelPromise) { this.cancelPromise = undefined; this.cancellingBinding = undefined } })
    this.cancellingBinding = binding
    this.cancelPromise = cancelPromise
    this.emit()
    return cancelPromise
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    ++this.selectionIntent
    const binding = this.binding
    if (binding) this.detachBinding(binding, false)
    this.disposePromise = Promise.resolve().then(() => binding?.owned ? binding.host.dispose() : undefined)
      .catch(() => {}).then(() => { this.listeners.clear() })
    this.emit()
    return this.disposePromise
  }

  getRuntimeScope(path: string): NativeProcessScope | null {
    const record = this.registry.record(path)
    const info = this.registry.info(path)
    const binding = this.binding
    return record && info.matchesStoredIdentity && info.status === 'available'
      && binding?.workspaceId === record.id ? binding.host.scope : null
  }

  // GUI-side scoping only; actual launch authorization is delegated to native Pi.
  authorizeRuntimeScope(path: string): NativeWorkspaceAuthorization {
    const info = this.registry.info(path)
    if (info.status === 'invalid') return { granted: false, reason: 'invalid' }
    if (info.status === 'missing') return { granted: false, reason: 'missing' }
    if (info.status === 'moved') return { granted: false, reason: 'moved' }
    let record = this.registry.record(path)
    let matchesStoredIdentity = info.matchesStoredIdentity
    if (!record && info.status === 'available' && info.canonicalPath) {
      const identity = readWorkspaceIdentity(path)
      if (!identity.ok || identity.canonicalPath !== info.canonicalPath) return { granted: false, reason: 'unavailable' }
      // A fresh record is built from this identity; moved folders were rejected above and have no ID to retain.
      record = this.registry.prepareRecord(info.canonicalPath, identity.identity)
      matchesStoredIdentity = true
    }
    if (!record || !matchesStoredIdentity || !info.canonicalPath) {
      return { granted: false, reason: 'unavailable' }
    }
    return { granted: true, workspaceId: record.id, canonicalPath: info.canonicalPath }
  }

  activeHost(): NativeProcessHost | null { return this.binding?.host ?? null }

  // External launch lifecycle owns the host; this service only binds it by registry workspace ID.
  setHost(path: string, host: NativeProcessHost | null): void {
    this.bindHost(path, host, false)
  }

  private bindHost(path: string, host: NativeProcessHost | null, owned: boolean): void {
    if (this.disposed) return
    const authorization = this.authorizeRuntimeScope(path)
    const previous = this.binding
    if (!authorization.granted && host) throw new Error('Workspace identity is unavailable.')
    // An unresolved or cross-workspace null never clears another workspace's binding.
    if (!host && (!authorization.granted || previous?.workspaceId !== authorization.workspaceId)) return
    if (host && authorization.granted && previous?.host === host && previous.workspaceId === authorization.workspaceId) return
    if (previous) this.detachBinding(previous, false)
    if (host && authorization.granted) {
      const identity = readWorkspaceIdentity(authorization.canonicalPath)
      if (!identity.ok || identity.canonicalPath !== authorization.canonicalPath) {
        throw new Error('Workspace identity is unavailable.')
      }
      const binding: HostBinding = { workspaceId: authorization.workspaceId, host,
        canonicalPath: identity.canonicalPath, identity: identity.identity, owned, stopStatus: () => {} }
      this.binding = binding
      binding.stopStatus = host.onStatus((status) => {
        if (this.disposed || this.binding !== binding) return
        if (status.processGeneration === host.scope.processGeneration && status.state === 'disposed') {
          this.detachBinding(binding)
        }
      })
      if (this.binding === binding) this.watchBinding(binding)
    }
    this.emit()
  }

  private detachBinding(binding: HostBinding, emit = true): void {
    if (this.binding !== binding) return
    this.binding = null; try { binding.watcher?.close() } catch {}
    binding.watcher = undefined; binding.stopStatus()
    if (emit && !this.disposed) this.emit()
  }

  private watchBinding(binding: HostBinding): void {
    try {
      const watcher = watch(dirname(binding.canonicalPath), { persistent: false }, (_event, filename) => {
        if (filename && filename.toString() !== basename(binding.canonicalPath)) return
        try { this.validateBinding(binding, watcher) } catch {}
      })
      binding.watcher = watcher; watcher.on('error', () => { try { this.validateBinding(binding, watcher) } catch {} })
    } catch { /* Identity validation remains authoritative when watching is unavailable. */ }
  }

  private validateBinding(binding: HostBinding, watcher: FSWatcher): void {
    if (this.disposed || this.binding !== binding || binding.watcher !== watcher) return
    const current = readWorkspaceIdentity(binding.canonicalPath)
    if (current.ok && current.canonicalPath === binding.canonicalPath && current.identity.device === binding.identity.device
      && current.identity.inode === binding.identity.inode) return
    this.detachBinding(binding)
    if (binding.owned) void binding.host.dispose().catch(() => {})
  }

  private emit(): void {
    const snapshot = this.list()
    for (const listener of [...this.listeners]) {
      try { listener(snapshot) } catch { /* Listener failures are isolated. */ }
    }
  }
}
