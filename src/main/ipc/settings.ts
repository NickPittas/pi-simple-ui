import type { AuthorizedIpcCaller, CapabilityDefinition, EventDefinition } from './register.ts'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import {
  isEmptySettingsRequest,
  isSettingsEventPayload,
  isSettingsMutationResult,
  isSettingsReadRequest,
  isSettingsReadResponse,
  isSettingsResetRequest,
  isSettingsSchemaResponse,
  isSettingsUpdateRequest,
  type SettingsCapabilityContracts,
  type SettingsEventPayload,
  type SettingsMutationResult,
  type SettingsReadRequest,
  type SettingsReadResponse,
  type SettingsResetRequest,
  type SettingsSchemaResponse,
  type SettingsUpdateRequest,
} from '../../shared/settings.ts'
import type { NativeSettingsService } from '../config/native-settings-service.ts'

export const SETTINGS_IPC = Object.freeze({
  schema: 'settings.schema',
  read: 'settings.read',
  update: 'settings.update',
  reset: 'settings.reset',
  events: 'settings.events',
})

export type SettingsCapabilityDefinition = {
  [K in keyof SettingsCapabilityContracts]: CapabilityDefinition<
    SettingsCapabilityContracts[K]['request'],
    SettingsCapabilityContracts[K]['response']
  >
}[keyof SettingsCapabilityContracts]

export interface SettingsCapabilityRouter {
  isCallerAuthorized(caller: AuthorizedIpcCaller): boolean
  /** Resolve must bind both authenticated caller identity and exact current runtime scope. */
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): NativeSettingsService | undefined
}

function requireService(
  router: SettingsCapabilityRouter,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): NativeSettingsService {
  if (!scope) throw new Error('A runtime scope is required for settings operations.')
  const service = router.resolve(caller, scope)
  if (!service) throw new Error('No settings service is bound to this caller and runtime scope.')
  return service
}

/** Runtime-scoped settings operations. No renderer-supplied path or provider can select storage. */
export function registerSettingsCapabilities(router: SettingsCapabilityRouter): readonly SettingsCapabilityDefinition[] {
  const schema: CapabilityDefinition<Record<string, never>, SettingsSchemaResponse> = {
    id: SETTINGS_IPC.schema,
    scope: 'runtime',
    validateRequest: isEmptySettingsRequest,
    validateResponse: isSettingsSchemaResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }) => ({ descriptors: requireService(router, caller, scope).schema() }),
  }
  const read: CapabilityDefinition<SettingsReadRequest, SettingsReadResponse> = {
    id: SETTINGS_IPC.read,
    scope: 'runtime',
    validateRequest: isSettingsReadRequest,
    validateResponse: isSettingsReadResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireService(router, caller, scope).read(request.scope),
  }
  const update: CapabilityDefinition<SettingsUpdateRequest, SettingsMutationResult> = {
    id: SETTINGS_IPC.update,
    scope: 'runtime',
    validateRequest: isSettingsUpdateRequest,
    validateResponse: isSettingsMutationResult,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireService(router, caller, scope).update(request),
  }
  const reset: CapabilityDefinition<SettingsResetRequest, SettingsMutationResult> = {
    id: SETTINGS_IPC.reset,
    scope: 'runtime',
    validateRequest: isSettingsResetRequest,
    validateResponse: isSettingsMutationResult,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireService(router, caller, scope).reset(request),
  }
  return [schema, read, update, reset]
}

export function registerSettingsEvents(router: SettingsCapabilityRouter): readonly EventDefinition<SettingsEventPayload>[] {
  const events: EventDefinition<SettingsEventPayload> = {
    id: SETTINGS_IPC.events,
    scope: 'runtime',
    validatePayload: isSettingsEventPayload,
    authorize: (caller) => router.isCallerAuthorized(caller),
    subscribe: (context, publish) => requireService(router, context.caller, context.scope).subscribe(publish),
  }
  return [events]
}

export type SettingsIpcRequest = SettingsReadRequest | SettingsUpdateRequest | SettingsResetRequest
