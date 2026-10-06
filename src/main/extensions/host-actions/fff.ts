import type { RuntimeScope } from '../../../shared/ipc-contracts.ts'
import {
  HOST_ACTIONS,
  isEmptyHostActionRequest,
  isFffHealthReadResponse,
  isFffModeReadResponse,
  isFffRescanResponse,
  type EmptyHostActionRequest,
  type FffHealthReadResponse,
  type FffMode,
  type FffModeReadResponse,
  type FffRescanResponse,
} from '../../../shared/host-actions.ts'
import type { AuthorizedIpcCaller, CapabilityDefinition } from '../../ipc/register.ts'

export interface FffRescanResult {
  readonly started: boolean
  readonly alreadyScanning: boolean
}

/** Extension-private finder access must be implemented by a caller/runtime-bound parent accessor. */
export interface FffRuntimeBridge {
  readMode(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<FffMode> | FffMode
  readHealth(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<FffHealthReadResponse> | FffHealthReadResponse
  rescan(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<FffRescanResult> | FffRescanResult
}

export interface FffRequiresRuntimeBridgeAccessor {
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): FffRuntimeBridge | null
}

export interface FffHostActionOptions {
  readonly bridge: FffRequiresRuntimeBridgeAccessor
  readonly authorizeRuntimeCaller: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => boolean
}

const RESCAN_COOLDOWN_MS = 30_000

function runtimeBridge(
  options: FffHostActionOptions,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): { readonly scope: RuntimeScope; readonly bridge: FffRuntimeBridge } {
  if (!scope || !options.authorizeRuntimeCaller(caller, scope)) throw new Error('A current authorized runtime scope is required for FFF actions.')
  const bridge = options.bridge.resolve(caller, scope)
  if (!bridge) throw new Error('FFF runtime bridge is unavailable.')
  return { scope, bridge }
}

function callerScopeKey(caller: AuthorizedIpcCaller, scope: RuntimeScope): string {
  return `${caller.windowId}:${caller.webContentsId}:${scope.ownerId}:${scope.generation}`
}

/** Namespaced status actions plus a bounded manual rescan trigger; no slash command is intercepted. */
export function registerFffHostActions(options: FffHostActionOptions): readonly CapabilityDefinition<any, any>[] {
  const lastRescanAt = new Map<string, number>()

  const modeRead: CapabilityDefinition<EmptyHostActionRequest, FffModeReadResponse> = {
    id: HOST_ACTIONS.fff.modeRead,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isFffModeReadResponse,
    handle: async ({ caller, scope }) => {
      const resolved = runtimeBridge(options, caller, scope)
      const mode = await resolved.bridge.readMode(caller, resolved.scope)
      return { mode: ['tools-and-ui', 'tools-only', 'override'].includes(mode) ? mode : 'tools-and-ui' }
    },
  }

  const healthRead: CapabilityDefinition<EmptyHostActionRequest, FffHealthReadResponse> = {
    id: HOST_ACTIONS.fff.healthRead,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isFffHealthReadResponse,
    handle: async ({ caller, scope }) => {
      const resolved = runtimeBridge(options, caller, scope)
      const health = await resolved.bridge.readHealth(caller, resolved.scope)
      // Rebuild only the health fields; a native path/error detail is never forwarded.
      return {
        available: health.available === true,
        mode: ['tools-and-ui', 'tools-only', 'override'].includes(health.mode) ? health.mode : 'tools-and-ui',
        scanning: health.scanning === true,
        ...(typeof health.version === 'string' ? { version: health.version.slice(0, 80) } : {}),
        ...(Number.isSafeInteger(health.scannedFiles) && (health.scannedFiles ?? -1) >= 0 ? { scannedFiles: health.scannedFiles } : {}),
        ...(Number.isSafeInteger(health.indexedFiles) && (health.indexedFiles ?? -1) >= 0 ? { indexedFiles: health.indexedFiles } : {}),
        ...(typeof health.gitRepositoryFound === 'boolean' ? { gitRepositoryFound: health.gitRepositoryFound } : {}),
        ...(typeof health.frecencyActive === 'boolean' ? { frecencyActive: health.frecencyActive } : {}),
        ...(typeof health.queryTrackerActive === 'boolean' ? { queryTrackerActive: health.queryTrackerActive } : {}),
      }
    },
  }

  const rescan: CapabilityDefinition<EmptyHostActionRequest, FffRescanResponse> = {
    id: HOST_ACTIONS.fff.rescan,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isFffRescanResponse,
    handle: async ({ caller, scope }) => {
      const resolved = runtimeBridge(options, caller, scope)
      const key = callerScopeKey(caller, resolved.scope)
      const remaining = Math.max(0, (lastRescanAt.get(key) ?? 0) + RESCAN_COOLDOWN_MS - Date.now())
      if (remaining > 0) return { status: 'cooldown', cooldownMs: remaining }

      try {
        const health = await resolved.bridge.readHealth(caller, resolved.scope)
        if (!health.available) return { status: 'unavailable', cooldownMs: 0 }
        if (health.scanning) return { status: 'already-scanning', cooldownMs: 0 }
        const result = await resolved.bridge.rescan(caller, resolved.scope)
        if (result.alreadyScanning) return { status: 'already-scanning', cooldownMs: 0 }
        if (!result.started) return { status: 'failed', cooldownMs: 0 }
        lastRescanAt.set(key, Date.now())
        return { status: 'started', cooldownMs: RESCAN_COOLDOWN_MS }
      } catch {
        return { status: 'failed', cooldownMs: 0 }
      }
    },
  }

  return [modeRead, healthRead, rescan]
}
