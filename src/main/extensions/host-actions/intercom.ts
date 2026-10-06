import type { RuntimeScope } from '../../../shared/ipc-contracts.ts'
import {
  HOST_ACTIONS,
  HOST_ACTION_LIMITS,
  isEmptyHostActionRequest,
  isIntercomAliasPersistRequest,
  isIntercomAliasPersistResponse,
  isIntercomEditorInsertRequest,
  isIntercomEditorInsertResponse,
  isIntercomEditorInsertedPayload,
  isIntercomOverlayStateResponse,
  isIntercomSessionsListResponse,
  isIntercomTransportStatusResponse,
  type EmptyHostActionRequest,
  type IntercomAliasPersistRequest,
  type IntercomAliasPersistResponse,
  type IntercomEditorInsertedPayload,
  type IntercomEditorInsertRequest,
  type IntercomEditorInsertResponse,
  type IntercomOverlayStateResponse,
  type IntercomSessionSummary,
  type IntercomSessionsListResponse,
  type IntercomTransportStatusResponse,
} from '../../../shared/host-actions.ts'
import type { AuthorizedIpcCaller, CapabilityDefinition, EventDefinition } from '../../ipc/register.ts'

export interface IntercomLocalSession {
  readonly id: string
  readonly name?: string
  readonly cwd?: string
  readonly state?: 'active' | 'idle' | 'unknown'
}

export interface IntercomLocalTransportStatus {
  readonly state: 'connected' | 'connecting' | 'disconnected' | 'unknown'
  readonly localBrokerAvailable: boolean
}

/**
 * Implemented by the parent Pi runtime from public extension accessors only.
 * listLocalSessions must not enumerate remote machines or expose broker metadata.
 */
export interface IntercomRuntimeBridge {
  listLocalSessions(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<readonly IntercomLocalSession[]> | readonly IntercomLocalSession[]
  readOverlayState(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<IntercomOverlayStateResponse> | IntercomOverlayStateResponse
  /** Derive the native intercom-id snippet from active local session identity without connecting or sending. */
  createContactSnippet(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<string | null> | string | null
  /** Parent implementation must call Pi's public setSessionName API so normal session persistence runs. */
  persistSessionAlias(caller: AuthorizedIpcCaller, scope: RuntimeScope, alias: string): Promise<boolean> | boolean
  readLocalTransportStatus(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<IntercomLocalTransportStatus> | IntercomLocalTransportStatus
}

/** Requires-runtime-bridge accessor: its resolver must bind both opaque runtime and authorized IPC caller. */
export interface IntercomRequiresRuntimeBridgeAccessor {
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): IntercomRuntimeBridge | null
}

interface InsertionSubscriber {
  readonly caller: AuthorizedIpcCaller
  readonly scope: RuntimeScope
  readonly publish: (payload: IntercomEditorInsertedPayload) => void
}

function sameCaller(left: AuthorizedIpcCaller, right: AuthorizedIpcCaller): boolean {
  return left.windowId === right.windowId
    && left.webContentsId === right.webContentsId
    && left.frameUrl === right.frameUrl
}

function sameScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return left.ownerId === right.ownerId && left.generation === right.generation
}

function requireBridge(
  accessor: IntercomRequiresRuntimeBridgeAccessor,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): { readonly scope: RuntimeScope; readonly bridge: IntercomRuntimeBridge } {
  if (!scope) throw new Error('A runtime scope is required for Intercom actions.')
  const bridge = accessor.resolve(caller, scope)
  if (!bridge) throw new Error('Intercom runtime bridge is unavailable.')
  return { scope, bridge }
}

function safeSession(value: IntercomLocalSession): IntercomSessionSummary | null {
  if (typeof value.id !== 'string' || !value.id.trim()) return null
  const id = value.id.slice(0, HOST_ACTION_LIMITS.sessionIdCharacters)
  const name = typeof value.name === 'string' ? value.name.slice(0, HOST_ACTION_LIMITS.sessionNameCharacters) : undefined
  const cwd = typeof value.cwd === 'string' ? value.cwd.slice(0, HOST_ACTION_LIMITS.cwdCharacters) : undefined
  const state = value.state === 'active' || value.state === 'idle' || value.state === 'unknown' ? value.state : undefined
  return {
    id,
    ...(name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
    ...(state ? { state } : {}),
  }
}

/** Runtime-bound Intercom operations. Composer insertion is an event, never terminal-editor emulation. */
export function registerIntercomHostActions(accessor: IntercomRequiresRuntimeBridgeAccessor): {
  readonly capabilities: readonly CapabilityDefinition<any, any>[]
  readonly events: readonly EventDefinition<any>[]
} {
  const subscribers = new Set<InsertionSubscriber>()

  const sessionsList: CapabilityDefinition<EmptyHostActionRequest, IntercomSessionsListResponse> = {
    id: HOST_ACTIONS.intercom.sessionsList,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isIntercomSessionsListResponse,
    handle: async ({ caller, scope }) => {
      const { scope: runtimeScope, bridge } = requireBridge(accessor, caller, scope)
      const sessions = await bridge.listLocalSessions(caller, runtimeScope)
      return { sessions: sessions.slice(0, HOST_ACTION_LIMITS.sessionCount).flatMap((item) => {
        const safe = safeSession(item)
        return safe ? [safe] : []
      }) }
    },
  }

  const overlayState: CapabilityDefinition<EmptyHostActionRequest, IntercomOverlayStateResponse> = {
    id: HOST_ACTIONS.intercom.overlayState,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isIntercomOverlayStateResponse,
    handle: async ({ caller, scope }) => {
      const { scope: runtimeScope, bridge } = requireBridge(accessor, caller, scope)
      const state = await bridge.readOverlayState(caller, runtimeScope)
      const selectedSessionId = typeof state.selectedSessionId === 'string'
        ? state.selectedSessionId.slice(0, HOST_ACTION_LIMITS.sessionIdCharacters)
        : undefined
      return { open: state.open === true, ...(selectedSessionId ? { selectedSessionId } : {}) }
    },
  }

  const editorInsert: CapabilityDefinition<IntercomEditorInsertRequest, IntercomEditorInsertResponse> = {
    id: HOST_ACTIONS.intercom.editorInsert,
    scope: 'runtime',
    validateRequest: isIntercomEditorInsertRequest,
    validateResponse: isIntercomEditorInsertResponse,
    handle: async ({ caller, scope }, request) => {
      const { scope: runtimeScope, bridge } = requireBridge(accessor, caller, scope)
      const text = await bridge.createContactSnippet(caller, runtimeScope)
      if (!text || text.length > HOST_ACTION_LIMITS.editorTextCharacters) return { inserted: false }
      const payload: IntercomEditorInsertedPayload = { text, insertion: request.insertion }
      if (!isIntercomEditorInsertedPayload(payload)) return { inserted: false }
      let delivered = false
      for (const subscriber of subscribers) {
        if (!sameCaller(subscriber.caller, caller) || !sameScope(subscriber.scope, runtimeScope)) continue
        try {
          subscriber.publish(payload)
          delivered = true
        } catch {
          // A renderer closing during event delivery must not fail the host action.
        }
      }
      return { inserted: delivered }
    },
  }

  const aliasPersist: CapabilityDefinition<IntercomAliasPersistRequest, IntercomAliasPersistResponse> = {
    id: HOST_ACTIONS.intercom.aliasPersist,
    scope: 'runtime',
    validateRequest: isIntercomAliasPersistRequest,
    validateResponse: isIntercomAliasPersistResponse,
    handle: async ({ caller, scope }, request) => {
      const { scope: runtimeScope, bridge } = requireBridge(accessor, caller, scope)
      const alias = request.alias.trim()
      return { saved: await bridge.persistSessionAlias(caller, runtimeScope, alias) }
    },
  }

  const transportStatus: CapabilityDefinition<EmptyHostActionRequest, IntercomTransportStatusResponse> = {
    id: HOST_ACTIONS.intercom.transportStatus,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isIntercomTransportStatusResponse,
    handle: async ({ caller, scope }) => {
      const { scope: runtimeScope, bridge } = requireBridge(accessor, caller, scope)
      const status = await bridge.readLocalTransportStatus(caller, runtimeScope)
      // Deliberately reconstruct a closed DTO; no token, endpoint, peer, or broker field can escape.
      return {
        state: ['connected', 'connecting', 'disconnected', 'unknown'].includes(status.state) ? status.state : 'unknown',
        localBrokerAvailable: status.localBrokerAvailable === true,
      }
    },
  }

  const editorInserted: EventDefinition<IntercomEditorInsertedPayload> = {
    id: HOST_ACTIONS.intercom.editorInserted,
    scope: 'runtime',
    validatePayload: isIntercomEditorInsertedPayload,
    subscribe: (context, publish) => {
      const scope = context.scope
      if (!scope || !accessor.resolve(context.caller, scope)) return
      const subscriber: InsertionSubscriber = { caller: context.caller, scope, publish }
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    },
  }

  return {
    capabilities: [sessionsList, overlayState, editorInsert, aliasPersist, transportStatus],
    events: [editorInserted],
  }
}
