/** Fixed transport channels. Renderer code never receives ipcRenderer or a channel selector. */
export const IPC_CHANNELS = Object.freeze({
  invoke: 'piDesktop:invoke',
  subscribe: 'piDesktop:subscribe',
  unsubscribe: 'piDesktop:unsubscribe',
  event: 'piDesktop:event',
})

export const IPC_ERROR_CODES = [
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'UNAVAILABLE',
  'STALE_SCOPE',
  'LIMIT_EXCEEDED',
  'INTERNAL',
] as const

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number]

export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: IpcErrorCode; readonly message: string } }

/** Runtime identities are opaque and their generation must match the current host state. */
export interface RuntimeScope {
  readonly ownerId: string
  readonly generation: number
}

/** Intentionally empty until a real host operation/event is registered and implemented. */
export interface IpcCapabilityContracts {}
export interface IpcEventContracts {}

export type CapabilityId = Extract<keyof IpcCapabilityContracts, string>
export type EventId = Extract<keyof IpcEventContracts, string>
export type CapabilityRequest<K extends CapabilityId> = IpcCapabilityContracts[K] extends {
  readonly request: infer Request
} ? Request : never
export type CapabilityResponse<K extends CapabilityId> = IpcCapabilityContracts[K] extends {
  readonly response: infer Response
} ? Response : never
export type EventPayload<K extends EventId> = IpcEventContracts[K] extends {
  readonly payload: infer Payload
} ? Payload : never

export interface InvokeEnvelope {
  readonly capability: string
  readonly payload: unknown
  readonly scope?: RuntimeScope
}

export interface SubscribeEnvelope {
  readonly event: string
  readonly subscriptionId: string
  readonly scope?: RuntimeScope
}

export interface UnsubscribeEnvelope {
  readonly subscriptionId: string
}

export interface EventEnvelope {
  readonly event: string
  readonly subscriptionId: string
  readonly scope?: RuntimeScope
  readonly payload: unknown
}

export interface DesktopBridge {
  readonly appInfo: Readonly<{ name: string; version: string }>
  invoke<K extends CapabilityId>(
    capability: K,
    payload: CapabilityRequest<K>,
    scope?: RuntimeScope,
  ): Promise<IpcResult<CapabilityResponse<K>>>
  subscribe<K extends EventId>(
    event: K,
    scope: RuntimeScope | undefined,
    listener: (payload: EventPayload<K>) => void,
  ): Promise<IpcResult<() => void>>
}

export const IPC_LIMITS = Object.freeze({
  capabilityIdLength: 64,
  subscriptionIdLength: 80,
  activeSubscriptionsPerWindow: 64,
  runtimeOwnerIdLength: 128,
})

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function isCapabilityId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= IPC_LIMITS.capabilityIdLength
    && /^[a-z][a-z0-9.-]*$/.test(value)
}

export function isSubscriptionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= IPC_LIMITS.subscriptionIdLength
    && /^[a-zA-Z0-9-]+$/.test(value)
}

export function isRuntimeScope(value: unknown): value is RuntimeScope {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['ownerId', 'generation'])) return false
  return typeof value.ownerId === 'string'
    && value.ownerId.length > 0
    && value.ownerId.length <= IPC_LIMITS.runtimeOwnerIdLength
    && /^[a-zA-Z0-9._:-]+$/.test(value.ownerId)
    && Number.isSafeInteger(value.generation)
    && (value.generation as number) >= 0
}

export function isMatchingEventEnvelope(
  value: unknown,
  expected: { readonly event: string; readonly subscriptionId: string; readonly scope?: RuntimeScope },
): value is EventEnvelope {
  if (!isPlainRecord(value)) return false
  const hasScope = Object.hasOwn(value, 'scope')
  const keys = hasScope
    ? ['event', 'subscriptionId', 'scope', 'payload']
    : ['event', 'subscriptionId', 'payload']
  if (!hasExactKeys(value, keys)
    || !isCapabilityId(value.event)
    || !isSubscriptionId(value.subscriptionId)
    || (hasScope && !isRuntimeScope(value.scope))) return false
  if (value.event !== expected.event || value.subscriptionId !== expected.subscriptionId) return false
  if (expected.scope === undefined) return !hasScope
  return hasScope
    && (value.scope as RuntimeScope).ownerId === expected.scope.ownerId
    && (value.scope as RuntimeScope).generation === expected.scope.generation
}

export function isIpcResult(value: unknown): value is IpcResult<unknown> {
  if (!isPlainRecord(value) || typeof value.ok !== 'boolean') return false
  if (value.ok) return hasExactKeys(value, ['ok', 'value'])
  if (!hasExactKeys(value, ['ok', 'error']) || !isPlainRecord(value.error)) return false
  return hasExactKeys(value.error, ['code', 'message'])
    && IPC_ERROR_CODES.includes(value.error.code as IpcErrorCode)
    && typeof value.error.message === 'string'
    && value.error.message.length <= 160
}

export function ipcFailure(code: IpcErrorCode, message: string): IpcResult<never> {
  return { ok: false, error: { code, message: message.slice(0, 160) } }
}
