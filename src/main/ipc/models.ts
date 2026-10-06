import type { CapabilityDefinition, AuthorizedIpcCaller } from './register.ts'
import {
  hasExactKeys,
  isPlainRecord,
  isRuntimeScope,
  type RuntimeScope,
} from '../../shared/ipc-contracts.ts'
import {
  type EmptyModelsRequest,
  type EnabledModelGroup,
  type EnabledModelsMutationResult,
  type EnabledModelsState,
  type ModelAuthMethod,
  type ModelInfo,
  type ModelProviderInfo,
  type ModelReference,
  type ModelThinkingLevel,
  type ModelsCapabilityContracts,
  type ModelsProvidersResponse,
  type ModelsSearchRequest,
  type ModelsSearchResponse,
  type RevisionedEnabledModelsUpdateRequest,
  type ScopedModelsState,
  type ScopedModelsUpdateRequest,
  type ThinkingState,
  type ThinkingUpdateRequest,
  type ModelSelectRequest,
} from '../../shared/models.ts'
import type { ModelService } from '../models/model-service.ts'
import type { ModelSettingsService } from '../models/model-settings.ts'

export const MODEL_IPC = Object.freeze({
  search: 'models.search',
  enabledRead: 'models.enabled.read',
  enabledUpdate: 'models.enabled.update',
  scopedRead: 'models.scoped.read',
  scopedUpdate: 'models.scoped.update',
  thinkingRead: 'models.thinking.read',
  thinkingUpdate: 'models.thinking.update',
  select: 'models.select',
  providers: 'models.providers',
})

export type ModelCapabilityDefinition = {
  [K in keyof ModelsCapabilityContracts]: CapabilityDefinition<
    ModelsCapabilityContracts[K]['request'],
    ModelsCapabilityContracts[K]['response']
  >
}[keyof ModelsCapabilityContracts]

export interface ModelCapabilityServices {
  readonly models: ModelService
  readonly settings: ModelSettingsService
}

/**
 * The parent supplies a caller-aware runtime lookup. `resolve` must match both the
 * authorized caller and exact runtime scope before returning services.
 */
export interface ModelCapabilityRouter {
  isCallerAuthorized(caller: AuthorizedIpcCaller): boolean
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): ModelCapabilityServices | undefined
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MAX_MODEL_ID_LENGTH = 1024
const MAX_PATTERN_LENGTH = 4096
const MAX_MODEL_LIST_LENGTH = 10_000

function validString(value: unknown, maxLength = MAX_MODEL_ID_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0')
}

function validStringArray(value: unknown, maxLength: number): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= MAX_MODEL_LIST_LENGTH
    && value.every((entry) => validString(entry, maxLength))
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key))
    && keys.length >= required.length
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === 'string' && THINKING_LEVELS.includes(value as ModelThinkingLevel)
}

function isModelReference(value: unknown): value is ModelReference {
  if (!isPlainRecord(value)) return false
  const required = ['provider', 'id']
  const optional = Object.hasOwn(value, 'thinkingLevel') ? ['thinkingLevel'] : []
  return hasExactKeys(value, [...required, ...optional])
    && validString(value.provider)
    && validString(value.id)
    && (!Object.hasOwn(value, 'thinkingLevel') || isThinkingLevel(value.thinkingLevel))
}

function isReferenceList(value: unknown): value is readonly ModelReference[] {
  return Array.isArray(value) && value.length <= MAX_MODEL_LIST_LENGTH && value.every(isModelReference)
}

function isEmptyRequest(value: unknown): value is EmptyModelsRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

function isSearchRequest(value: unknown): value is ModelsSearchRequest {
  if (!isPlainRecord(value)) return false
  const required: string[] = []
  const optional = ['query', 'provider'].filter((key) => Object.hasOwn(value, key))
  return hasOnlyKeys(value, required, optional)
    && (!Object.hasOwn(value, 'query') || typeof value.query === 'string' && value.query.length <= MAX_PATTERN_LENGTH)
    && (!Object.hasOwn(value, 'provider') || validString(value.provider))
}

function isEnabledUpdateRequest(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.action !== 'string') return false
  if (value.action === 'clear' || value.action === 'enable-all') {
    return hasExactKeys(value, ['action'])
  }
  return value.action === 'set'
    && hasExactKeys(value, ['action', 'patterns'])
    && validStringArray(value.patterns, MAX_PATTERN_LENGTH)
}

function isEnabledUpdate(value: unknown): value is RevisionedEnabledModelsUpdateRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['expectedRevision', 'update'])
    && Number.isSafeInteger(value.expectedRevision)
    && (value.expectedRevision as number) >= 0
    && isEnabledUpdateRequest(value.update)
}

function isScopedUpdate(value: unknown): value is ScopedModelsUpdateRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['orderedIds'])
    && isReferenceList(value.orderedIds)
}

function isThinkingUpdate(value: unknown): value is ThinkingUpdateRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['level'])
    && isThinkingLevel(value.level)
}

function isModelSelect(value: unknown): value is ModelSelectRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['provider', 'id'])
    && validString(value.provider)
    && validString(value.id)
}

function isModelInfo(value: unknown): value is ModelInfo {
  if (!isPlainRecord(value)) return false
  const keys = ['id', 'provider', 'available', 'authState']
  const optional = Object.hasOwn(value, 'label') ? ['label'] : []
  if (Object.hasOwn(value, 'thinkingLevels')) optional.push('thinkingLevels')
  return hasExactKeys(value, [...keys, ...optional])
    && validString(value.id)
    && validString(value.provider)
    && (!Object.hasOwn(value, 'label') || typeof value.label === 'string')
    && typeof value.available === 'boolean'
    && ['configured', 'credential-stored', 'missing'].includes(value.authState as string)
    && (!Object.hasOwn(value, 'thinkingLevels') || Array.isArray(value.thinkingLevels) && value.thinkingLevels.every(isThinkingLevel))
}

function isProviderAuthMethod(value: unknown): value is ModelAuthMethod {
  return value === 'api_key' || value === 'oauth' || value === 'none'
}

function isProviderInfo(value: unknown): value is ModelProviderInfo {
  return isPlainRecord(value)
    && hasExactKeys(value, ['provider', 'hasCredential', 'authMethod', 'label', 'modelCount', 'availableModelCount'])
    && validString(value.provider)
    && typeof value.hasCredential === 'boolean'
    && isProviderAuthMethod(value.authMethod)
    && typeof value.label === 'string'
    && Number.isSafeInteger(value.modelCount)
    && (value.modelCount as number) >= 0
    && Number.isSafeInteger(value.availableModelCount)
    && (value.availableModelCount as number) >= 0
}

function isProvidersResponse(value: unknown): value is ModelsProvidersResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['providers'])
    && Array.isArray(value.providers)
    && value.providers.every(isProviderInfo)
}

function isSearchResponse(value: unknown): value is ModelsSearchResponse {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['models', 'selected']) || !Array.isArray(value.models)) return false
  return value.models.every(isModelInfo) && (value.selected === null || isModelReference(value.selected))
}

function isEnabledGroup(value: unknown): value is EnabledModelGroup {
  return isPlainRecord(value)
    && hasExactKeys(value, ['provider', 'ids'])
    && validString(value.provider)
    && validStringArray(value.ids, MAX_MODEL_ID_LENGTH)
}

function isNullableStringArray(value: unknown): value is readonly string[] | null {
  return value === null || validStringArray(value, MAX_PATTERN_LENGTH)
}

function isEnabledState(value: unknown): value is EnabledModelsState {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['revision', 'patterns', 'globalPatterns', 'projectPatterns', 'orderedIds', 'orderedIdsByProvider', 'diagnostics'])) return false
  return Number.isSafeInteger(value.revision)
    && (value.revision as number) >= 0
    && isNullableStringArray(value.patterns)
    && isNullableStringArray(value.globalPatterns)
    && isNullableStringArray(value.projectPatterns)
    && isReferenceList(value.orderedIds)
    && Array.isArray(value.orderedIdsByProvider)
    && value.orderedIdsByProvider.every(isEnabledGroup)
    && Array.isArray(value.diagnostics)
    && value.diagnostics.every((entry) => typeof entry === 'string')
}

function isEnabledMutationResult(value: unknown): value is EnabledModelsMutationResult {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome', 'state'])
    && (value.outcome === 'saved' || value.outcome === 'conflict')
    && isEnabledState(value.state)
}

function isScopedState(value: unknown): value is ScopedModelsState {
  return isPlainRecord(value)
    && hasExactKeys(value, ['orderedIds'])
    && isReferenceList(value.orderedIds)
}

function isThinkingState(value: unknown): value is ThinkingState {
  return isPlainRecord(value)
    && hasExactKeys(value, ['current', 'allowed', 'clamped'])
    && isThinkingLevel(value.current)
    && Array.isArray(value.allowed)
    && value.allowed.every(isThinkingLevel)
    && typeof value.clamped === 'boolean'
}

function requireServices(
  router: ModelCapabilityRouter,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): ModelCapabilityServices {
  if (!scope || !isRuntimeScope(scope)) throw new Error('A valid runtime scope is required for model operations.')
  const services = router.resolve(caller, scope)
  if (!services) throw new Error('No model service is bound to this caller and runtime scope.')
  return services
}

/** Build runtime-scoped, caller-bound descriptors for the single app IPC registry. */
export function registerModelCapabilities(router: ModelCapabilityRouter): readonly ModelCapabilityDefinition[] {
  const search: CapabilityDefinition<ModelsSearchRequest, ModelsSearchResponse> = {
    id: MODEL_IPC.search,
    scope: 'runtime',
    validateRequest: isSearchRequest,
    validateResponse: isSearchResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireServices(router, caller, scope).models.search(request),
  }
  const enabledRead: CapabilityDefinition<EmptyModelsRequest, EnabledModelsState> = {
    id: MODEL_IPC.enabledRead,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isEnabledState,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }) => requireServices(router, caller, scope).settings.readEnabled(),
  }
  const enabledUpdate: CapabilityDefinition<RevisionedEnabledModelsUpdateRequest, EnabledModelsMutationResult> = {
    id: MODEL_IPC.enabledUpdate,
    scope: 'runtime',
    validateRequest: isEnabledUpdate,
    validateResponse: isEnabledMutationResult,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireServices(router, caller, scope)
      .settings.updateEnabled(request.expectedRevision, request.update),
  }
  const scopedRead: CapabilityDefinition<EmptyModelsRequest, ScopedModelsState> = {
    id: MODEL_IPC.scopedRead,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isScopedState,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }) => requireServices(router, caller, scope).settings.readScoped(),
  }
  const scopedUpdate: CapabilityDefinition<ScopedModelsUpdateRequest, ScopedModelsState> = {
    id: MODEL_IPC.scopedUpdate,
    scope: 'runtime',
    validateRequest: isScopedUpdate,
    validateResponse: isScopedState,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireServices(router, caller, scope).settings.updateScoped(request.orderedIds),
  }
  const thinkingRead: CapabilityDefinition<EmptyModelsRequest, ThinkingState> = {
    id: MODEL_IPC.thinkingRead,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isThinkingState,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }) => requireServices(router, caller, scope).models.thinking(),
  }
  const thinkingUpdate: CapabilityDefinition<ThinkingUpdateRequest, ThinkingState> = {
    id: MODEL_IPC.thinkingUpdate,
    scope: 'runtime',
    validateRequest: isThinkingUpdate,
    validateResponse: isThinkingState,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireServices(router, caller, scope).models.setThinking(request.level),
  }
  const select: CapabilityDefinition<ModelSelectRequest, ModelInfo> = {
    id: MODEL_IPC.select,
    scope: 'runtime',
    validateRequest: isModelSelect,
    validateResponse: isModelInfo,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireServices(router, caller, scope).models.select(request.provider, request.id),
  }
  const providers: CapabilityDefinition<EmptyModelsRequest, ModelsProvidersResponse> = {
    id: MODEL_IPC.providers,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isProvidersResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }) => requireServices(router, caller, scope).models.providers(),
  }
  return [search, enabledRead, enabledUpdate, scopedRead, scopedUpdate, thinkingRead, thinkingUpdate, select, providers]
}
