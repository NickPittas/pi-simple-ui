import type { CapabilityDefinition } from './register.ts'
import { AppPreferencesStore, isAppPreferences, isPreferencesMutationResult, isPreferencesSnapshot } from '../config/app-preferences.ts'
import type {
  AppPreferencesSnapshot,
  EmptyPreferencesRequest,
  PreferencesMutationResult,
  ResetPreferencesRequest,
  UpdatePreferencesRequest,
} from '../../shared/app-preferences.ts'
import { hasExactKeys, isPlainRecord } from '../../shared/ipc-contracts.ts'

export type AppPreferenceCapabilityDefinition =
  | CapabilityDefinition<EmptyPreferencesRequest, AppPreferencesSnapshot>
  | CapabilityDefinition<UpdatePreferencesRequest, PreferencesMutationResult>
  | CapabilityDefinition<ResetPreferencesRequest, PreferencesMutationResult>

function isEmptyRequest(value: unknown): value is EmptyPreferencesRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

function isUpdateRequest(value: unknown): value is UpdatePreferencesRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['expectedRevision', 'preferences'])
    && Number.isSafeInteger(value.expectedRevision)
    && (value.expectedRevision as number) >= 0
    && isAppPreferences(value.preferences)
}

function isResetRequest(value: unknown): value is ResetPreferencesRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['expectedRevision'])
    && Number.isSafeInteger(value.expectedRevision)
    && (value.expectedRevision as number) >= 0
}

/**
 * Return narrow, typed descriptors for the existing capability registry to compose
 * into its single registerIpcCapabilities() call. This function does not install
 * duplicate IPC handlers or create a second transport.
 */
export function registerAppPreferenceCapabilities(store: AppPreferencesStore): readonly AppPreferenceCapabilityDefinition[] {
  const read: CapabilityDefinition<EmptyPreferencesRequest, AppPreferencesSnapshot> = {
    id: 'app.preferences.read',
    scope: 'window',
    validateRequest: isEmptyRequest,
    validateResponse: isPreferencesSnapshot,
    handle: () => store.read(),
  }
  const update: CapabilityDefinition<UpdatePreferencesRequest, PreferencesMutationResult> = {
    id: 'app.preferences.update',
    scope: 'window',
    validateRequest: isUpdateRequest,
    validateResponse: isPreferencesMutationResult,
    handle: (_context, request) => store.update(request.expectedRevision, request.preferences),
  }
  const reset: CapabilityDefinition<ResetPreferencesRequest, PreferencesMutationResult> = {
    id: 'app.preferences.reset',
    scope: 'window',
    validateRequest: isResetRequest,
    validateResponse: isPreferencesMutationResult,
    handle: (_context, request) => store.reset(request.expectedRevision),
  }
  const cancel: CapabilityDefinition<EmptyPreferencesRequest, AppPreferencesSnapshot> = {
    id: 'app.preferences.cancel',
    scope: 'window',
    validateRequest: isEmptyRequest,
    validateResponse: isPreferencesSnapshot,
    handle: () => store.cancel(),
  }
  return [read, update, reset, cancel]
}
