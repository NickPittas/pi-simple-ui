import type {} from './ipc-contracts.ts'

export type ModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ModelAuthMethod = 'api_key' | 'oauth' | 'none'
export type ModelAuthState = 'configured' | 'credential-stored' | 'missing'

export interface ModelReference {
  readonly provider: string
  readonly id: string
  readonly thinkingLevel?: ModelThinkingLevel
}

export interface ModelInfo {
  readonly id: string
  readonly provider: string
  readonly label?: string
  readonly available: boolean
  readonly authState: ModelAuthState
  readonly thinkingLevels?: readonly ModelThinkingLevel[]
}

export interface ProviderAuthInfo {
  readonly provider: string
  readonly hasCredential: boolean
  /** The stored/effective auth mechanism only; credential material is never returned. */
  readonly authMethod: ModelAuthMethod
}

export interface ModelProviderInfo extends ProviderAuthInfo {
  readonly label: string
  readonly modelCount: number
  readonly availableModelCount: number
}

export interface ModelsSearchResponse {
  readonly models: readonly ModelInfo[]
  readonly selected: ModelReference | null
}

export interface ModelsProvidersResponse {
  readonly providers: readonly ModelProviderInfo[]
}

export interface EnabledModelGroup {
  readonly provider: string
  readonly ids: readonly string[]
}

export interface EnabledModelsState {
  readonly revision: number
  /** Effective native patterns: null means no value, [] is an explicitly empty list. */
  readonly patterns: readonly string[] | null
  /** Global storage is the scope written by SettingsManager.setEnabledModels(). */
  readonly globalPatterns: readonly string[] | null
  /** A project settings override can affect the effective list, but native setter writes global. */
  readonly projectPatterns: readonly string[] | null
  /** Expanded with the native resolver in native pattern and cycle order. */
  readonly orderedIds: readonly ModelReference[]
  readonly orderedIdsByProvider: readonly EnabledModelGroup[]
  readonly diagnostics: readonly string[]
}

export interface ScopedModelsState {
  /** Current in-memory session scope, in native cycle order. */
  readonly orderedIds: readonly ModelReference[]
}

export interface ThinkingState {
  readonly current: ModelThinkingLevel
  readonly allowed: readonly ModelThinkingLevel[]
  /** True only on a set response when the native session clamped the requested level. */
  readonly clamped: boolean
}

export interface ModelsSearchRequest {
  readonly query?: string
  readonly provider?: string
}

export type EmptyModelsRequest = Record<string, never>

export type EnabledModelsUpdateRequest =
  | { readonly action: 'set'; readonly patterns: readonly string[] }
  | { readonly action: 'enable-all' }
  | { readonly action: 'clear' }

export interface EnabledModelsMutationResult {
  readonly outcome: 'saved' | 'conflict'
  readonly state: EnabledModelsState
}

export interface RevisionedEnabledModelsUpdateRequest {
  readonly expectedRevision: number
  readonly update: EnabledModelsUpdateRequest
}

export interface ScopedModelsUpdateRequest {
  readonly orderedIds: readonly ModelReference[]
}

export interface ThinkingUpdateRequest {
  readonly level: ModelThinkingLevel
}

export interface ModelSelectRequest {
  readonly provider: string
  readonly id: string
}

export interface ModelsCapabilityContracts {
  'models.search': {
    readonly request: ModelsSearchRequest
    readonly response: ModelsSearchResponse
  }
  'models.enabled.read': {
    readonly request: EmptyModelsRequest
    readonly response: EnabledModelsState
  }
  'models.enabled.update': {
    readonly request: RevisionedEnabledModelsUpdateRequest
    readonly response: EnabledModelsMutationResult
  }
  'models.scoped.read': {
    readonly request: EmptyModelsRequest
    readonly response: ScopedModelsState
  }
  'models.scoped.update': {
    readonly request: ScopedModelsUpdateRequest
    readonly response: ScopedModelsState
  }
  'models.thinking.read': {
    readonly request: EmptyModelsRequest
    readonly response: ThinkingState
  }
  'models.thinking.update': {
    readonly request: ThinkingUpdateRequest
    readonly response: ThinkingState
  }
  'models.select': {
    readonly request: ModelSelectRequest
    readonly response: ModelInfo
  }
  'models.providers': {
    readonly request: EmptyModelsRequest
    readonly response: ModelsProvidersResponse
  }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends ModelsCapabilityContracts {}
}
