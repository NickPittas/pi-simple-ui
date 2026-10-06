import { randomUUID } from 'node:crypto'
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type {
  ProviderAccountSummary,
  ProviderAccountSwitchResult,
  ProviderAccountsSnapshot,
  ProviderAuthEvent,
  ProviderAuthLoginMethod,
  ProviderAuthNotice,
  ProviderAuthOperationResult,
  ProviderAuthPrompt,
  ProviderAuthState,
} from '../../shared/providers.ts'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'
import {
  ProviderAuthService,
  type ProviderAuthInteraction,
  type ProviderAuthLoginOptions,
} from './provider-auth.ts'

export interface SystemBrowserCapability {
  /** Main-process implementation should delegate to Electron shell.openExternal(). */
  openExternal(url: string): Promise<void>
}

/** Optional bridge to pi-multi-account's own slot removal, including its OAuth sidecar cleanup. */
export interface NativeMultiAccountSlotOperations {
  remove(providerId: string): Promise<boolean>
}

export type AccountSessionAccessor = () => AgentSession | undefined

interface PendingPrompt {
  readonly type: ProviderAuthPrompt['type']
  readonly optionIds?: ReadonlySet<string>
  accept(value: string): void
  cancel(): void
}

interface ActiveJourney {
  readonly id: string
  readonly contextKey: string
  readonly provider: string
  readonly controller: AbortController
  readonly prompts: Map<string, PendingPrompt>
}

type AuthEventPublisher = (event: ProviderAuthEvent) => void

function contextKey(caller: AuthorizedIpcCaller, scope: RuntimeScope): string {
  return JSON.stringify([caller.windowId, caller.webContentsId, caller.frameUrl, scope.ownerId, scope.generation])
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.username === '' && url.password === ''
      && (url.protocol === 'https:'
        || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch {
    return false
  }
}

function publicPrompt(prompt: Parameters<ProviderAuthInteraction['prompt']>[0]): ProviderAuthPrompt {
  if (prompt.type === 'select') {
    return {
      type: 'select',
      message: prompt.message.slice(0, 4096),
      options: prompt.options.slice(0, 100).map((option) => ({
        id: option.id.slice(0, 1024),
        label: option.label.slice(0, 1024),
        ...(option.description ? { description: option.description.slice(0, 4096) } : {}),
      })),
    }
  }
  return {
    type: prompt.type,
    message: prompt.message.slice(0, 4096),
    ...(prompt.placeholder ? { placeholder: prompt.placeholder.slice(0, 4096) } : {}),
  }
}

function publicNotice(event: Parameters<ProviderAuthInteraction['notify']>[0]): ProviderAuthNotice {
  if (event.type === 'auth_url') {
    return {
      type: 'auth_url',
      url: event.url.slice(0, 4096),
      ...(event.instructions ? { instructions: event.instructions.slice(0, 4096) } : {}),
    }
  }
  if (event.type === 'device_code') {
    return {
      type: 'device_code',
      userCode: event.userCode.slice(0, 256),
      verificationUri: event.verificationUri.slice(0, 4096),
      ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
      ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
    }
  }
  if (event.type === 'info') {
    return {
      type: 'info',
      message: event.message.slice(0, 4096),
      ...(event.links ? {
        links: event.links.slice(0, 20).map((link) => ({
          url: link.url.slice(0, 4096),
          ...(link.label ? { label: link.label.slice(0, 1024) } : {}),
        })),
      } : {}),
    }
  }
  return { type: 'progress', message: event.message.slice(0, 4096) }
}

/** Main-process provider accounts and authentication journeys over Pi's native stores. */
export class AccountService {
  private readonly getSession: AccountSessionAccessor
  private readonly auth: ProviderAuthService
  private readonly browser: SystemBrowserCapability
  private readonly getDeviceId: (() => string) | undefined
  private readonly multiAccountSlots: NativeMultiAccountSlotOperations | undefined
  private readonly listeners = new Map<string, Set<AuthEventPublisher>>()
  private readonly journeys = new Map<string, ActiveJourney>()

  constructor(
    getSession: AccountSessionAccessor,
    browser: SystemBrowserCapability,
    auth = new ProviderAuthService(),
    getDeviceId?: () => string,
    multiAccountSlots?: NativeMultiAccountSlotOperations,
  ) {
    this.getSession = getSession
    this.browser = browser
    this.auth = auth
    this.getDeviceId = getDeviceId
    this.multiAccountSlots = multiAccountSlots
  }

  async read(): Promise<ProviderAccountsSnapshot> {
    const session = this.requireSession()
    const runtime = session.modelRuntime
    const [authInfo, availableModels] = await Promise.all([
      this.auth.list(runtime),
      Promise.resolve(runtime.getAvailableSnapshot()),
    ])
    const availableByProvider = new Map<string, string[]>()
    const modelIdsByProvider = new Map<string, string[]>()
    for (const model of runtime.getModels()) {
      const ids = modelIdsByProvider.get(model.provider) ?? []
      ids.push(model.id)
      modelIdsByProvider.set(model.provider, ids)
    }
    for (const model of availableModels) {
      const ids = availableByProvider.get(model.provider) ?? []
      ids.push(model.id)
      availableByProvider.set(model.provider, ids)
    }

    const providers = authInfo.map((authInfoEntry) => {
      const nativeProvider = runtime.getProvider(authInfoEntry.provider)
      const modelIds = modelIdsByProvider.get(authInfoEntry.provider) ?? []
      return {
        provider: authInfoEntry.provider,
        label: nativeProvider?.name ?? authInfoEntry.provider,
        hasCredential: authInfoEntry.hasCredential,
        authMethod: authInfoEntry.authMethod,
        configured: runtime.getProviderAuthStatus(authInfoEntry.provider).configured,
        available: (availableByProvider.get(authInfoEntry.provider)?.length ?? 0) > 0,
        loginMethods: this.auth.loginMethods(runtime, authInfoEntry.provider),
        modelIds,
      }
    })
    const selectedProvider = session.model?.provider
    const accounts: ProviderAccountSummary[] = authInfo.filter((entry) => entry.hasCredential).map((entry) => {
      const nativeProvider = runtime.getProvider(entry.provider)
      const modelIds = modelIdsByProvider.get(entry.provider) ?? []
      return {
        providerId: entry.provider,
        label: nativeProvider?.name ?? entry.provider,
        authMethod: entry.authMethod,
        configured: runtime.getProviderAuthStatus(entry.provider).configured,
        available: (availableByProvider.get(entry.provider)?.length ?? 0) > 0,
        selected: selectedProvider === entry.provider,
        modelIds,
      }
    })
    return { providers, accounts }
  }

  async switchAccount(provider: string, modelId: string): Promise<ProviderAccountSwitchResult> {
    const session = this.requireSession()
    const runtime = session.modelRuntime
    const model = runtime.getModel(provider, modelId)
    if (!model) return { outcome: 'not-found', provider, modelId }
    if (!runtime.getAvailableSnapshot().some((available) => available.provider === provider && available.id === modelId)) {
      return { outcome: 'unavailable', provider, modelId }
    }
    try {
      // Account identity is the native auth.json provider key. Selection is session-only, as in Pi.
      await session.setModel(model)
      return { outcome: 'selected', provider, modelId }
    } catch {
      return { outcome: 'unavailable', provider, modelId }
    }
  }

  async login(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    journeyId: string,
    provider: string,
    method: ProviderAuthLoginMethod,
  ): Promise<ProviderAuthOperationResult> {
    const runtime = this.requireSession().modelRuntime
    const providerInfo = runtime.getProvider(provider)
    if (!providerInfo) return this.result(runtime, provider, 'not-found')
    if (!this.auth.loginMethods(runtime, provider).includes(method)) return this.result(runtime, provider, 'unsupported')

    const key = this.journeyKey(caller, scope, journeyId)
    if (this.journeys.has(key)) return this.result(runtime, provider, 'failed')
    const journey: ActiveJourney = {
      id: journeyId,
      contextKey: contextKey(caller, scope),
      provider,
      controller: new AbortController(),
      prompts: new Map(),
    }
    this.journeys.set(key, journey)
    this.emit(journey, { type: 'journey', journeyId, provider, status: 'started' })

    const interaction: ProviderAuthInteraction = {
      signal: journey.controller.signal,
      prompt: (prompt) => this.prompt(journey, prompt),
      notify: (event) => this.notify(journey, event),
    }
    const loginOptions: ProviderAuthLoginOptions | undefined = this.getDeviceId
      ? { getDeviceId: this.getDeviceId }
      : undefined

    let status: ProviderAuthOperationResult['status'] = 'completed'
    try {
      await this.auth.login(runtime, provider, method, interaction, loginOptions)
    } catch {
      status = journey.controller.signal.aborted ? 'cancelled' : 'failed'
    } finally {
      if (status !== 'completed' && journey.controller.signal.aborted) status = 'cancelled'
      this.finishJourney(key, journey, status)
    }
    return this.result(runtime, provider, status)
  }

  async logout(provider: string): Promise<ProviderAuthOperationResult> {
    const runtime = this.requireSession().modelRuntime
    if (/-account-\d+$/.test(provider)) {
      // pi-multi-account may shadow OAuth slot credentials in its private sidecar. Deleting only
      // the auth.json placeholder would orphan that credential, so fail closed without its native
      // slot-removal bridge rather than pretending ModelRuntime.logout is a complete slot logout.
      if (!this.multiAccountSlots) return this.result(runtime, provider, 'unsupported')
      try {
        if (!await this.multiAccountSlots.remove(provider)) return this.result(runtime, provider, 'failed')
        return this.result(runtime, provider, 'completed')
      } catch {
        return this.result(runtime, provider, 'failed')
      }
    }
    const hasProvider = runtime.getProvider(provider) !== undefined
    let hasCredential = false
    try {
      hasCredential = (await runtime.listCredentials()).some((entry) => entry.providerId === provider)
    } catch {
      return { status: 'failed', state: null }
    }
    if (!hasProvider && !hasCredential) return this.result(runtime, provider, 'not-found')
    try {
      await this.auth.logout(runtime, provider)
      return this.result(runtime, provider, 'completed')
    } catch {
      return this.result(runtime, provider, 'failed')
    }
  }

  async refresh(provider: string): Promise<ProviderAuthOperationResult> {
    const runtime = this.requireSession().modelRuntime
    if (!runtime.getProvider(provider)) return this.result(runtime, provider, 'not-found')
    try {
      const configured = await this.auth.refresh(runtime, provider)
      return this.result(runtime, provider, configured ? 'completed' : 'failed')
    } catch {
      return this.result(runtime, provider, 'failed')
    }
  }

  cancel(caller: AuthorizedIpcCaller, scope: RuntimeScope, journeyId: string): boolean {
    const journey = this.journeys.get(this.journeyKey(caller, scope, journeyId))
    if (!journey) return false
    journey.controller.abort(new Error('Login cancelled'))
    return true
  }

  respond(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    journeyId: string,
    promptId: string,
    value: string,
  ): boolean {
    const journey = this.journeys.get(this.journeyKey(caller, scope, journeyId))
    const pending = journey?.prompts.get(promptId)
    if (!pending) return false
    if (pending.type === 'select') {
      if (!pending.optionIds?.has(value)) return false
    }
    pending.accept(value)
    return true
  }

  subscribe(caller: AuthorizedIpcCaller, scope: RuntimeScope, publish: AuthEventPublisher): () => void {
    const key = contextKey(caller, scope)
    const listeners = this.listeners.get(key) ?? new Set<AuthEventPublisher>()
    listeners.add(publish)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(publish)
      if (listeners.size === 0) {
        this.listeners.delete(key)
        for (const journey of this.journeys.values()) {
          if (journey.contextKey === key) journey.controller.abort(new Error('Authentication caller disconnected'))
        }
      }
    }
  }

  private prompt(
    journey: ActiveJourney,
    prompt: Parameters<ProviderAuthInteraction['prompt']>[0],
  ): Promise<string> {
    const promptId = randomUUID()
    const visiblePrompt = publicPrompt(prompt)
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        prompt.signal?.removeEventListener('abort', onAbort)
        journey.controller.signal.removeEventListener('abort', onAbort)
        journey.prompts.delete(promptId)
      }
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        callback()
      }
      const onAbort = (): void => settle(() => reject(new Error('Login prompt cancelled')))
      const pending: PendingPrompt = {
        type: visiblePrompt.type,
        ...(visiblePrompt.type === 'select'
          ? { optionIds: new Set(visiblePrompt.options.map((option) => option.id)) }
          : {}),
        accept: (value) => settle(() => resolve(value)),
        cancel: () => settle(() => reject(new Error('Login prompt cancelled'))),
      }
      journey.prompts.set(promptId, pending)
      prompt.signal?.addEventListener('abort', onAbort, { once: true })
      journey.controller.signal.addEventListener('abort', onAbort, { once: true })
      if (prompt.signal?.aborted || journey.controller.signal.aborted) {
        onAbort()
        return
      }
      if (!this.emit(journey, {
        type: 'prompt',
        journeyId: journey.id,
        provider: journey.provider,
        promptId,
        prompt: visiblePrompt,
      })) onAbort()
    })
  }

  private notify(journey: ActiveJourney, nativeEvent: Parameters<ProviderAuthInteraction['notify']>[0]): void {
    const notice = publicNotice(nativeEvent)
    this.emit(journey, { type: 'notice', journeyId: journey.id, provider: journey.provider, notice })
    const url = nativeEvent.type === 'auth_url'
      ? nativeEvent.url
      : nativeEvent.type === 'device_code' ? nativeEvent.verificationUri : undefined
    if (url && isSafeExternalUrl(url)) {
      void this.browser.openExternal(url).catch(() => {
        this.emit(journey, {
          type: 'notice',
          journeyId: journey.id,
          provider: journey.provider,
          notice: { type: 'progress', message: 'The system browser could not be opened.' },
        })
      })
    }
  }

  private emit(journey: ActiveJourney, event: ProviderAuthEvent): boolean {
    const listeners = this.listeners.get(journey.contextKey)
    if (!listeners?.size) return false
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch {
        // Renderer event subscribers are isolated from authentication and credential storage.
      }
    }
    return true
  }

  private finishJourney(key: string, journey: ActiveJourney, status: 'completed' | 'cancelled' | 'failed'): void {
    for (const prompt of journey.prompts.values()) prompt.cancel()
    journey.prompts.clear()
    this.journeys.delete(key)
    this.emit(journey, { type: 'journey', journeyId: journey.id, provider: journey.provider, status })
  }

  private journeyKey(caller: AuthorizedIpcCaller, scope: RuntimeScope, journeyId: string): string {
    return `${contextKey(caller, scope)}\0${journeyId}`
  }

  private async result(
    runtime: ModelRuntime,
    provider: string,
    status: ProviderAuthOperationResult['status'],
  ): Promise<ProviderAuthOperationResult> {
    try {
      const authInfo = (await this.auth.list(runtime)).find((entry) => entry.provider === provider)
      return {
        status,
        state: {
          provider,
          hasCredential: authInfo?.hasCredential ?? false,
          authMethod: authInfo?.authMethod ?? 'none',
          configured: runtime.getProviderAuthStatus(provider).configured,
          available: runtime.getAvailableSnapshot().some((model) => model.provider === provider),
        },
      }
    } catch {
      return { status, state: null }
    }
  }

  private requireSession(): AgentSession {
    const session = this.getSession()
    if (!session) throw new Error('No active agent session is available for provider operations.')
    return session
  }
}
