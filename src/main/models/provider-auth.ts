import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ModelAuthMethod, ProviderAuthInfo } from '../../shared/models.ts'
import type { ProviderAuthLoginMethod } from '../../shared/providers.ts'

/** Exact interaction type accepted by Pi's native ModelRuntime.login(). */
export type ProviderAuthInteraction = Parameters<ModelRuntime['login']>[2]
export type ProviderAuthLoginOptions = Parameters<ModelRuntime['login']>[3]

/** Optional app-specific delegation seam; native credential operations stay in ModelRuntime. */
export interface ProviderAuthDelegation {
  login(providerId: string, interaction: ProviderAuthInteraction): Promise<void>
  logout(providerId: string): Promise<void>
}

export class ProviderAuthService {
  loginMethods(runtime: ModelRuntime, providerId: string): readonly ProviderAuthLoginMethod[] {
    const provider = runtime.getProvider(providerId)
    if (!provider) return []
    const methods: ProviderAuthLoginMethod[] = []
    if (provider.auth.apiKey?.login) methods.push('api_key')
    if (provider.auth.oauth?.login) methods.push('oauth')
    return methods
  }

  async login(
    runtime: ModelRuntime,
    providerId: string,
    method: ProviderAuthLoginMethod,
    interaction: ProviderAuthInteraction,
    options?: ProviderAuthLoginOptions,
  ): Promise<void> {
    if (!this.loginMethods(runtime, providerId).includes(method)) {
      throw new TypeError(`Provider ${providerId} does not support ${method} login.`)
    }
    // ModelRuntime persists the returned credential through its native CredentialStore and
    // synchronizes provider availability. The Credential value is intentionally discarded.
    await runtime.login(providerId, method, interaction, options)
  }

  logout(runtime: ModelRuntime, providerId: string, signal?: AbortSignal): Promise<void> {
    return runtime.logout(providerId, { signal })
  }

  async refresh(runtime: ModelRuntime, providerId: string, signal?: AbortSignal): Promise<boolean> {
    // getAuth owns native OAuth refresh and store serialization. Never return or retain AuthResult.
    const auth = await runtime.getAuth(providerId, { signal })
    if (!auth) return false
    const result = await runtime.refresh({ providers: [providerId], allowNetwork: false, signal })
    if (result.aborted) signal?.throwIfAborted()
    const error = result.errors.get(providerId)
    if (error) throw error
    return true
  }

  async list(runtime: ModelRuntime): Promise<readonly ProviderAuthInfo[]> {
    // CredentialInfo is deliberately metadata-only; never call read() or getAuth().
    const credentials = await runtime.listCredentials()
    const credentialByProvider = new Map(credentials.map((entry) => [entry.providerId, entry.type]))
    const providers = new Set([
      ...runtime.getProviders().map((provider) => provider.id),
      ...credentialByProvider.keys(),
    ])

    return [...providers].sort((left, right) => left.localeCompare(right)).map((provider) => {
      const storedMethod = credentialByProvider.get(provider)
      const status = runtime.getProviderAuthStatus(provider)
      let authMethod: ModelAuthMethod = 'none'
      if (runtime.isUsingOAuth(provider)) authMethod = 'oauth'
      else if (storedMethod) authMethod = storedMethod
      else if (status.configured) authMethod = 'api_key'
      return {
        provider,
        hasCredential: storedMethod !== undefined,
        authMethod,
      }
    })
  }
}
