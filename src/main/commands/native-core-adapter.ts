import type { CoreCommandContext, CoreCommandHandler, CommandDispatcher } from './dispatch.ts'
import { BUILTIN_SLASH_COMMANDS } from '../../../vendor/pi/packages/coding-agent/src/core/slash-commands.ts'
import { KEYBINDINGS } from '../../../vendor/pi/packages/coding-agent/src/core/keybindings.ts'
import { getChangelogPath } from '../../../vendor/pi/packages/coding-agent/src/config.ts'
import { normalizeChangelogLinks, parseChangelog } from '../../../vendor/pi/packages/coding-agent/src/utils/changelog.ts'
import type {
  NativeCommandJsonObject,
  NativeCommandJsonValue,
  NativeCoreCommandOutcome,
  NativeCommandMenuKind,
  NativeCommandMenuSelectionSchema,
  NativeCommandMenuSelection,
  CommandEffectDataResponse,
  CoreCommandMenuRequestResponse,
  WorkspaceTrustCommandRequest,
  ApplicationQuitCommandRequest,
} from '../../shared/commands.ts'
import { COMMAND_EFFECT_DATA_MAX_BYTES, COMMAND_MENU_MAX_BYTES } from '../../shared/commands.ts'
import { SessionService, type SessionSwitchPort } from '../sessions/session-service.ts'

export interface NativeCoreCommandOutcomeSink {
  publish(context: CoreCommandContext, outcome: NativeCoreCommandOutcome): void | Promise<void>
}

export interface NativeCoreCommandAdapterOptions {
  readonly outcomeSink: NativeCoreCommandOutcomeSink
  readonly sessionSwitch?: SessionSwitchPort
}

type NativeHandler = (
  context: CoreCommandContext,
  sessions: SessionService,
) => Promise<NativeCoreCommandOutcome>

const MAX_TEXT = 8192

interface BoundedJsonResult {
  readonly value: NativeCommandJsonValue
  readonly truncated: boolean
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return COMMAND_EFFECT_DATA_MAX_BYTES
  }
}

function boundedJson(value: unknown): BoundedJsonResult {
  let remainingNodes = 2048
  let truncated = false
  const visit = (candidate: unknown, depth: number): NativeCommandJsonValue => {
    remainingNodes -= 1
    if (remainingNodes < 0 || depth >= 8) {
      truncated = true
      return '[truncated]'
    }
    if (candidate === null || typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'string') {
      if (candidate.length > MAX_TEXT) truncated = true
      return candidate.slice(0, MAX_TEXT)
    }
    if (typeof candidate === 'number') {
      if (Number.isFinite(candidate)) return candidate
      truncated = true
      return null
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 128) truncated = true
      const output: NativeCommandJsonValue[] = []
      for (const entry of candidate.slice(0, 128)) {
        if (remainingNodes < 0) {
          truncated = true
          break
        }
        output.push(visit(entry, depth + 1))
      }
      return output
    }
    if (typeof candidate === 'object') {
      const object: Record<string, NativeCommandJsonValue> = {}
      const entries = Object.entries(candidate)
      if (entries.length > 128) truncated = true
      for (const [key, entry] of entries.slice(0, 128)) {
        if (remainingNodes < 0) {
          truncated = true
          break
        }
        if (key.length > 128) truncated = true
        object[key.slice(0, 128)] = visit(entry, depth + 1)
      }
      return object
    }
    truncated = true
    return null
  }
  return { value: visit(value, 0), truncated }
}

function jsonObject(value: unknown): NativeCommandJsonObject {
  const bounded = boundedJson(value).value
  return bounded !== null && typeof bounded === 'object' && !Array.isArray(bounded)
    ? bounded as NativeCommandJsonObject
    : Object.freeze({})
}

function fitJsonValue(
  value: NativeCommandJsonValue,
  byteLimit: number,
  state: { truncated: boolean },
): NativeCommandJsonValue | undefined {
  if (jsonBytes(value) <= byteLimit) return value
  if (typeof value === 'string') {
    state.truncated = true
    let low = 0
    let high = value.length
    let best = ''
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = value.slice(0, middle)
      if (jsonBytes(candidate) <= byteLimit) {
        best = candidate
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return best
  }
  if (Array.isArray(value)) {
    const output: NativeCommandJsonValue[] = []
    for (const entry of value) {
      const currentBytes = jsonBytes(output)
      const entryLimit = byteLimit - currentBytes - (output.length > 0 ? 1 : 0)
      if (entryLimit <= 0) {
        state.truncated = true
        break
      }
      const bounded = fitJsonValue(entry, entryLimit, state)
      if (bounded === undefined) {
        state.truncated = true
        break
      }
      output.push(bounded)
      if (jsonBytes(output) > byteLimit) {
        output.pop()
        state.truncated = true
        break
      }
      if (bounded !== entry) state.truncated = true
    }
    if (output.length < value.length) state.truncated = true
    return output
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, NativeCommandJsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      const currentBytes = jsonBytes(output)
      const keyBytes = jsonBytes(key) + 1
      const entryLimit = byteLimit - currentBytes - keyBytes - (Object.keys(output).length > 0 ? 1 : 0)
      if (entryLimit <= 0) {
        state.truncated = true
        break
      }
      const bounded = fitJsonValue(entry, entryLimit, state)
      if (bounded === undefined) {
        state.truncated = true
        break
      }
      output[key] = bounded
      if (jsonBytes(output) > byteLimit) {
        delete output[key]
        state.truncated = true
        break
      }
      if (bounded !== entry) state.truncated = true
    }
    if (Object.keys(output).length < Object.keys(value).length) state.truncated = true
    return output
  }
  state.truncated = true
  return undefined
}

function boundedEffectData(value: unknown): { readonly data: NativeCommandJsonObject; readonly truncated: boolean } {
  const result = boundedJson(value)
  const object = result.value !== null && typeof result.value === 'object' && !Array.isArray(result.value)
    ? result.value as NativeCommandJsonObject
    : Object.freeze({})
  const state = { truncated: result.truncated }
  const bounded = fitJsonValue(object, COMMAND_EFFECT_DATA_MAX_BYTES - 512, state)
  return {
    data: bounded !== null && typeof bounded === 'object' && !Array.isArray(bounded)
      ? bounded as NativeCommandJsonObject
      : Object.freeze({}),
    truncated: state.truncated,
  }
}

function applied(commandName: string, data?: NativeCommandJsonObject): NativeCoreCommandOutcome {
  return { type: 'applied', commandName, ...(data ? { data } : {}) }
}

function boundedMenuChoices(values: readonly string[]): { readonly values: readonly string[]; readonly truncated: boolean } {
  const output: string[] = []
  let truncated = false
  for (const value of values) {
    if (!value || value.length > 256 || jsonBytes([...output, value]) > 12 * 1024) {
      truncated = true
      break
    }
    output.push(value)
    if (output.length >= 128 && output.length < values.length) {
      truncated = true
      break
    }
  }
  return { values: output, truncated }
}

function menuRequest(
  commandName: string,
  menu: NativeCommandMenuKind,
  initialState: unknown,
  selection?: NativeCommandMenuSelectionSchema,
): NativeCoreCommandOutcome {
  const bounded = boundedJson(initialState)
  const original = bounded.value !== null && typeof bounded.value === 'object' && !Array.isArray(bounded.value)
    ? bounded.value as NativeCommandJsonObject
    : Object.freeze({})
  const selectionChoices = selection
    ? boundedMenuChoices(selection.kind === 'argument' ? selection.values : selection.availableModelReferences)
    : undefined
  const state = { truncated: bounded.truncated || selectionChoices?.truncated === true }
  const boundedState = fitJsonValue(original, COMMAND_MENU_MAX_BYTES / 2, state)
  const initial = boundedState !== null && typeof boundedState === 'object' && !Array.isArray(boundedState)
    ? { ...(boundedState as NativeCommandJsonObject), ...(state.truncated ? { truncated: true } : {}) }
    : { truncated: true }
  const boundedSelection = selectionChoices && selection
    ? selection.kind === 'argument'
      ? { kind: selection.kind, argument: selection.argument, values: selectionChoices.values }
      : { kind: selection.kind, availableModelReferences: selectionChoices.values, canPersist: selection.canPersist }
    : undefined
  return {
    type: 'menu-request',
    commandName,
    menu,
    initialState: jsonObject(initial),
    ...(boundedSelection ? { selection: boundedSelection } : {}),
  }
}

function effectData(commandName: string, effect: string, data: unknown, explicitlyTruncated = false): NativeCoreCommandOutcome {
  const bounded = boundedEffectData(data)
  const truncated = explicitlyTruncated || bounded.truncated
  return { type: 'effect-data', commandName, effect, data: bounded.data, ...(truncated ? { truncated: true } : {}) }
}

function rejected(commandName: string, reason: string): NativeCoreCommandOutcome {
  return { type: 'rejected', commandName, reason: reason.slice(0, 160) }
}

function requireNoArguments(context: CoreCommandContext): boolean {
  return context.input.args.length === 0
}

function selectScopedModels(
  context: CoreCommandContext,
  selection: Extract<NativeCommandMenuSelection, { readonly kind: 'scoped-models' }>,
): NativeCoreCommandOutcome {
  const { session } = context
  if (selection.persist && !session.settingsManager.isProjectTrusted()) {
    return rejected('scoped-models', 'project-settings-are-not-trusted')
  }
  const available = session.modelRuntime.getAvailableSnapshot()
  const availableByReference = new Map(available.map((model) => [`${model.provider}/${model.id}`, model]))
  const selected = selection.enabledModelReferences.map((reference) => availableByReference.get(reference))
  if (selected.some((model) => !model)) return rejected('scoped-models', 'model-not-available')
  const allAvailableSelected = selection.enabledModelReferences.length === available.length
    && available.every((model) => selection.enabledModelReferences.includes(`${model.provider}/${model.id}`))
  const selectedReferences = allAvailableSelected ? undefined : [...selection.enabledModelReferences]
  session.setScopedModels(selectedReferences
    ? selectedReferences.map((reference) => ({ model: availableByReference.get(reference)! }))
    : [])
  if (selection.persist) session.settingsManager.setEnabledModels(selectedReferences)
  return applied('scoped-models', jsonObject({
    sessionScoped: true,
    persisted: selection.persist,
    enabledModels: selectedReferences ?? available.map((model) => `${model.provider}/${model.id}`),
  }))
}

async function sessionEffect(context: CoreCommandContext, sessions: SessionService): Promise<NativeCoreCommandOutcome> {
  try {
    const result = await sessions.execute(context.command.name, context.input)
    return result ?? rejected(context.command.name, 'unsupported-session-command')
  } catch {
    return rejected(context.command.name, 'session-operation-failed')
  }
}

async function settings(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  if (!requireNoArguments(context)) return rejected('settings', 'unexpected-arguments')
  const { session } = context
  return menuRequest('settings', 'settings', {
    effective: session.settingsManager.getSettings(),
    global: session.settingsManager.getGlobalSettings(),
    project: session.settingsManager.getProjectSettings(),
    projectTrusted: session.settingsManager.isProjectTrusted(),
    currentModel: session.model ? `${session.model.provider}/${session.model.id}` : null,
  })
}

async function model(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  const { session, input } = context
  const models = session.scopedModels.length > 0
    ? session.scopedModels.map((scoped) => scoped.model)
    : session.modelRuntime.getAvailableSnapshot()
  if (input.args.length === 0) {
    const choices = models.slice(0, 128)
    return menuRequest('model', 'model', {
      selected: session.model ? `${session.model.provider}/${session.model.id}` : null,
      models: choices.map((item) => ({
        provider: item.provider,
        id: item.id,
        name: item.name,
        contextWindow: item.contextWindow ?? null,
      })),
      truncated: models.length > choices.length,
    }, {
      kind: 'argument',
      argument: 'model',
      values: choices.map((item) => `${item.provider}/${item.id}`),
    })
  }
  if (input.args.length !== 1) return rejected('model', 'expected-provider-slash-model')
  const reference = input.args[0]!
  const separator = reference.indexOf('/')
  if (separator < 1 || separator === reference.length - 1) return rejected('model', 'expected-provider-slash-model')
  const provider = reference.slice(0, separator)
  const modelId = reference.slice(separator + 1)
  const selected = session.modelRuntime.getModel(provider, modelId)
  if (!selected) return rejected('model', 'model-not-found')
  try {
    await session.setModel(selected, { persist: false })
    return applied('model', jsonObject({ provider, modelId, thinkingLevel: session.thinkingLevel }))
  } catch {
    return rejected('model', 'model-selection-failed')
  }
}

async function thinking(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  const { session, input } = context
  const levels = session.getAvailableThinkingLevels()
  if (input.args.length === 0) {
    return menuRequest('thinking', 'thinking', { current: session.thinkingLevel, levels }, {
      kind: 'argument',
      argument: 'thinking-level',
      values: [...levels],
    })
  }
  if (input.args.length !== 1) return rejected('thinking', 'expected-one-thinking-level')
  const level = levels.find((candidate) => candidate === input.args[0])
  if (!level) return rejected('thinking', 'thinking-level-unavailable')
  session.setThinkingLevel(level, { persist: false })
  return applied('thinking', jsonObject({ thinkingLevel: session.thinkingLevel }))
}

async function scopedModels(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  if (!requireNoArguments(context)) return rejected('scoped-models', 'unexpected-arguments')
  const { session } = context
  const available = session.modelRuntime.getAvailableSnapshot()
  const availableModels = available.slice(0, 128)
  const availableReferences = availableModels.map((model) => `${model.provider}/${model.id}`)
  const sessionScopedModels = session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)
  const enabledPatterns = session.settingsManager.getEnabledModels()
  const initialEnabled = sessionScopedModels.length > 0
    ? sessionScopedModels
    : enabledPatterns?.length
      ? enabledPatterns.filter((reference) => availableReferences.includes(reference))
      : availableReferences
  return menuRequest('scoped-models', 'scoped-models', {
    configuredPatterns: session.settingsManager.getEnabledModels() ?? null,
    sessionScopedModels: session.scopedModels.slice(0, 128).map((scoped) => ({
      reference: `${scoped.model.provider}/${scoped.model.id}`,
      thinkingLevel: scoped.thinkingLevel ?? null,
    })),
    availableModels: availableModels.map((item) => ({
      provider: item.provider,
      id: item.id,
      name: item.name,
    })),
    initialEnabledModelReferences: initialEnabled.slice(0, 128),
    truncated: available.length > availableModels.length || session.scopedModels.length > 128,
  }, {
    kind: 'scoped-models',
    availableModelReferences: availableReferences,
    canPersist: session.settingsManager.isProjectTrusted(),
  })
}

async function login(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  if (context.input.args.length > 1) return rejected('login', 'expected-at-most-one-provider')
  const providers = context.session.modelRuntime.getProviders()
    .filter((provider) => provider.auth.oauth || provider.auth.apiKey)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      oauth: Boolean(provider.auth.oauth),
      apiKey: Boolean(provider.auth.apiKey),
      configured: context.session.modelRuntime.getProviderAuthStatus(provider.id).configured,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const selectedProvider = context.input.args[0]
  if (selectedProvider && !providers.some((provider) => provider.id === selectedProvider)) {
    return rejected('login', 'provider-not-found-or-no-login-method')
  }
  return menuRequest('login', 'login', { selectedProvider: selectedProvider ?? null, providers })
}

async function logout(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  const { session, input } = context
  if (input.args.length > 1) return rejected('logout', 'expected-at-most-one-provider')
  let credentials
  try {
    credentials = await session.modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) })
  } catch {
    return rejected('logout', 'credential-list-unavailable')
  }
  if (input.args.length === 0) {
    return menuRequest('logout', 'logout', {
      credentials: credentials.map(({ providerId, type }) => ({ providerId, type })),
    }, {
      kind: 'argument',
      argument: 'provider-id',
      values: [...new Set(credentials.map(({ providerId }) => providerId))],
    })
  }
  const providerId = input.args[0]!
  if (!session.modelRuntime.getProvider(providerId)) return rejected('logout', 'provider-not-found')
  if (!credentials.some((credential) => credential.providerId === providerId)) {
    return rejected('logout', 'provider-has-no-stored-credentials')
  }
  try {
    await session.modelRuntime.logout(providerId)
    return applied('logout', jsonObject({ providerId, loggedOut: true }))
  } catch {
    return rejected('logout', 'logout-failed')
  }
}

async function trust(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  if (!requireNoArguments(context)) return rejected('trust', 'unexpected-arguments')
  const request: WorkspaceTrustCommandRequest = {
    cwd: context.session.sessionManager.getCwd(),
    projectTrusted: context.session.settingsManager.isProjectTrusted(),
  }
  return {
    type: 'delegated',
    commandName: 'trust',
    target: 'workspace-trust',
    request,
  }
}

async function reload(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  if (!requireNoArguments(context)) return rejected('reload', 'unexpected-arguments')
  if (context.session.isStreaming || context.session.isCompacting) return rejected('reload', 'session-must-be-idle')
  try {
    await context.session.reload()
    return applied('reload', jsonObject({ reloaded: ['extensions', 'skills', 'prompts', 'themes', 'context-files'] }))
  } catch {
    return rejected('reload', 'reload-failed')
  }
}

async function share(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  if (!requireNoArguments(context)) return rejected('share', 'unexpected-arguments')
  const stats = context.session.getSessionStats()
  return effectData('share', 'share-preview', {
    sessionId: stats.sessionId,
    currentModel: context.session.model ? `${context.session.model.provider}/${context.session.model.id}` : null,
    messageCount: stats.totalMessages,
    createdShare: false,
    networkUsed: false,
  })
}

async function bug(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  const hint = context.input.args.join(' ').slice(0, 2048)
  const stats = context.session.getSessionStats()
  return effectData('bug', 'bug-report-data', {
    hint,
    sessionId: stats.sessionId,
    currentModel: context.session.model ? `${context.session.model.provider}/${context.session.model.id}` : null,
    messageCount: stats.totalMessages,
    lastAssistantText: context.session.getLastAssistantText()?.slice(-2048) ?? null,
    tokens: stats.tokens,
    cost: stats.cost,
    submitted: false,
  })
}

async function changelog(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  if (!requireNoArguments(context)) return rejected('changelog', 'unexpected-arguments')
  const allEntries = parseChangelog(getChangelogPath())
  let truncated = allEntries.length > 8
  const entries = allEntries.slice(0, 8).map((entry) => {
    const content = normalizeChangelogLinks(entry.content, entry)
    if (content.length > 3000) truncated = true
    return {
      version: `${entry.major}.${entry.minor}.${entry.patch}`,
      content: content.slice(0, 3000),
    }
  })
  return effectData('changelog', 'package-changelog', { entries }, truncated)
}

async function hotkeys(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  if (!requireNoArguments(context)) return rejected('hotkeys', 'unexpected-arguments')
  const bindings = Object.entries(KEYBINDINGS).map(([action, binding]) => ({
    action,
    keys: binding.defaultKeys,
    description: binding.description,
  }))
  return effectData('hotkeys', 'sdk-keybinding-defaults', { bindings: bindings.slice(0, 128) }, bindings.length > 128)
}

async function quit(context: CoreCommandContext): Promise<NativeCoreCommandOutcome> {
  if (!requireNoArguments(context)) return rejected('quit', 'unexpected-arguments')
  const request: ApplicationQuitCommandRequest = { requested: true }
  return {
    type: 'delegated',
    commandName: 'quit',
    target: 'application-quit',
    request,
  }
}

const handlers: Record<(typeof BUILTIN_SLASH_COMMANDS)[number]['name'], NativeHandler> = {
  settings,
  model,
  tree: sessionEffect,
  thinking,
  'scoped-models': scopedModels,
  export: sessionEffect,
  import: sessionEffect,
  share,
  bug,
  copy: sessionEffect,
  name: sessionEffect,
  session: sessionEffect,
  changelog,
  hotkeys,
  fork: sessionEffect,
  clone: sessionEffect,
  trust,
  login,
  logout,
  new: sessionEffect,
  compact: sessionEffect,
  resume: sessionEffect,
  reload,
  quit,
}

/** Register a core adapter for every SDK builtin slash command. */
export function registerNativeCoreCommandAdapters(
  dispatcher: CommandDispatcher,
  options: NativeCoreCommandAdapterOptions,
): () => void {
  const unregister: Array<() => void> = []
  for (const { name } of BUILTIN_SLASH_COMMANDS) {
    const execute = handlers[name]
    const handler: CoreCommandHandler = async (context) => {
      const sessions = new SessionService(context.session, options.sessionSwitch)
      let outcome: NativeCoreCommandOutcome
      try {
        outcome = context.menuSelection?.kind === 'scoped-models'
          ? selectScopedModels(context, context.menuSelection)
          : await execute(context, sessions)
      } catch {
        outcome = rejected(name, 'native-command-failed')
      }
      const dispatchResponse: CommandEffectDataResponse | CoreCommandMenuRequestResponse | undefined =
        outcome.type === 'effect-data'
          ? {
            outcome: 'effect-data',
            commandName: outcome.commandName,
            effect: outcome.effect,
            data: outcome.data,
            ...(outcome.truncated ? { truncated: true } : {}),
          }
          : outcome.type === 'menu-request'
            ? {
                outcome: 'menu-request',
                commandName: outcome.commandName,
                menu: outcome.menu,
                initialState: outcome.initialState,
                ...(outcome.selection ? { selection: outcome.selection } : {}),
              }
            : undefined
      try {
        await options.outcomeSink.publish(context, outcome)
      } catch {
        // The operation result is already final; a failed UI/event publication cannot roll it back.
      }
      return dispatchResponse
    }
    unregister.push(dispatcher.registerCoreHandler(name, handler))
  }
  return () => {
    for (const unregisterHandler of unregister.reverse()) unregisterHandler()
  }
}
