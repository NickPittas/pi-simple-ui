import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent'
import type {
  ModelInfo,
  ModelProviderInfo,
  ModelReference,
  ModelThinkingLevel,
  ModelsProvidersResponse,
  ModelsSearchRequest,
  ModelsSearchResponse,
  ThinkingState,
} from '../../shared/models.ts'
import type { ProviderModelConfigDiagnostic } from '../../shared/providers.ts'
import { ProviderAuthService } from './provider-auth.ts'

export type ModelSessionAccessor = () => AgentSession | undefined

type NativeConfigDiagnostic = ReturnType<ModelRuntime['validateNativeModelsConfigDocument']>['diagnostics'][number]
type PreparedNativeConfig = ReturnType<ModelRuntime['prepareNativeModelsConfig']>

function reference(model: { readonly provider: string; readonly id: string }): ModelReference {
  return { provider: model.provider, id: model.id }
}

function modelKey(model: { readonly provider: string; readonly id: string }): string {
  return `${model.provider}\0${model.id}`
}

function nativeConfigRuntime(runtime: ModelRuntime): ModelRuntime {
  return runtime
}

function nativeModelConfigDiagnostics(
  nativeErrors: readonly { readonly code: string; readonly path?: readonly string[] }[],
): readonly ProviderModelConfigDiagnostic[] {
  const diagnostics: ProviderModelConfigDiagnostic[] = []
  for (const diagnostic of nativeErrors) {
    const code = diagnostic.code === 'schema-invalid' ? 'native-config-schema-invalid' : 'native-provider-invalid'
    if (diagnostics.some((entry) => entry.code === code && JSON.stringify(entry.path) === JSON.stringify(diagnostic.path))) continue
    diagnostics.push({
      code,
      ...(diagnostic.path && diagnostic.path.length > 0 ? { path: diagnostic.path } : {}),
      message: code === 'native-config-schema-invalid'
        ? 'Pi rejected fields in the native models.json schema.'
        : 'Pi could not compose one or more native provider definitions.',
    })
  }
  return diagnostics
}

export class ModelService {
  private readonly auth: ProviderAuthService
  private readonly getSession: ModelSessionAccessor

  constructor(getSession: ModelSessionAccessor, auth = new ProviderAuthService()) {
    this.getSession = getSession
    this.auth = auth
  }

  search(request: ModelsSearchRequest = {}): Promise<ModelsSearchResponse> {
    const session = this.requireSession()
    const runtime = session.modelRuntime
    const available = new Set(runtime.getAvailableSnapshot().map(modelKey))
    const selected = session.model ? reference(session.model) : null
    const query = request.query?.trim().toLocaleLowerCase()
    const providerFilter = request.provider?.trim().toLocaleLowerCase()
    const authStates = this.authStates(runtime)

    return this.auth.list(runtime).then((authInfo) => {
      const storedByProvider = new Map(authInfo.map((entry) => [entry.provider, entry]))
      const models: ModelInfo[] = runtime.getModels().filter((model) => {
        if (providerFilter && model.provider.toLocaleLowerCase() !== providerFilter) return false
        if (!query) return true
        return `${model.provider}/${model.id} ${model.name ?? ''}`.toLocaleLowerCase().includes(query)
      }).map((model) => {
        const stored = storedByProvider.get(model.provider)
        const state = authStates.get(model.provider)
        const thinkingLevels = session.model?.provider === model.provider && session.model.id === model.id
          ? session.getAvailableThinkingLevels() as ModelThinkingLevel[]
          : undefined
        return {
          id: model.id,
          provider: model.provider,
          ...(model.name ? { label: model.name } : {}),
          available: available.has(modelKey(model)),
          authState: state === true ? 'configured' : stored?.hasCredential ? 'credential-stored' : 'missing',
          ...(thinkingLevels ? { thinkingLevels } : {}),
        }
      })
      return { models, selected }
    })
  }

  async providers(): Promise<ModelsProvidersResponse> {
    const runtime = this.requireSession().modelRuntime
    const [authInfo] = await Promise.all([this.auth.list(runtime)])
    const authByProvider = new Map(authInfo.map((entry) => [entry.provider, entry]))
    const modelsByProvider = new Map<string, number>()
    const availableByProvider = new Map<string, number>()
    for (const model of runtime.getModels()) modelsByProvider.set(model.provider, (modelsByProvider.get(model.provider) ?? 0) + 1)
    for (const model of runtime.getAvailableSnapshot()) availableByProvider.set(model.provider, (availableByProvider.get(model.provider) ?? 0) + 1)

    const providers: ModelProviderInfo[] = []
    for (const provider of runtime.getProviders()) {
      const auth = authByProvider.get(provider.id)
      providers.push({
        provider: provider.id,
        label: provider.name,
        hasCredential: auth?.hasCredential ?? false,
        authMethod: auth?.authMethod ?? 'none',
        modelCount: modelsByProvider.get(provider.id) ?? 0,
        availableModelCount: availableByProvider.get(provider.id) ?? 0,
      })
    }
    for (const auth of authInfo) {
      if (runtime.getProvider(auth.provider)) continue
      providers.push({ ...auth, label: auth.provider, modelCount: 0, availableModelCount: 0 })
    }
    return { providers }
  }

  async select(providerId: string, modelId: string): Promise<ModelInfo> {
    const session = this.requireSession()
    const runtime = session.modelRuntime
    const model = runtime.getModel(providerId, modelId)
    if (!model) throw new TypeError('The selected model is not present in the native model registry.')
    if (!runtime.getAvailableSnapshot().some((candidate) => modelKey(candidate) === modelKey(model))) {
      throw new TypeError('The selected model is not currently available in the native model runtime.')
    }
    await session.setModel(model)
    const [authInfo] = await Promise.all([this.auth.list(runtime)])
    const authByProvider = new Map(authInfo.map((entry) => [entry.provider, entry]))
    const configured = runtime.getProviderAuthStatus(providerId).configured
    return {
      id: model.id,
      provider: model.provider,
      ...(model.name ? { label: model.name } : {}),
      available: true,
      authState: configured ? 'configured' : authByProvider.get(providerId)?.hasCredential ? 'credential-stored' : 'missing',
      thinkingLevels: session.getAvailableThinkingLevels() as ModelThinkingLevel[],
    }
  }

  thinking(): ThinkingState {
    const session = this.requireSession()
    return {
      current: session.thinkingLevel as ModelThinkingLevel,
      allowed: session.getAvailableThinkingLevels() as ModelThinkingLevel[],
      clamped: false,
    }
  }

  setThinking(level: ModelThinkingLevel): ThinkingState {
    const session = this.requireSession()
    session.setThinkingLevel(level)
    return {
      current: session.thinkingLevel as ModelThinkingLevel,
      allowed: session.getAvailableThinkingLevels() as ModelThinkingLevel[],
      clamped: session.thinkingLevel !== level,
    }
  }

  getRuntime(): ModelRuntime {
    return this.requireSession().modelRuntime
  }

  /** Validate staged native models.json without reading auth storage or invoking provider callbacks. */
  validateNativeModelConfiguration(document: unknown): readonly ProviderModelConfigDiagnostic[] {
    try {
      const runtime = nativeConfigRuntime(this.requireSession().modelRuntime)
      const result = runtime.validateNativeModelsConfigDocument(document)
      return nativeModelConfigDiagnostics(result.diagnostics)
    } catch {
      return [{ code: 'native-config-load-failed', message: 'Pi could not validate the native models.json file.' }]
    }
  }

  prepareNativeModelConfiguration(document: unknown): {
    readonly runtime: ModelRuntime
    readonly prepared: PreparedNativeConfig
  } {
    const runtime = this.requireSession().modelRuntime
    return { runtime, prepared: nativeConfigRuntime(runtime).prepareNativeModelsConfig(document) }
  }

  publishPreparedNativeModelConfiguration(
    publication: {
      readonly runtime: ModelRuntime
      readonly prepared: PreparedNativeConfig
    },
  ): readonly ProviderModelConfigDiagnostic[] {
    const result = nativeConfigRuntime(publication.runtime).publishPreparedNativeModelsConfig(publication.prepared)
    return nativeModelConfigDiagnostics(result.diagnostics)
  }

  /** Explicit refresh may read native credentials and resolve configured command references. */
  async refreshNativeModelAvailability(): Promise<readonly ProviderModelConfigDiagnostic[]> {
    const runtime = this.requireSession().modelRuntime
    try {
      const result = await runtime.refresh({ allowNetwork: false })
      if (result.errors.size === 0 && !result.aborted) return []
      return [{
        code: 'native-availability-refresh-failed',
        message: 'Pi could not refresh native model availability. Check Pi diagnostics for provider details.',
      }]
    } catch {
      return [{
        code: 'native-availability-refresh-failed',
        message: 'Pi could not refresh native model availability. Check Pi diagnostics for provider details.',
      }]
    }
  }

  private authStates(runtime: ModelRuntime): Map<string, boolean> {
    return new Map(runtime.getProviders().map((provider) => [provider.id, runtime.getProviderAuthStatus(provider.id).configured]))
  }

  private requireSession(): AgentSession {
    const session = this.getSession()
    if (!session) throw new Error('No active agent session is available for model operations.')
    return session
  }
}
