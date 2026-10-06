import type { CapabilityDefinition, AuthorizedIpcCaller, EventDefinition } from './register.ts'
import {
  hasExactKeys,
  isPlainRecord,
  isRuntimeScope,
  type RuntimeScope,
} from '../../shared/ipc-contracts.ts'
import {
  type EmptyProvidersRequest,
  type ProviderAccountSummary,
  type ProviderAccountSwitchRequest,
  type ProviderAccountSwitchResult,
  type ProviderAccountsSnapshot,
  type ProviderAuthAcknowledge,
  type ProviderAuthEvent,
  type ProviderAuthLoginMethod,
  type ProviderAuthLoginRequest,
  type ProviderAuthNotice,
  type ProviderAuthOperationResult,
  type ProviderAuthOperationStatus,
  type ProviderAuthPrompt,
  type ProviderAuthPromptReplyRequest,
  type ProviderAuthProviderRequest,
  type ProviderAuthState,
  type ProviderModelConfigCreateRequest,
  type ProviderModelConfigDeleteRequest,
  type ProviderModelConfigMutationResponse,
  type ProviderModelConfigRefreshRequest,
  type ProviderModelConfigRefreshResponse,
  type ProviderModelConfigReadRequest,
  type ProviderModelConfigReadResponse,
  type ProviderModelConfigState,
  type ProviderModelConfigUpdateRequest,
  type ProviderSummary,
  type ProvidersCapabilityContracts,
  isProviderModelConfigCreateRequest,
  isProviderModelConfigDeleteRequest,
  isProviderModelConfigMutationResponse,
  isProviderModelConfigRefreshRequest,
  isProviderModelConfigRefreshResponse,
  isProviderModelConfigReadRequest,
  isProviderModelConfigReadResponse,
  isProviderModelConfigState,
  isProviderModelConfigUpdateRequest,
} from '../../shared/providers.ts'
import type { AccountService } from '../models/account-service.ts'
import type { ProviderModelConfigService } from '../models/provider-model-config.ts'

export const PROVIDERS_IPC = Object.freeze({
  accountsRead: 'providers.accounts-read',
  accountsSwitch: 'providers.accounts-switch',
  authLogin: 'providers.auth-login',
  authLogout: 'providers.auth-logout',
  authRefresh: 'providers.auth-refresh',
  authCancel: 'providers.auth-cancel',
  authRespond: 'providers.auth-respond',
  modelConfigList: 'providers.model-config.list',
  modelConfigRead: 'providers.model-config.read',
  modelConfigCreate: 'providers.model-config.create',
  modelConfigUpdate: 'providers.model-config.update',
  modelConfigDelete: 'providers.model-config.delete',
  modelConfigRefresh: 'providers.model-config.refresh',
  authEvent: 'providers.auth-event',
})

export type ProviderCapabilityDefinition = {
  [K in keyof ProvidersCapabilityContracts]: CapabilityDefinition<
    ProvidersCapabilityContracts[K]['request'],
    ProvidersCapabilityContracts[K]['response']
  >
}[keyof ProvidersCapabilityContracts]

export interface ProviderCapabilityRouter {
  isCallerAuthorized(caller: AuthorizedIpcCaller): boolean
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): AccountService | undefined
  resolveModelConfig(caller: AuthorizedIpcCaller, scope: RuntimeScope): ProviderModelConfigService | undefined
}

const AUTH_METHODS: readonly ProviderAuthLoginMethod[] = ['api_key', 'oauth']
const OPERATION_STATUSES: readonly ProviderAuthOperationStatus[] = ['completed', 'cancelled', 'failed', 'unsupported', 'not-found']
const MAX_PROVIDER_ID_LENGTH = 1024
const MAX_PROMPT_VALUE_LENGTH = 65_536

function validString(value: unknown, maxLength = MAX_PROVIDER_ID_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function isEmptyRequest(value: unknown): value is EmptyProvidersRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

function isProviderRequest(value: unknown): value is ProviderAuthProviderRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['provider'])
    && validString(value.provider)
}

function isAccountSwitchRequest(value: unknown): value is ProviderAccountSwitchRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['provider', 'modelId'])
    && validString(value.provider)
    && validString(value.modelId)
}

function isJourneyId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function isLoginRequest(value: unknown): value is ProviderAuthLoginRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['journeyId', 'provider', 'method'])
    && isJourneyId(value.journeyId)
    && validString(value.provider)
    && AUTH_METHODS.includes(value.method as ProviderAuthLoginMethod)
}

function isJourneyRequest(value: unknown): value is { readonly journeyId: string } {
  return isPlainRecord(value)
    && hasExactKeys(value, ['journeyId'])
    && isJourneyId(value.journeyId)
}

function isPromptReplyRequest(value: unknown): value is ProviderAuthPromptReplyRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['journeyId', 'promptId', 'value'])
    && isJourneyId(value.journeyId)
    && isJourneyId(value.promptId)
    && typeof value.value === 'string'
    && value.value.length <= MAX_PROMPT_VALUE_LENGTH
    && !value.value.includes('\0')
}

function isAuthMethod(value: unknown): value is ProviderAuthState['authMethod'] {
  return value === 'api_key' || value === 'oauth' || value === 'none'
}

function isProviderSummary(value: unknown): value is ProviderSummary {
  return isPlainRecord(value)
    && hasExactKeys(value, ['provider', 'label', 'hasCredential', 'authMethod', 'configured', 'available', 'loginMethods', 'modelIds'])
    && validString(value.provider)
    && typeof value.label === 'string'
    && typeof value.hasCredential === 'boolean'
    && isAuthMethod(value.authMethod)
    && typeof value.configured === 'boolean'
    && typeof value.available === 'boolean'
    && Array.isArray(value.loginMethods)
    && value.loginMethods.every((method) => AUTH_METHODS.includes(method as ProviderAuthLoginMethod))
    && Array.isArray(value.modelIds)
    && value.modelIds.every((modelId) => validString(modelId))
}

function isProviderAccount(value: unknown): value is ProviderAccountSummary {
  return isPlainRecord(value)
    && hasExactKeys(value, ['providerId', 'label', 'authMethod', 'configured', 'available', 'selected', 'modelIds'])
    && validString(value.providerId)
    && typeof value.label === 'string'
    && isAuthMethod(value.authMethod)
    && typeof value.configured === 'boolean'
    && typeof value.available === 'boolean'
    && typeof value.selected === 'boolean'
    && Array.isArray(value.modelIds)
    && value.modelIds.every((modelId) => validString(modelId))
}

function isAccountsSnapshot(value: unknown): value is ProviderAccountsSnapshot {
  return isPlainRecord(value)
    && hasExactKeys(value, ['providers', 'accounts'])
    && Array.isArray(value.providers)
    && value.providers.every(isProviderSummary)
    && Array.isArray(value.accounts)
    && value.accounts.every(isProviderAccount)
}

function isAccountSwitchResult(value: unknown): value is ProviderAccountSwitchResult {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome', 'provider', 'modelId'])
    && (value.outcome === 'selected' || value.outcome === 'unavailable' || value.outcome === 'not-found')
    && validString(value.provider)
    && validString(value.modelId)
}

function isAuthState(value: unknown): value is ProviderAuthState {
  return isPlainRecord(value)
    && hasExactKeys(value, ['provider', 'hasCredential', 'authMethod', 'configured', 'available'])
    && validString(value.provider)
    && typeof value.hasCredential === 'boolean'
    && isAuthMethod(value.authMethod)
    && typeof value.configured === 'boolean'
    && typeof value.available === 'boolean'
}

function isAuthOperationResult(value: unknown): value is ProviderAuthOperationResult {
  return isPlainRecord(value)
    && hasExactKeys(value, ['status', 'state'])
    && OPERATION_STATUSES.includes(value.status as ProviderAuthOperationStatus)
    && (value.state === null || isAuthState(value.state))
}

function isAcknowledge(value: unknown): value is ProviderAuthAcknowledge {
  return isPlainRecord(value)
    && hasExactKeys(value, ['accepted'])
    && typeof value.accepted === 'boolean'
}

function isPrompt(value: unknown): value is ProviderAuthPrompt {
  if (!isPlainRecord(value) || typeof value.type !== 'string' || typeof value.message !== 'string') return false
  if (value.type === 'select') {
    return hasExactKeys(value, ['type', 'message', 'options'])
      && Array.isArray(value.options)
      && value.options.length <= 100
      && value.options.every((option) => isPlainRecord(option)
        && hasExactKeys(option, Object.hasOwn(option, 'description') ? ['id', 'label', 'description'] : ['id', 'label'])
        && validString(option.id)
        && typeof option.label === 'string'
        && (!Object.hasOwn(option, 'description') || typeof option.description === 'string'))
  }
  const keys = Object.hasOwn(value, 'placeholder') ? ['type', 'message', 'placeholder'] : ['type', 'message']
  return (value.type === 'text' || value.type === 'secret' || value.type === 'manual_code')
    && hasExactKeys(value, keys)
    && (!Object.hasOwn(value, 'placeholder') || typeof value.placeholder === 'string')
}

function isNotice(value: unknown): value is ProviderAuthNotice {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'auth_url') {
    return hasExactKeys(value, Object.hasOwn(value, 'instructions') ? ['type', 'url', 'instructions'] : ['type', 'url'])
      && typeof value.url === 'string'
      && (!Object.hasOwn(value, 'instructions') || typeof value.instructions === 'string')
  }
  if (value.type === 'device_code') {
    const keys = ['type', 'userCode', 'verificationUri']
    if (Object.hasOwn(value, 'intervalSeconds')) keys.push('intervalSeconds')
    if (Object.hasOwn(value, 'expiresInSeconds')) keys.push('expiresInSeconds')
    return hasExactKeys(value, keys)
      && typeof value.userCode === 'string'
      && typeof value.verificationUri === 'string'
      && (!Object.hasOwn(value, 'intervalSeconds') || typeof value.intervalSeconds === 'number')
      && (!Object.hasOwn(value, 'expiresInSeconds') || typeof value.expiresInSeconds === 'number')
  }
  if (value.type === 'info') {
    return hasExactKeys(value, Object.hasOwn(value, 'links') ? ['type', 'message', 'links'] : ['type', 'message'])
      && typeof value.message === 'string'
      && (!Object.hasOwn(value, 'links') || Array.isArray(value.links) && value.links.every((link) => isPlainRecord(link)
        && hasExactKeys(link, Object.hasOwn(link, 'label') ? ['url', 'label'] : ['url'])
        && typeof link.url === 'string'
        && (!Object.hasOwn(link, 'label') || typeof link.label === 'string')))
  }
  return value.type === 'progress'
    && hasExactKeys(value, ['type', 'message'])
    && typeof value.message === 'string'
}

function isAuthEvent(value: unknown): value is ProviderAuthEvent {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'prompt') {
    return hasExactKeys(value, ['type', 'journeyId', 'provider', 'promptId', 'prompt'])
      && isJourneyId(value.journeyId)
      && validString(value.provider)
      && isJourneyId(value.promptId)
      && isPrompt(value.prompt)
  }
  if (value.type === 'notice') {
    return hasExactKeys(value, ['type', 'journeyId', 'provider', 'notice'])
      && isJourneyId(value.journeyId)
      && validString(value.provider)
      && isNotice(value.notice)
  }
  return value.type === 'journey'
    && hasExactKeys(value, ['type', 'journeyId', 'provider', 'status'])
    && isJourneyId(value.journeyId)
    && validString(value.provider)
    && ['started', 'completed', 'cancelled', 'failed'].includes(value.status as string)
}

function requireAccountService(
  router: ProviderCapabilityRouter,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): AccountService {
  if (!scope || !isRuntimeScope(scope)) throw new Error('A valid runtime scope is required for provider operations.')
  const service = router.resolve(caller, scope)
  if (!service) throw new Error('No provider account service is bound to this caller and runtime scope.')
  return service
}

function requireModelConfigService(
  router: ProviderCapabilityRouter,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): ProviderModelConfigService {
  if (!scope || !isRuntimeScope(scope)) throw new Error('A valid runtime scope is required for provider model-config operations.')
  const service = router.resolveModelConfig(caller, scope)
  if (!service) throw new Error('No native provider model-config service is bound to this caller and runtime scope.')
  return service
}

/** Build caller-bound runtime capabilities; secret prompt values are accepted only as write input. */
export function registerProviderCapabilities(router: ProviderCapabilityRouter): readonly ProviderCapabilityDefinition[] {
  const accountsRead: CapabilityDefinition<EmptyProvidersRequest, ProviderAccountsSnapshot> = {
    id: PROVIDERS_IPC.accountsRead,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isAccountsSnapshot,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }) => requireAccountService(router, caller, scope).read(),
  }
  const accountsSwitch: CapabilityDefinition<ProviderAccountSwitchRequest, ProviderAccountSwitchResult> = {
    id: PROVIDERS_IPC.accountsSwitch,
    scope: 'runtime',
    validateRequest: isAccountSwitchRequest,
    validateResponse: isAccountSwitchResult,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireAccountService(router, caller, scope)
      .switchAccount(request.provider, request.modelId),
  }
  const login: CapabilityDefinition<ProviderAuthLoginRequest, ProviderAuthOperationResult> = {
    id: PROVIDERS_IPC.authLogin,
    scope: 'runtime',
    validateRequest: isLoginRequest,
    validateResponse: isAuthOperationResult,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireAccountService(router, caller, scope)
      .login(caller, scope!, request.journeyId, request.provider, request.method),
  }
  const logout: CapabilityDefinition<ProviderAuthProviderRequest, ProviderAuthOperationResult> = {
    id: PROVIDERS_IPC.authLogout,
    scope: 'runtime',
    validateRequest: isProviderRequest,
    validateResponse: isAuthOperationResult,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireAccountService(router, caller, scope).logout(request.provider),
  }
  const refresh: CapabilityDefinition<ProviderAuthProviderRequest, ProviderAuthOperationResult> = {
    id: PROVIDERS_IPC.authRefresh,
    scope: 'runtime',
    validateRequest: isProviderRequest,
    validateResponse: isAuthOperationResult,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireAccountService(router, caller, scope).refresh(request.provider),
  }
  const cancel: CapabilityDefinition<{ readonly journeyId: string }, ProviderAuthAcknowledge> = {
    id: PROVIDERS_IPC.authCancel,
    scope: 'runtime',
    validateRequest: isJourneyRequest,
    validateResponse: isAcknowledge,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => ({
      accepted: requireAccountService(router, caller, scope).cancel(caller, scope!, request.journeyId),
    }),
  }
  const respond: CapabilityDefinition<ProviderAuthPromptReplyRequest, ProviderAuthAcknowledge> = {
    id: PROVIDERS_IPC.authRespond,
    scope: 'runtime',
    validateRequest: isPromptReplyRequest,
    validateResponse: isAcknowledge,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => ({
      accepted: requireAccountService(router, caller, scope).respond(
        caller,
        scope!,
        request.journeyId,
        request.promptId,
        request.value,
      ),
    }),
  }
  const modelConfigList: CapabilityDefinition<EmptyProvidersRequest, ProviderModelConfigState> = {
    id: PROVIDERS_IPC.modelConfigList,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isProviderModelConfigState,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }) => requireModelConfigService(router, caller, scope).list(),
  }
  const modelConfigRead: CapabilityDefinition<ProviderModelConfigReadRequest, ProviderModelConfigReadResponse> = {
    id: PROVIDERS_IPC.modelConfigRead,
    scope: 'runtime',
    validateRequest: isProviderModelConfigReadRequest,
    validateResponse: isProviderModelConfigReadResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireModelConfigService(router, caller, scope).read(request),
  }
  const modelConfigCreate: CapabilityDefinition<ProviderModelConfigCreateRequest, ProviderModelConfigMutationResponse> = {
    id: PROVIDERS_IPC.modelConfigCreate,
    scope: 'runtime',
    validateRequest: isProviderModelConfigCreateRequest,
    validateResponse: isProviderModelConfigMutationResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireModelConfigService(router, caller, scope)
      .create(request, () => router.isCallerAuthorized(caller)),
  }
  const modelConfigUpdate: CapabilityDefinition<ProviderModelConfigUpdateRequest, ProviderModelConfigMutationResponse> = {
    id: PROVIDERS_IPC.modelConfigUpdate,
    scope: 'runtime',
    validateRequest: isProviderModelConfigUpdateRequest,
    validateResponse: isProviderModelConfigMutationResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireModelConfigService(router, caller, scope)
      .update(request, () => router.isCallerAuthorized(caller)),
  }
  const modelConfigDelete: CapabilityDefinition<ProviderModelConfigDeleteRequest, ProviderModelConfigMutationResponse> = {
    id: PROVIDERS_IPC.modelConfigDelete,
    scope: 'runtime',
    validateRequest: isProviderModelConfigDeleteRequest,
    validateResponse: isProviderModelConfigMutationResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireModelConfigService(router, caller, scope)
      .delete(request, () => router.isCallerAuthorized(caller)),
  }
  const modelConfigRefresh: CapabilityDefinition<ProviderModelConfigRefreshRequest, ProviderModelConfigRefreshResponse> = {
    id: PROVIDERS_IPC.modelConfigRefresh,
    scope: 'runtime',
    validateRequest: isProviderModelConfigRefreshRequest,
    validateResponse: isProviderModelConfigRefreshResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireModelConfigService(router, caller, scope)
      .refreshAvailability(request, () => router.isCallerAuthorized(caller)),
  }
  return [accountsRead, accountsSwitch, login, logout, refresh, cancel, respond,
    modelConfigList, modelConfigRead, modelConfigCreate, modelConfigUpdate, modelConfigDelete, modelConfigRefresh]
}

export function registerProviderEvents(router: ProviderCapabilityRouter): readonly EventDefinition<ProviderAuthEvent>[] {
  const authEvent: EventDefinition<ProviderAuthEvent> = {
    id: PROVIDERS_IPC.authEvent,
    scope: 'runtime',
    validatePayload: isAuthEvent,
    authorize: (caller) => router.isCallerAuthorized(caller),
    subscribe: (context, publish) => requireAccountService(router, context.caller, context.scope)
      .subscribe(context.caller, context.scope!, publish),
  }
  return [authEvent]
}
