import {
  HOST_ACTIONS,
  HOST_ACTION_CONSENT,
  type WebCachedResult,
  type WebCuratorStatusResponse,
  type WebGoogleAccountStatusResponse,
} from '../../shared/host-actions.ts'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'
import type { WebAccessRuntimeBridge } from './host-actions/web-access.ts'

/** Read-only accessors exported by the active app-local pi-web-access owner. */
export interface WebAccessNativeReadApi {
  readWebAccessCachedResults(limit: number): Promise<readonly WebCachedResult[]> | readonly WebCachedResult[]
  readWebAccessCuratorStatus(): Promise<WebCuratorStatusResponse> | WebCuratorStatusResponse
  readWebAccessGoogleAccountStatus(): Promise<WebGoogleAccountStatusResponse> | WebGoogleAccountStatusResponse
}

export type WebAccessNativeOwnerResolver = (
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope,
) => WebAccessNativeReadApi | null

export type WebAccessNativeStatusBridge = Pick<
  WebAccessRuntimeBridge,
  'readCachedResults' | 'readCuratorStatus' | 'readGoogleAccountStatus'
>

interface WebAccessNativeOwnerRegistry {
  readonly owners: Map<string, WebAccessNativeReadApi>
}

const WEB_ACCESS_NATIVE_OWNER_REGISTRY = Symbol.for('pi-simple-ui.web-access-native-owners')

function ownerRegistry(): WebAccessNativeOwnerRegistry {
  const current: unknown = Reflect.get(globalThis, WEB_ACCESS_NATIVE_OWNER_REGISTRY)
  if (current !== null && typeof current === 'object'
    && Reflect.get(current, 'owners') instanceof Map) {
    return current as WebAccessNativeOwnerRegistry
  }
  const created: WebAccessNativeOwnerRegistry = { owners: new Map() }
  Reflect.set(globalThis, WEB_ACCESS_NATIVE_OWNER_REGISTRY, created)
  return created
}

/** Store accessors exported by the exact app-local extension module instance in this Pi runtime. */
export function registerWebAccessNativeOwner(
  runtimeOwnerKey: string,
  owner: WebAccessNativeReadApi,
): () => void {
  if (!runtimeOwnerKey) throw new Error('A runtime owner key is required for web-access status.')
  const owners = ownerRegistry().owners
  owners.set(runtimeOwnerKey, owner)
  return () => {
    if (owners.get(runtimeOwnerKey) === owner) owners.delete(runtimeOwnerKey)
  }
}

/** Resolve only the module instance attached to the caller's currently authorized Pi runtime. */
export function resolveWebAccessNativeOwner(runtimeOwnerKey: string): WebAccessNativeReadApi | null {
  return ownerRegistry().owners.get(runtimeOwnerKey) ?? null
}

/** Remove a runtime binding during host teardown, including failed runtime startup. */
export function clearWebAccessNativeOwner(runtimeOwnerKey: string): void {
  ownerRegistry().owners.delete(runtimeOwnerKey)
}

/**
 * Bind existing native module read accessors to per-caller runtime resolution.
 * Construction is inert; the owner and account status are read only per request.
 */
export function bindWebAccessNativeStatusBridge(
  resolveOwner: WebAccessNativeOwnerResolver,
): WebAccessNativeStatusBridge {
  const currentOwner = (caller: AuthorizedIpcCaller, scope: RuntimeScope): WebAccessNativeReadApi => {
    const owner = resolveOwner(caller, scope)
    if (!owner) throw new Error('The active native web-access owner is unavailable.')
    return owner
  }

  return {
    readCachedResults: (caller, scope, limit) => currentOwner(caller, scope).readWebAccessCachedResults(limit),
    readCuratorStatus: (caller, scope) => currentOwner(caller, scope).readWebAccessCuratorStatus(),
    readGoogleAccountStatus: (caller, scope, consentLabel) => {
      const expected = HOST_ACTION_CONSENT[HOST_ACTIONS.webAccess.googleAccountStatus].consentLabel
      if (consentLabel !== expected) throw new Error('Google-account status requires explicit per-call consent.')
      return currentOwner(caller, scope).readWebAccessGoogleAccountStatus()
    },
  }
}
