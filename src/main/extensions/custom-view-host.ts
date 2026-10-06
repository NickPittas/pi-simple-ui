import { randomUUID } from 'node:crypto'
import {
  resolveSemanticView,
  type JSONValue,
  type ResolvedSemanticView,
  type SemanticView,
  type SemanticViewController,
} from '@earendil-works/pi-coding-agent'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'
import { isPlainRecord, isRuntimeScope, type RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { ExtensionUIEvent, SemanticViewActionAck, SemanticViewActionRequest } from '../../shared/extension-ui.ts'
import type { SemanticViewAdapter, SemanticViewAdapterRegistry } from './adapters/registry.ts'

const MAX_ACTIVE_VIEWS = 32
const MAX_JSON_DEPTH = 24
const MAX_JSON_NODES = 4_096
const MAX_JSON_STRING_LENGTH = 16_384
const MAX_JSON_BYTES = 64 * 1024
const MAX_INSTANCE_ID_LENGTH = 80

interface ErasedController extends SemanticViewController<JSONValue, JSONValue> {
  dispatch(action: JSONValue): void
}

interface ErasedDefinition {
  readonly id: string
  readonly version: number
  readonly actionIds: readonly string[]
  readonly cancelValue: unknown
  readonly validateState: (value: JSONValue) => boolean
  readonly validateAction: (value: JSONValue) => boolean
  readonly create: (options: { readonly done: (value: unknown) => void; readonly signal: AbortSignal }) => ErasedController
}

interface SemanticViewInstance {
  readonly id: string
  readonly scope: RuntimeScope
  readonly resolved: ResolvedSemanticView<unknown>
  readonly adapter: SemanticViewAdapter
  readonly definition: ErasedDefinition
  readonly abort: AbortController
  readonly widgetKey?: string
  readonly widgetHandle?: SemanticView<unknown>
  actionQueue: Promise<void>
  controller?: ErasedController
  unsubscribe?: () => void
  rendererCaller?: AuthorizedIpcCaller
  revision: number
  state?: JSONValue
  stateJson?: string
  settled: boolean
  completionPublished: boolean
  resolve?: (value: unknown) => void
}

interface BoundRenderer {
  readonly caller: AuthorizedIpcCaller
}

function sameScope(left: RuntimeScope | undefined, right: RuntimeScope): boolean {
  return left?.ownerId === right.ownerId && left.generation === right.generation
}

function sameCaller(left: AuthorizedIpcCaller | undefined, right: AuthorizedIpcCaller): boolean {
  return left?.windowId === right.windowId
    && left.webContentsId === right.webContentsId
    && left.frameUrl === right.frameUrl
}

function cloneBoundedJson(value: unknown): JSONValue | undefined {
  let visited = 0
  const clone = (current: unknown, depth: number): JSONValue | undefined => {
    if (depth > MAX_JSON_DEPTH || ++visited > MAX_JSON_NODES) return undefined
    if (current === null || typeof current === 'boolean') return current
    if (typeof current === 'string') return current.length <= MAX_JSON_STRING_LENGTH ? current : undefined
    if (typeof current === 'number') return Number.isFinite(current) ? current : undefined
    if (Array.isArray(current)) {
      if (current.length > MAX_JSON_NODES) return undefined
      const result: JSONValue[] = []
      for (const entry of current) {
        const cloned = clone(entry, depth + 1)
        if (cloned === undefined) return undefined
        result.push(cloned)
      }
      return result
    }
    if (!isPlainRecord(current)) return undefined
    const keys = Object.keys(current)
    if (keys.length > MAX_JSON_NODES) return undefined
    const result: Record<string, JSONValue> = Object.create(null) as Record<string, JSONValue>
    for (const key of keys) {
      if (key.length > MAX_JSON_STRING_LENGTH) return undefined
      const cloned = clone(current[key], depth + 1)
      if (cloned === undefined) return undefined
      result[key] = cloned
    }
    return result
  }

  const cloned = clone(value, 0)
  if (cloned === undefined) return undefined
  try {
    return Buffer.byteLength(JSON.stringify(cloned), 'utf8') <= MAX_JSON_BYTES ? cloned : undefined
  } catch {
    return undefined
  }
}

function isActionRecord(value: JSONValue): value is Record<string, JSONValue> & { readonly type: string } {
  return isPlainRecord(value) && typeof value.type === 'string' && value.type.length > 0
}

function eraseDefinition(view: ResolvedSemanticView<unknown>): ErasedDefinition {
  return view.definition as unknown as ErasedDefinition
}

/** Main-process owner of SDK-issued semantic controllers and renderer action queues. */
export class CustomViewHost {
  private readonly scope: RuntimeScope
  private readonly registry: SemanticViewAdapterRegistry
  private readonly publish: (event: ExtensionUIEvent) => void
  private readonly instances = new Map<string, SemanticViewInstance>()
  private readonly widgetInstances = new Map<string, { readonly handle: SemanticView<unknown>; readonly instanceId: string }>()
  private nativeRuntime: object | undefined
  private renderer: BoundRenderer | undefined
  private disposed = false

  constructor(options: {
    readonly scope: RuntimeScope
    readonly registry: SemanticViewAdapterRegistry
    readonly publish: (event: ExtensionUIEvent) => void
  }) {
    if (!isRuntimeScope(options.scope)) throw new TypeError('A valid runtime scope is required for semantic views.')
    this.scope = Object.freeze({ ownerId: options.scope.ownerId, generation: options.scope.generation })
    this.registry = options.registry
    this.publish = options.publish
  }

  configureNativeRuntime(runtime: object): void {
    if (this.disposed) return
    if (this.nativeRuntime === runtime) return
    this.closeAll('cancelled')
    this.nativeRuntime = runtime
  }

  supports(handle: SemanticView<unknown>): boolean {
    try {
      const resolved = resolveSemanticView(handle)
      return !this.disposed
        && this.nativeRuntime !== undefined
        && resolved.extensionRuntime === this.nativeRuntime
        && this.registry.resolve(resolved) !== undefined
    } catch {
      return false
    }
  }

  open<T>(handle: SemanticView<T>): Promise<T> {
    const resolved = this.resolveAllowed(handle)
    if (!resolved) return Promise.reject(new Error('The semantic view is not available in this host.'))
    if (this.instances.size >= MAX_ACTIVE_VIEWS) return Promise.reject(new Error('The semantic view limit was reached.'))

    const adapter = this.registry.resolve(resolved)
    if (!adapter) return Promise.reject(new Error('The semantic view is not available in this host.'))
    return this.createInstance(resolved, adapter) as Promise<T>
  }

  openWidget(key: string, handle: SemanticView<unknown>): boolean {
    if (!key || key.length > 256) return false
    const resolved = this.resolveAllowed(handle)
    if (!resolved) return false
    const adapter = this.registry.resolve(resolved)
    if (!adapter) return false
    const widgetId = `${resolved.extensionPath}\0${key}`
    const existing = this.widgetInstances.get(widgetId)
    if (existing?.handle === handle && this.instances.has(existing.instanceId)) return true
    if (existing) this.cancelInstance(this.instances.get(existing.instanceId), 'cancelled')
    if (this.instances.size >= MAX_ACTIVE_VIEWS) return false

    const completion = this.createInstance(resolved, adapter, {
      widgetKey: widgetId,
      widgetHandle: handle,
    })
    void completion.catch(() => undefined)
    return true
  }

  clearWidget(key: string, handle: SemanticView<unknown>): boolean {
    if (!key || key.length > 256) return false
    const resolved = this.resolveAllowed(handle)
    if (!resolved) return false
    const widgetId = `${resolved.extensionPath}\0${key}`
    const existing = this.widgetInstances.get(widgetId)
    if (!existing || existing.handle !== handle) return false
    this.cancelInstance(this.instances.get(existing.instanceId), 'cancelled')
    return true
  }

  bindRenderer(caller: AuthorizedIpcCaller): void {
    if (this.disposed) return
    if (this.renderer && !sameCaller(this.renderer.caller, caller)) {
      this.rendererDisconnected(this.renderer.caller)
    }
    this.renderer = { caller }
    for (const instance of this.instances.values()) {
      if (!instance.settled && sameScope(instance.scope, this.scope)) {
        instance.rendererCaller = caller
        this.publishSnapshot(instance)
      }
    }
  }

  rendererDisconnected(caller: AuthorizedIpcCaller): void {
    if (!this.renderer || !sameCaller(this.renderer.caller, caller)) return
    this.renderer = undefined
    for (const instance of [...this.instances.values()]) {
      if (sameCaller(instance.rendererCaller, caller)) this.cancelInstance(instance, 'cancelled')
    }
  }

  authorizeAction(caller: AuthorizedIpcCaller, scope: RuntimeScope | undefined, request: SemanticViewActionRequest): boolean {
    const instance = this.instances.get(request.instanceId)
    if (!instance || !this.isCurrentInstance(instance, caller, scope)
      || !Number.isSafeInteger(request.revision) || request.revision < 1) {
      return false
    }
    const action = cloneBoundedJson(request.action)
    return action !== undefined
      && this.isAuthorizedAction(instance, action)
  }

  async dispatchAction(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope | undefined,
    request: SemanticViewActionRequest,
  ): Promise<SemanticViewActionAck> {
    const instance = this.instances.get(request.instanceId)
    if (!instance || !this.isCurrentInstance(instance, caller, scope)) {
      return { accepted: false, revision: instance?.revision ?? 0, reason: 'closed' }
    }
    if (request.revision !== instance.revision) {
      return { accepted: false, revision: instance.revision, reason: 'stale-revision' }
    }
    const action = cloneBoundedJson(request.action)
    if (action === undefined || !this.isAuthorizedAction(instance, action)) {
      return { accepted: false, revision: instance.revision, reason: 'unsupported-action' }
    }

    const dispatch = instance.actionQueue.then(async (): Promise<SemanticViewActionAck> => {
      if (!this.isCurrentInstance(instance, caller, scope)) {
        return { accepted: false, revision: instance.revision, reason: 'closed' }
      }
      if (request.revision !== instance.revision) {
        return { accepted: false, revision: instance.revision, reason: 'stale-revision' }
      }
      if (!this.isAuthorizedAction(instance, action) || !instance.controller) {
        return { accepted: false, revision: instance.revision, reason: 'unsupported-action' }
      }
      try {
        // The public SDK types dispatch as void; Promise.resolve also serializes runtimes that
        // implement asynchronous dispatch without widening that public contract.
        await Promise.resolve(instance.controller.dispatch(action))
        if (!this.isCurrentInstance(instance, caller, scope)) {
          return { accepted: false, revision: instance.revision, reason: 'closed' }
        }
        if (!this.readSnapshot(instance)) {
          return { accepted: false, revision: instance.revision, reason: 'view-failed' }
        }
        return { accepted: true, revision: instance.revision }
      } catch {
        this.cancelInstance(instance, 'failed')
        return { accepted: false, revision: instance.revision, reason: 'view-failed' }
      }
    })
    instance.actionQueue = dispatch.then(() => undefined, () => undefined)
    return dispatch
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.renderer = undefined
    this.nativeRuntime = undefined
    this.closeAll('cancelled')
  }

  private resolveAllowed(handle: SemanticView<unknown>): ResolvedSemanticView<unknown> | undefined {
    if (this.disposed || !this.nativeRuntime) return undefined
    try {
      const resolved = resolveSemanticView(handle)
      if (resolved.extensionRuntime !== this.nativeRuntime || !this.registry.resolve(resolved)) return undefined
      return resolved
    } catch {
      return undefined
    }
  }

  private createInstance(
    resolved: ResolvedSemanticView<unknown>,
    adapter: SemanticViewAdapter,
    widget?: { readonly widgetKey: string; readonly widgetHandle: SemanticView<unknown> },
  ): Promise<unknown> {
    const instance: SemanticViewInstance = {
      id: randomUUID(),
      scope: this.scope,
      resolved,
      adapter,
      definition: eraseDefinition(resolved),
      abort: new AbortController(),
      ...(widget ? { widgetKey: widget.widgetKey, widgetHandle: widget.widgetHandle } : {}),
      actionQueue: Promise.resolve(),
      revision: 0,
      settled: false,
      completionPublished: false,
      ...(this.renderer ? { rendererCaller: this.renderer.caller } : {}),
    }
    const completion = new Promise<unknown>((resolve) => { instance.resolve = resolve })
    this.instances.set(instance.id, instance)
    if (widget) this.widgetInstances.set(widget.widgetKey, { handle: widget.widgetHandle, instanceId: instance.id })

    try {
      instance.controller = instance.definition.create({
        done: (value) => this.settle(instance, value, 'completed'),
        signal: instance.abort.signal,
      })
      if (instance.settled) {
        this.disposeController(instance)
        return completion
      }
      if (!this.readSnapshot(instance)) {
        this.cancelInstance(instance, 'failed')
        return completion
      }
      instance.unsubscribe = instance.controller.subscribe(() => {
        if (!instance.settled) this.readSnapshot(instance)
      })
      if (!instance.settled && this.renderer) this.publishSnapshot(instance)
      return completion
    } catch {
      this.cancelInstance(instance, 'failed')
      return completion
    }
  }

  private readSnapshot(instance: SemanticViewInstance): boolean {
    if (instance.settled || !instance.controller) return false
    let state: JSONValue | undefined
    try {
      const nativeState = instance.controller.snapshot()
      if (!instance.definition.validateState(nativeState) || !instance.adapter.validateState(nativeState)) {
        this.cancelInstance(instance, 'failed')
        return false
      }
      state = cloneBoundedJson(nativeState)
    } catch {
      this.cancelInstance(instance, 'failed')
      return false
    }
    if (state === undefined) {
      this.cancelInstance(instance, 'failed')
      return false
    }
    const stateJson = JSON.stringify(state)
    if (stateJson !== instance.stateJson) {
      instance.state = state
      instance.stateJson = stateJson
      instance.revision += 1
      this.publishSnapshot(instance)
    }
    return true
  }

  private publishSnapshot(instance: SemanticViewInstance): void {
    if (instance.settled || !instance.state || !instance.rendererCaller) return
    try {
      this.publish({
        type: 'semantic-view',
        instanceId: instance.id,
        viewId: instance.definition.id,
        version: instance.definition.version,
        revision: instance.revision,
        state: instance.state,
      })
    } catch {
      this.cancelInstance(instance, 'failed')
    }
  }

  private isCurrentInstance(
    instance: SemanticViewInstance | undefined,
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope | undefined,
  ): boolean {
    return !this.disposed
      && !!instance
      && !instance.settled
      && this.instances.get(instance.id) === instance
      && instance.resolved.extensionRuntime === this.nativeRuntime
      && sameScope(scope, this.scope)
      && sameScope(instance.scope, this.scope)
      && sameCaller(instance.rendererCaller, caller)
      && !!this.renderer
      && sameCaller(this.renderer.caller, caller)
  }

  private isAuthorizedAction(instance: SemanticViewInstance, action: JSONValue): boolean {
    if (!isActionRecord(action)
      || !instance.definition.actionIds.includes(action.type)
      || !instance.adapter.actionIds.includes(action.type)) return false
    try {
      return instance.adapter.authorizeAction(action)
        && instance.definition.validateAction(action)
    } catch {
      return false
    }
  }

  private settle(instance: SemanticViewInstance, value: unknown, reason: 'completed' | 'cancelled' | 'failed'): void {
    if (instance.settled) return
    instance.settled = true
    this.instances.delete(instance.id)
    if (instance.widgetKey) {
      const widget = this.widgetInstances.get(instance.widgetKey)
      if (widget?.instanceId === instance.id) this.widgetInstances.delete(instance.widgetKey)
    }
    instance.unsubscribe?.()
    instance.unsubscribe = undefined
    this.publishClosed(instance, reason)
    instance.resolve?.(reason === 'completed' ? value : instance.definition.cancelValue)
    instance.resolve = undefined
    if (!instance.abort.signal.aborted) instance.abort.abort()
    this.disposeController(instance)
  }

  private cancelInstance(instance: SemanticViewInstance | undefined, reason: 'cancelled' | 'failed'): void {
    if (!instance) return
    this.settle(instance, instance.definition.cancelValue, reason)
  }

  private publishClosed(instance: SemanticViewInstance, reason: 'completed' | 'cancelled' | 'failed'): void {
    if (instance.completionPublished || !instance.rendererCaller) return
    instance.completionPublished = true
    try {
      this.publish({
        type: 'semantic-view-closed',
        instanceId: instance.id,
        revision: instance.revision,
        reason,
      })
    } catch {
      // A closing event is best-effort; teardown and native settlement must still complete.
    }
  }

  private disposeController(instance: SemanticViewInstance): void {
    try {
      instance.controller?.dispose?.()
    } catch {
      // Extension controller cleanup must not leak exceptions into IPC or lifecycle code.
    }
    instance.controller = undefined
  }

  private closeAll(reason: 'cancelled'): void {
    for (const instance of [...this.instances.values()]) this.cancelInstance(instance, reason)
    this.widgetInstances.clear()
  }
}
