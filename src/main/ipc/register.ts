import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  IPC_CHANNELS,
  IPC_LIMITS,
  hasExactKeys,
  ipcFailure,
  isCapabilityId,
  isPlainRecord,
  isRuntimeScope,
  isSubscriptionId,
  type EventEnvelope,
  type InvokeEnvelope,
  type RuntimeScope,
  type SubscribeEnvelope,
  type UnsubscribeEnvelope,
  type IpcResult,
} from '../../shared/ipc-contracts.ts'

export interface AuthorizedIpcCaller {
  readonly windowId: number
  readonly webContentsId: number
  readonly frameUrl: string
}

export interface CapabilityDefinition<Request = unknown, Response = unknown> {
  readonly id: string
  readonly scope: 'window' | 'runtime'
  readonly validateRequest: (value: unknown) => value is Request
  readonly validateResponse: (value: unknown) => value is Response
  readonly authorize?: (caller: AuthorizedIpcCaller, request: Request) => boolean
  readonly handle: (context: CapabilityContext, request: Request) => Response | Promise<Response>
}

export interface EventDefinition<Payload = unknown> {
  readonly id: string
  readonly scope: 'window' | 'runtime'
  readonly validatePayload: (value: unknown) => value is Payload
  readonly authorize?: (caller: AuthorizedIpcCaller) => boolean
  readonly subscribe: (
    context: EventContext,
    publish: (payload: Payload) => void,
  ) => (() => void) | void
}

export interface CapabilityContext {
  readonly caller: AuthorizedIpcCaller
  readonly scope?: RuntimeScope
}

export interface EventContext extends CapabilityContext {
  readonly subscriptionId: string
}

type IpcMainLike = Pick<IpcMain, 'handle' | 'removeHandler'>
type InvokeHandler = (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>

interface ActiveSubscription {
  readonly caller: AuthorizedIpcCaller
  readonly definition: RegisteredEvent
  readonly subscriptionId: string
  readonly scope?: RuntimeScope
  stop?: () => void
}

interface RegisteredCapability {
  readonly id: string
  readonly scope: 'window' | 'runtime'
  readonly validateRequest: (value: unknown) => boolean
  readonly validateResponse: (value: unknown) => boolean
  readonly authorize?: (caller: AuthorizedIpcCaller, request: unknown) => boolean
  readonly handle: (context: CapabilityContext, request: unknown) => unknown | Promise<unknown>
}

interface RegisteredEvent {
  readonly id: string
  readonly scope: 'window' | 'runtime'
  readonly validatePayload: (value: unknown) => boolean
  readonly authorize?: (caller: AuthorizedIpcCaller) => boolean
  readonly subscribe: (context: EventContext, publish: (payload: unknown) => void) => (() => void) | void
}

interface RegistrationOptions {
  readonly ipcMain: IpcMainLike
  readonly capabilities?: readonly CapabilityDefinition<any, any>[]
  readonly events?: readonly EventDefinition<any>[]
  readonly authorizeCaller: (event: IpcMainInvokeEvent) => AuthorizedIpcCaller | null
  readonly isCallerActive: (caller: AuthorizedIpcCaller) => boolean
  readonly authorizeRuntimeScope?: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => boolean
  readonly maxSubscriptionsPerWindow?: number
}

const ERROR_MESSAGES = Object.freeze({
  invalid: 'The IPC request is invalid.',
  unauthorized: 'The IPC caller is not authorized.',
  unavailable: 'The requested capability is unavailable.',
  stale: 'The runtime scope is no longer current.',
  limit: 'The IPC subscription limit was reached.',
  internal: 'The host could not complete the request.',
})

function isInvokeEnvelope(value: unknown): value is InvokeEnvelope {
  if (!isPlainRecord(value)) return false
  const keys = Object.hasOwn(value, 'scope')
    ? ['capability', 'payload', 'scope']
    : ['capability', 'payload']
  return hasExactKeys(value, keys)
    && isCapabilityId(value.capability)
    && (!Object.hasOwn(value, 'scope') || isRuntimeScope(value.scope))
}

function isSubscribeEnvelope(value: unknown): value is SubscribeEnvelope {
  if (!isPlainRecord(value)) return false
  const keys = Object.hasOwn(value, 'scope')
    ? ['event', 'subscriptionId', 'scope']
    : ['event', 'subscriptionId']
  return hasExactKeys(value, keys)
    && isCapabilityId(value.event)
    && isSubscriptionId(value.subscriptionId)
    && (!Object.hasOwn(value, 'scope') || isRuntimeScope(value.scope))
}

function isUnsubscribeEnvelope(value: unknown): value is UnsubscribeEnvelope {
  return isPlainRecord(value)
    && hasExactKeys(value, ['subscriptionId'])
    && isSubscriptionId(value.subscriptionId)
}

function scopeMatches(
  scopeMode: 'window' | 'runtime',
  scope: RuntimeScope | undefined,
  caller: AuthorizedIpcCaller,
  authorizeRuntimeScope: RegistrationOptions['authorizeRuntimeScope'],
): boolean {
  if (scopeMode === 'window') return scope === undefined
  try {
    return scope !== undefined && authorizeRuntimeScope?.(caller, scope) === true
  } catch {
    return false
  }
}

function safeStop(subscription: ActiveSubscription): void {
  try {
    subscription.stop?.()
  } catch {
    // Teardown is best-effort and must not leak host exception details to the renderer.
  }
}

export function registerIpcCapabilities(options: RegistrationOptions): {
  dispose: () => void
  disposeCaller: (webContentsId: number) => void
} {
  const capabilityMap = new Map<string, RegisteredCapability>()
  const eventMap = new Map<string, RegisteredEvent>()
  const subscriptions = new Map<string, ActiveSubscription>()
  const requestedSubscriptionLimit = options.maxSubscriptionsPerWindow ?? IPC_LIMITS.activeSubscriptionsPerWindow
  const maxSubscriptions = Number.isSafeInteger(requestedSubscriptionLimit) && requestedSubscriptionLimit >= 0
    ? Math.min(requestedSubscriptionLimit, IPC_LIMITS.activeSubscriptionsPerWindow)
    : IPC_LIMITS.activeSubscriptionsPerWindow
  const countByWindow = new Map<number, number>()
  let disposed = false

  for (const capability of options.capabilities ?? []) {
    if (!isCapabilityId(capability.id) || capabilityMap.has(capability.id)) {
      throw new TypeError('IPC capability registrations must have unique valid IDs.')
    }
    capabilityMap.set(capability.id, {
      id: capability.id,
      scope: capability.scope,
      validateRequest: capability.validateRequest,
      validateResponse: capability.validateResponse,
      authorize: capability.authorize
        ? (caller, request) => capability.authorize!(caller, request as never)
        : undefined,
      handle: (context, request) => capability.handle(context, request as never),
    })
  }
  for (const event of options.events ?? []) {
    if (!isCapabilityId(event.id) || eventMap.has(event.id)) {
      throw new TypeError('IPC event registrations must have unique valid IDs.')
    }
    eventMap.set(event.id, {
      id: event.id,
      scope: event.scope,
      validatePayload: event.validatePayload,
      authorize: event.authorize,
      subscribe: (context, publish) => event.subscribe(context, (payload) => publish(payload)),
    })
  }

  const removeSubscription = (key: string): void => {
    const active = subscriptions.get(key)
    if (!active) return
    subscriptions.delete(key)
    countByWindow.set(active.caller.windowId, Math.max(0, (countByWindow.get(active.caller.windowId) ?? 1) - 1))
    safeStop(active)
  }

  const authorize = (event: IpcMainInvokeEvent): AuthorizedIpcCaller | null => {
    if (disposed) return null
    try {
      const caller = options.authorizeCaller(event)
      return caller && options.isCallerActive(caller) ? caller : null
    } catch {
      return null
    }
  }

  const validateRuntimeScope = (caller: AuthorizedIpcCaller, scope: RuntimeScope | undefined): boolean => {
    return scope !== undefined && options.authorizeRuntimeScope?.(caller, scope) === true
  }

  const invoke: InvokeHandler = async (event, request) => {
    if (!isInvokeEnvelope(request)) return ipcFailure('INVALID_REQUEST', ERROR_MESSAGES.invalid)
    const caller = authorize(event)
    if (!caller) return ipcFailure('UNAUTHORIZED', ERROR_MESSAGES.unauthorized)
    const definition = capabilityMap.get(request.capability)
    if (!definition) return ipcFailure('UNAVAILABLE', ERROR_MESSAGES.unavailable)
    if (!scopeMatches(definition.scope, request.scope, caller, options.authorizeRuntimeScope)) {
      return ipcFailure('STALE_SCOPE', ERROR_MESSAGES.stale)
    }

    try {
      if (!definition.validateRequest(request.payload)) {
        return ipcFailure('INVALID_REQUEST', ERROR_MESSAGES.invalid)
      }
      if (definition.authorize?.(caller, request.payload) === false) {
        return ipcFailure('UNAUTHORIZED', ERROR_MESSAGES.unauthorized)
      }
      const value = await definition.handle({ caller, scope: request.scope }, request.payload)

      // Handlers can resolve after navigation or a runtime switch. Revalidate the same
      // authenticated caller and scope immediately before exposing any result.
      const responseCaller = authorize(event)
      if (!responseCaller
        || responseCaller.windowId !== caller.windowId
        || responseCaller.webContentsId !== caller.webContentsId
        || responseCaller.frameUrl !== caller.frameUrl) {
        return ipcFailure('UNAUTHORIZED', ERROR_MESSAGES.unauthorized)
      }
      if (!scopeMatches(definition.scope, request.scope, responseCaller, options.authorizeRuntimeScope)) {
        return ipcFailure('STALE_SCOPE', ERROR_MESSAGES.stale)
      }
      if (definition.authorize?.(responseCaller, request.payload) === false) {
        return ipcFailure('UNAUTHORIZED', ERROR_MESSAGES.unauthorized)
      }
      if (!definition.validateResponse(value)) return ipcFailure('INTERNAL', ERROR_MESSAGES.internal)
      return { ok: true, value }
    } catch {
      return ipcFailure('INTERNAL', ERROR_MESSAGES.internal)
    }
  }

  const subscribe: InvokeHandler = async (event, request) => {
    if (!isSubscribeEnvelope(request)) return ipcFailure('INVALID_REQUEST', ERROR_MESSAGES.invalid)
    const caller = authorize(event)
    if (!caller) return ipcFailure('UNAUTHORIZED', ERROR_MESSAGES.unauthorized)
    const definition = eventMap.get(request.event)
    if (!definition) return ipcFailure('UNAVAILABLE', ERROR_MESSAGES.unavailable)
    if (!scopeMatches(definition.scope, request.scope, caller, options.authorizeRuntimeScope)) {
      return ipcFailure('STALE_SCOPE', ERROR_MESSAGES.stale)
    }
    try {
      if (definition.authorize?.(caller) === false) return ipcFailure('UNAUTHORIZED', ERROR_MESSAGES.unauthorized)
    } catch {
      return ipcFailure('INTERNAL', ERROR_MESSAGES.internal)
    }

    const key = `${caller.webContentsId}:${request.subscriptionId}`
    if (subscriptions.has(key)) return ipcFailure('INVALID_REQUEST', ERROR_MESSAGES.invalid)
    if ((countByWindow.get(caller.windowId) ?? 0) >= maxSubscriptions) {
      return ipcFailure('LIMIT_EXCEEDED', ERROR_MESSAGES.limit)
    }

    const active: ActiveSubscription = {
      caller,
      definition,
      subscriptionId: request.subscriptionId,
      scope: request.scope,
    }
    subscriptions.set(key, active)
    countByWindow.set(caller.windowId, (countByWindow.get(caller.windowId) ?? 0) + 1)

    try {
      const stop = definition.subscribe(
        { caller, scope: request.scope, subscriptionId: request.subscriptionId },
        (payload) => {
          try {
            if (subscriptions.get(key) !== active || !options.isCallerActive(caller)) return
            if (active.scope && !validateRuntimeScope(caller, active.scope)) return
            if (!definition.validatePayload(payload)) return
            const message: EventEnvelope = {
              event: definition.id,
              subscriptionId: request.subscriptionId,
              ...(active.scope ? { scope: active.scope } : {}),
              payload,
            }
            event.sender.send(IPC_CHANNELS.event, message)
          } catch {
            // Event delivery is isolated from host callbacks and never sends thrown details.
          }
        },
      )
      active.stop = typeof stop === 'function' ? stop : undefined
      return { ok: true, value: null }
    } catch {
      removeSubscription(key)
      return ipcFailure('INTERNAL', ERROR_MESSAGES.internal)
    }
  }

  const unsubscribe: InvokeHandler = async (event, request) => {
    if (!isUnsubscribeEnvelope(request)) return ipcFailure('INVALID_REQUEST', ERROR_MESSAGES.invalid)
    const caller = authorize(event)
    if (!caller) return ipcFailure('UNAUTHORIZED', ERROR_MESSAGES.unauthorized)
    const key = `${caller.webContentsId}:${request.subscriptionId}`
    const active = subscriptions.get(key)
    if (active && active.caller.windowId !== caller.windowId) {
      return ipcFailure('UNAUTHORIZED', ERROR_MESSAGES.unauthorized)
    }
    removeSubscription(key)
    return { ok: true, value: null }
  }

  options.ipcMain.handle(IPC_CHANNELS.invoke, invoke)
  options.ipcMain.handle(IPC_CHANNELS.subscribe, subscribe)
  options.ipcMain.handle(IPC_CHANNELS.unsubscribe, unsubscribe)

  return {
    disposeCaller(webContentsId) {
      for (const [key, subscription] of subscriptions) {
        if (subscription.caller.webContentsId === webContentsId) removeSubscription(key)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      options.ipcMain.removeHandler(IPC_CHANNELS.invoke)
      options.ipcMain.removeHandler(IPC_CHANNELS.subscribe)
      options.ipcMain.removeHandler(IPC_CHANNELS.unsubscribe)
      for (const key of subscriptions.keys()) removeSubscription(key)
    },
  }
}
