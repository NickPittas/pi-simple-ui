import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'
import type { ModelAuthMethod } from './models.ts'

export type ProviderAuthLoginMethod = 'api_key' | 'oauth'

export interface ProviderSummary {
  readonly provider: string
  readonly label: string
  readonly hasCredential: boolean
  readonly authMethod: ModelAuthMethod
  readonly configured: boolean
  readonly available: boolean
  readonly loginMethods: readonly ProviderAuthLoginMethod[]
  readonly modelIds: readonly string[]
}

/** One auth.json provider key; it is a slot identifier, not a verified human identity. */
export interface ProviderAccountSummary {
  readonly providerId: string
  readonly label: string
  readonly authMethod: ModelAuthMethod
  readonly configured: boolean
  readonly available: boolean
  readonly selected: boolean
  readonly modelIds: readonly string[]
}

export interface ProviderAccountsSnapshot {
  readonly providers: readonly ProviderSummary[]
  readonly accounts: readonly ProviderAccountSummary[]
}

export interface ProviderAuthState {
  readonly provider: string
  readonly hasCredential: boolean
  readonly authMethod: ModelAuthMethod
  readonly configured: boolean
  readonly available: boolean
}

export type ProviderAuthOperationStatus =
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'unsupported'
  | 'not-found'

export interface ProviderAuthOperationResult {
  readonly status: ProviderAuthOperationStatus
  readonly state: ProviderAuthState | null
}

export interface ProviderAccountSwitchRequest {
  readonly provider: string
  readonly modelId: string
}

export interface ProviderAccountSwitchResult {
  readonly outcome: 'selected' | 'unavailable' | 'not-found'
  readonly provider: string
  readonly modelId: string
}

export interface ProviderAuthLoginRequest {
  readonly journeyId: string
  readonly provider: string
  readonly method: ProviderAuthLoginMethod
}

export interface ProviderAuthProviderRequest {
  readonly provider: string
}

export interface ProviderAuthJourneyRequest {
  readonly journeyId: string
}

export interface ProviderAuthPromptReplyRequest {
  readonly journeyId: string
  readonly promptId: string
  /** Transient write-only prompt input; never included in a response or event. */
  readonly value: string
}

/** Credential-blind view of one native `models.json` provider overlay. */
export interface ProviderModelConfigEntry {
  readonly providerId: string
  /** Schema-defined secret or write-only fields are redacted and listed in secretPaths. */
  readonly definition: Readonly<Record<string, unknown>>
  readonly apiKeyConfigured: boolean
  readonly baseUrlConfigured: boolean
  readonly secretPaths: readonly string[]
}

export type ProviderModelConfigDiagnosticCode =
  | 'native-config-load-failed'
  | 'native-config-parse-failed'
  | 'native-config-schema-invalid'
  | 'native-provider-invalid'
  | 'native-provider-id-invalid'
  | 'native-availability-refresh-failed'

export interface ProviderModelConfigDiagnostic {
  readonly code: ProviderModelConfigDiagnosticCode
  readonly path?: readonly string[]
  /** Safe summary only: native parser details can contain user-configured values. */
  readonly message: string
}

export interface ProviderModelConfigState {
  readonly scope: 'user'
  readonly path: 'models.json'
  readonly revision: string
  readonly exists: boolean
  readonly providers: readonly ProviderModelConfigEntry[]
  readonly diagnostics: readonly ProviderModelConfigDiagnostic[]
}

export interface ProviderModelConfigReadRequest {
  readonly providerId: string
}

export interface ProviderModelConfigCreateRequest {
  readonly expectedRevision: string
  readonly providerId: string
  /** Native models.json provider fields, including optional write-only `apiKey`. */
  readonly definition: Readonly<Record<string, unknown>>
}

export interface ProviderModelConfigUpdateRequest {
  readonly expectedRevision: string
  readonly providerId: string
  /** Partial native provider fields. Omitted fields, including secrets, are preserved. */
  readonly patch: Readonly<Record<string, unknown>>
  /** Native provider-relative property paths to remove from the definition. */
  readonly remove?: readonly (readonly string[])[]
  /** Remove custom model definitions by stable native `id`; omitted IDs are preserved. */
  readonly removeModelIds?: readonly string[]
}

export interface ProviderModelConfigDeleteRequest {
  readonly expectedRevision: string
  readonly providerId: string
}

export interface ProviderModelConfigRefreshRequest {
  /** Explicitly permits provider credential commands to run during this refresh. */
  readonly acknowledgeCredentialCommands: true
}

export interface ProviderModelConfigReadResponse {
  readonly outcome: 'found' | 'not-found'
  readonly state: ProviderModelConfigState
  readonly entry: ProviderModelConfigEntry | null
}

export interface ProviderModelConfigMutationResponse {
  readonly outcome: 'saved' | 'conflict' | 'not-found' | 'invalid' | 'busy' | 'unauthorized'
  readonly state: ProviderModelConfigState
  readonly diagnostics: readonly ProviderModelConfigDiagnostic[]
}

export interface ProviderModelConfigRefreshResponse {
  readonly outcome: 'refreshed' | 'failed' | 'unauthorized'
  readonly state: ProviderModelConfigState
}

export interface ProviderAuthAcknowledge {
  readonly accepted: boolean
}

export interface EmptyProvidersRequest extends Record<string, never> {}

export type ProviderAuthPrompt =
  | { readonly type: 'text' | 'secret' | 'manual_code'; readonly message: string; readonly placeholder?: string }
  | {
      readonly type: 'select'
      readonly message: string
      readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[]
    }

export type ProviderAuthNotice =
  | { readonly type: 'info'; readonly message: string; readonly links?: readonly { readonly url: string; readonly label?: string }[] }
  | { readonly type: 'auth_url'; readonly url: string; readonly instructions?: string }
  | {
      readonly type: 'device_code'
      readonly userCode: string
      readonly verificationUri: string
      readonly intervalSeconds?: number
      readonly expiresInSeconds?: number
    }
  | { readonly type: 'progress'; readonly message: string }

export type ProviderAuthEvent =
  | { readonly type: 'prompt'; readonly journeyId: string; readonly provider: string; readonly promptId: string; readonly prompt: ProviderAuthPrompt }
  | { readonly type: 'notice'; readonly journeyId: string; readonly provider: string; readonly notice: ProviderAuthNotice }
  | {
      readonly type: 'journey'
      readonly journeyId: string
      readonly provider: string
      readonly status: 'started' | 'completed' | 'cancelled' | 'failed'
    }

export interface ProvidersCapabilityContracts {
  'providers.accounts-read': {
    readonly request: EmptyProvidersRequest
    readonly response: ProviderAccountsSnapshot
  }
  'providers.accounts-switch': {
    readonly request: ProviderAccountSwitchRequest
    readonly response: ProviderAccountSwitchResult
  }
  'providers.auth-login': {
    readonly request: ProviderAuthLoginRequest
    readonly response: ProviderAuthOperationResult
  }
  'providers.auth-logout': {
    readonly request: ProviderAuthProviderRequest
    readonly response: ProviderAuthOperationResult
  }
  'providers.auth-refresh': {
    readonly request: ProviderAuthProviderRequest
    readonly response: ProviderAuthOperationResult
  }
  'providers.auth-cancel': {
    readonly request: ProviderAuthJourneyRequest
    readonly response: ProviderAuthAcknowledge
  }
  'providers.auth-respond': {
    readonly request: ProviderAuthPromptReplyRequest
    readonly response: ProviderAuthAcknowledge
  }
  'providers.model-config.list': {
    readonly request: EmptyProvidersRequest
    readonly response: ProviderModelConfigState
  }
  'providers.model-config.read': {
    readonly request: ProviderModelConfigReadRequest
    readonly response: ProviderModelConfigReadResponse
  }
  'providers.model-config.create': {
    readonly request: ProviderModelConfigCreateRequest
    readonly response: ProviderModelConfigMutationResponse
  }
  'providers.model-config.update': {
    readonly request: ProviderModelConfigUpdateRequest
    readonly response: ProviderModelConfigMutationResponse
  }
  'providers.model-config.delete': {
    readonly request: ProviderModelConfigDeleteRequest
    readonly response: ProviderModelConfigMutationResponse
  }
  'providers.model-config.refresh': {
    readonly request: ProviderModelConfigRefreshRequest
    readonly response: ProviderModelConfigRefreshResponse
  }
}

export interface ProvidersEventContracts {
  'providers.auth-event': { readonly payload: ProviderAuthEvent }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends ProvidersCapabilityContracts {}
  interface IpcEventContracts extends ProvidersEventContracts {}
}

const MODEL_CONFIG_MAX_BYTES = 1024 * 1024
const MODEL_CONFIG_REDACTED = '[REDACTED]'

function isModelConfigProviderId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value)
}

function isModelConfigRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return value.length <= MODEL_CONFIG_MAX_BYTES && !value.includes('\0')
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((entry) => isJsonValue(entry, depth + 1))
  if (!isPlainRecord(value) || Object.keys(value).length > 10_000) return false
  return Object.entries(value).every(([key, child]) => key.length > 0 && key.length <= 1024
    && key !== '__proto__' && key !== 'prototype' && key !== 'constructor'
    && isJsonValue(child, depth + 1))
}

function isNativeProviderDefinition(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value) || !isJsonValue(value)) return false
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= MODEL_CONFIG_MAX_BYTES
  } catch {
    return false
  }
}

function containsRedactedValue(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(MODEL_CONFIG_REDACTED)
  if (Array.isArray(value)) return value.some(containsRedactedValue)
  return isPlainRecord(value) && Object.values(value).some(containsRedactedValue)
}

function isProviderModelConfigDiagnostic(value: unknown): value is ProviderModelConfigDiagnostic {
  if (!isPlainRecord(value)) return false
  const keys = Object.hasOwn(value, 'path') ? ['code', 'path', 'message'] : ['code', 'message']
  return hasExactKeys(value, keys)
    && [
      'native-config-load-failed', 'native-config-parse-failed', 'native-config-schema-invalid',
      'native-provider-invalid', 'native-provider-id-invalid', 'native-availability-refresh-failed',
    ].includes(value.code as string)
    && (!Object.hasOwn(value, 'path') || Array.isArray(value.path) && value.path.length <= 32
      && value.path.every((part) => typeof part === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(part)))
    && typeof value.message === 'string' && value.message.length <= 1024
}

function isProviderModelConfigEntry(value: unknown): value is ProviderModelConfigEntry {
  return isPlainRecord(value)
    && hasExactKeys(value, ['providerId', 'definition', 'apiKeyConfigured', 'baseUrlConfigured', 'secretPaths'])
    && isModelConfigProviderId(value.providerId)
    && isNativeProviderDefinition(value.definition)
    && typeof value.apiKeyConfigured === 'boolean'
    && typeof value.baseUrlConfigured === 'boolean'
    && Array.isArray(value.secretPaths)
    && value.secretPaths.length <= 10_000
    && value.secretPaths.every((path) => typeof path === 'string' && path.length <= 4096)
}

export function isProviderModelConfigState(value: unknown): value is ProviderModelConfigState {
  return isPlainRecord(value)
    && hasExactKeys(value, ['scope', 'path', 'revision', 'exists', 'providers', 'diagnostics'])
    && value.scope === 'user' && value.path === 'models.json'
    && isModelConfigRevision(value.revision) && typeof value.exists === 'boolean'
    && Array.isArray(value.providers) && value.providers.length <= 10_000
    && value.providers.every(isProviderModelConfigEntry)
    && Array.isArray(value.diagnostics) && value.diagnostics.every(isProviderModelConfigDiagnostic)
}

export function isProviderModelConfigReadRequest(value: unknown): value is ProviderModelConfigReadRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['providerId'])
    && isModelConfigProviderId(value.providerId)
}

export function isProviderModelConfigCreateRequest(value: unknown): value is ProviderModelConfigCreateRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['expectedRevision', 'providerId', 'definition'])
    && isModelConfigRevision(value.expectedRevision)
    && isModelConfigProviderId(value.providerId)
    && isNativeProviderDefinition(value.definition)
    && !containsRedactedValue(value.definition)
}

export function isProviderModelConfigUpdateRequest(value: unknown): value is ProviderModelConfigUpdateRequest {
  if (!isPlainRecord(value)) return false
  const patch = value.patch
  const removeModelIds = value.removeModelIds
  const keys = ['expectedRevision', 'providerId', 'patch']
  if (Object.hasOwn(value, 'remove')) keys.push('remove')
  if (Object.hasOwn(value, 'removeModelIds')) keys.push('removeModelIds')
  if (!hasExactKeys(value, keys)
    || !isModelConfigRevision(value.expectedRevision)
    || !isModelConfigProviderId(value.providerId)
    || !isNativeProviderDefinition(patch)
    || containsRedactedValue(patch)) return false
  if (Object.hasOwn(value, 'remove') && (!Array.isArray(value.remove)
    || value.remove.length > 10_000
    || !value.remove.every((path) => Array.isArray(path) && path.length > 0 && path.length <= 16
      && path.every((part) => typeof part === 'string' && part.length > 0 && part.length <= 1024
        && part !== '__proto__' && part !== 'prototype' && part !== 'constructor')))) return false
  if (Object.hasOwn(value, 'removeModelIds')) {
    if (!Array.isArray(removeModelIds)
      || removeModelIds.length > 10_000
      || !removeModelIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 1024 && !id.includes('\0'))
      || new Set(removeModelIds).size !== removeModelIds.length) return false
    if (Array.isArray(patch.models) && patch.models.some((model) => isPlainRecord(model)
      && typeof model.id === 'string' && removeModelIds.includes(model.id))) return false
  }
  return true
}

export function isProviderModelConfigDeleteRequest(value: unknown): value is ProviderModelConfigDeleteRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['expectedRevision', 'providerId'])
    && isModelConfigRevision(value.expectedRevision)
    && isModelConfigProviderId(value.providerId)
}

export function isProviderModelConfigRefreshRequest(value: unknown): value is ProviderModelConfigRefreshRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['acknowledgeCredentialCommands'])
    && value.acknowledgeCredentialCommands === true
}

export function isProviderModelConfigReadResponse(value: unknown): value is ProviderModelConfigReadResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome', 'state', 'entry'])
    && (value.outcome === 'found' || value.outcome === 'not-found')
    && isProviderModelConfigState(value.state)
    && (value.entry === null || isProviderModelConfigEntry(value.entry))
    && ((value.outcome === 'found') === (value.entry !== null))
}

export function isProviderModelConfigMutationResponse(value: unknown): value is ProviderModelConfigMutationResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome', 'state', 'diagnostics'])
    && ['saved', 'conflict', 'not-found', 'invalid', 'busy', 'unauthorized'].includes(value.outcome as string)
    && isProviderModelConfigState(value.state)
    && Array.isArray(value.diagnostics) && value.diagnostics.every(isProviderModelConfigDiagnostic)
}

export function isProviderModelConfigRefreshResponse(value: unknown): value is ProviderModelConfigRefreshResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome', 'state'])
    && ['refreshed', 'failed', 'unauthorized'].includes(value.outcome as string)
    && isProviderModelConfigState(value.state)
}
