import type { SettingsDescriptor, SettingsEffect, SettingsReadonlyClass, SettingsValueType, NativeSettingsScope } from '../../shared/settings.ts'

const USER_PROJECT: readonly NativeSettingsScope[] = ['user', 'project']
const USER_ONLY: readonly NativeSettingsScope[] = ['user']
const SESSION_ONLY: readonly NativeSettingsScope[] = ['session']

function descriptor(
  key: string,
  type: SettingsValueType,
  validator: string,
  options: {
    scopes?: readonly NativeSettingsScope[]
    readonly?: SettingsReadonlyClass
    effect?: SettingsEffect
    source?: string
    description?: string
    readonlyReason?: string
  } = {},
): SettingsDescriptor {
  return {
    key,
    scopes: options.scopes ?? USER_PROJECT,
    type,
    validator,
    readonly: options.readonly ?? 'editable',
    effect: options.effect ?? 'new-session',
    source: options.source ?? 'native',
    ...(options.description ? { description: options.description } : {}),
    ...(options.readonlyReason ? { readonlyReason: options.readonlyReason } : {}),
  }
}

function readOnlyNative(key: string, type: SettingsValueType, reason: string, scopes = USER_PROJECT): SettingsDescriptor {
  return descriptor(key, type, 'native-readonly', {
    scopes,
    readonly: 'native-readonly',
    readonlyReason: reason,
  })
}

function extension(
  source: string,
  key: string,
  type: SettingsValueType,
  validator: string,
  scopes: readonly NativeSettingsScope[],
  effect: SettingsEffect,
  readonlyReason: string,
): SettingsDescriptor {
  return descriptor(key, type, validator, {
    source,
    scopes,
    effect,
    readonly: 'native-readonly',
    readonlyReason,
  })
}

const native: SettingsDescriptor[] = [
  descriptor('lastChangelogVersion', 'string', 'string', { scopes: USER_ONLY, readonly: 'read-only', readonlyReason: 'Pi updates this value as changelog state.' }),
  descriptor('defaultProvider', 'string', 'non-empty-string'),
  descriptor('defaultModel', 'string', 'non-empty-string'),
  descriptor('defaultThinkingLevel', 'string', 'thinking-level'),
  descriptor('modelThinkingLevels', 'object', 'string-map-thinking'),
  descriptor('transport', 'string', 'enum:transport'),
  descriptor('steeringMode', 'string', 'enum:steering'),
  descriptor('followUpMode', 'string', 'enum:follow-up'),
  descriptor('theme', 'string', 'string', { effect: 'reload' }),
  descriptor('compaction.enabled', 'boolean', 'boolean', { effect: 'now' }),
  descriptor('compaction.reserveTokens', 'number', 'non-negative-integer', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for compaction token values.', effect: 'now' }),
  descriptor('compaction.keepRecentTokens', 'number', 'non-negative-integer', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for compaction token values.', effect: 'now' }),
  descriptor('compaction.modelOverrides', 'object', 'compaction-model-overrides', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for compaction model overrides.', effect: 'now' }),
  descriptor('branchSummary.reserveTokens', 'number', 'non-negative-integer', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for branchSummary.' }),
  descriptor('branchSummary.skipPrompt', 'boolean', 'boolean', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for branchSummary.' }),
  descriptor('retry.enabled', 'boolean', 'boolean', { effect: 'now' }),
  descriptor('retry.maxRetries', 'number', 'retry-number', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for this retry field.', effect: 'now' }),
  descriptor('retry.baseDelayMs', 'number', 'retry-number', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for this retry field.', effect: 'now' }),
  descriptor('retry.maxAgentDelayMs', 'number', 'retry-number', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for this retry field.', effect: 'now' }),
  descriptor('retry.provider.timeoutMs', 'number', 'http-timeout', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for provider retry fields.', effect: 'now' }),
  descriptor('retry.provider.maxRetries', 'number', 'retry-number', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for provider retry fields.', effect: 'now' }),
  descriptor('retry.provider.maxRetryDelayMs', 'number', 'retry-number', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for provider retry fields.', effect: 'now' }),
  descriptor('hideThinkingBlock', 'boolean', 'boolean', { effect: 'now' }),
  descriptor('showCacheMissNotices', 'boolean', 'boolean', { effect: 'now' }),
  descriptor('externalEditor', 'string', 'string', { readonly: 'read-only', readonlyReason: 'SettingsManager has a getter but no native setter; VISUAL/EDITOR are environment overrides.', effect: 'new-session' }),
  descriptor('shellPath', 'string', 'string', { effect: 'reload' }),
  descriptor('quietStartup', 'boolean|string', 'enum:quiet-startup', { scopes: USER_ONLY }),
  descriptor('defaultProjectTrust', 'string', 'enum:project-trust', { scopes: USER_ONLY, effect: 'new-session' }),
  descriptor('shellCommandPrefix', 'string', 'string', { effect: 'reload' }),
  descriptor('npmCommand', 'string[]', 'string-array', { effect: 'reload' }),
  descriptor('collapseChangelog', 'boolean', 'boolean'),
  descriptor('enableInstallTelemetry', 'boolean', 'boolean', { effect: 'restart' }),
  descriptor('enableAnalytics', 'boolean', 'boolean', { effect: 'restart' }),
  descriptor('trackingId', 'string', 'string', { scopes: USER_ONLY, readonly: 'read-only', readonlyReason: 'Pi generates and manages this analytics identifier.', effect: 'restart' }),
  descriptor('deviceId', 'string', 'string', { scopes: USER_ONLY, readonly: 'read-only', readonlyReason: 'Pi generates and manages this installation identifier.', effect: 'restart' }),
  descriptor('packages', 'array', 'package-sources', { effect: 'reload' }),
  descriptor('extensions', 'string[]', 'string-array', { effect: 'reload' }),
  descriptor('skills', 'string[]', 'string-array', { effect: 'reload' }),
  descriptor('prompts', 'string[]', 'string-array', { effect: 'reload' }),
  descriptor('themes', 'string[]', 'string-array', { effect: 'reload' }),
  descriptor('enableSkillCommands', 'boolean', 'boolean', { effect: 'reload' }),
  descriptor('terminal.showImages', 'boolean', 'boolean', { effect: 'reload' }),
  descriptor('terminal.imageWidthCells', 'number', 'image-width', { effect: 'now', description: 'Reset is unavailable because the native setter clamps and does not safely clear this value.' }),
  descriptor('terminal.clearOnShrink', 'boolean', 'boolean', { effect: 'reload' }),
  descriptor('terminal.showTerminalProgress', 'boolean', 'boolean', { effect: 'now' }),
  descriptor('terminal.hyperlinks', 'unknown', 'boolean-or-auto', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for terminal capability overrides.', effect: 'reload' }),
  descriptor('terminal.images', 'unknown', 'image-mode', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for terminal capability overrides.', effect: 'reload' }),
  descriptor('terminal.trueColor', 'unknown', 'boolean-or-auto', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for terminal capability overrides.', effect: 'reload' }),
  descriptor('images.autoResize', 'boolean', 'boolean', { effect: 'now' }),
  descriptor('images.blockImages', 'boolean', 'boolean', { effect: 'now' }),
  descriptor('enabledModels', 'string[]', 'string-array', { effect: 'reload', description: 'Native model cycling allowlist; model-specific UI is exposed by models.enabled.*.' }),
  descriptor('defaultTools', 'string[]', 'optional-tool-array', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for defaultTools.', effect: 'new-session' }),
  descriptor('doubleEscapeAction', 'string', 'enum:double-escape', { effect: 'now' }),
  descriptor('treeFilterMode', 'string', 'enum:tree-filter', { effect: 'now' }),
  descriptor('thinkingBudgets.minimal', 'number', 'non-negative-integer', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for thinkingBudgets.' }),
  descriptor('thinkingBudgets.low', 'number', 'non-negative-integer', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for thinkingBudgets.' }),
  descriptor('thinkingBudgets.medium', 'number', 'non-negative-integer', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for thinkingBudgets.' }),
  descriptor('thinkingBudgets.high', 'number', 'non-negative-integer', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for thinkingBudgets.' }),
  descriptor('editorPaddingX', 'number', 'editor-padding', { effect: 'now' }),
  descriptor('outputPad', 'number', 'output-pad', { effect: 'now' }),
  descriptor('autocompleteMaxVisible', 'number', 'autocomplete-limit', { effect: 'now' }),
  descriptor('showHardwareCursor', 'boolean', 'boolean', { effect: 'reload' }),
  descriptor('markdown.codeBlockIndent', 'string', 'string', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for markdown.codeBlockIndent.' }),
  descriptor('markdown.mermaid', 'string', 'enum:mermaid', { effect: 'reload' }),
  descriptor('warnings.anthropicExtraUsage', 'boolean', 'boolean', { effect: 'now', description: 'Updated through the native warnings setter while preserving other warning fields.' }),
  descriptor('codemode.mode', 'string', 'enum:codemode-mode', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for codemode.' }),
  descriptor('codemode.inlineBudget', 'number', 'positive-integer', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for codemode.' }),
  descriptor('sessionDir', 'string', 'string', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for sessionDir.', effect: 'restart' }),
  descriptor('httpProxy', 'string', 'string', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for httpProxy.', effect: 'restart' }),
  descriptor('httpIdleTimeoutMs', 'number', 'http-timeout', { effect: 'now' }),
  descriptor('cacheWarming', 'string', 'enum:cache-warming', { scopes: USER_ONLY, effect: 'now' }),
  descriptor('websocketConnectTimeoutMs', 'number', 'http-timeout', { readonly: 'read-only', readonlyReason: 'SettingsManager exposes no native setter for websocketConnectTimeoutMs.', effect: 'now' }),
  descriptor('tuiMode', 'string', 'enum:tui-mode', { effect: 'reload' }),
  descriptor('fullscreenExitOutput', 'string', 'enum:fullscreen-exit', { effect: 'reload' }),
  descriptor('fullscreenScrollbar', 'string', 'enum:scrollbar', { effect: 'now' }),
  descriptor('fullscreenCopyOnSelect', 'boolean', 'boolean', { effect: 'now' }),
  descriptor('fullscreenWheelScrollLines', 'number|string', 'enum:scroll-lines', { effect: 'now' }),
  descriptor('models.scoped', 'object', 'scoped-models', {
    scopes: SESSION_ONLY,
    effect: 'now',
    description: 'Active-session model cycle scope; managed by the native models service, not persisted in settings.json.',
  }),
  readOnlyNative('mcp.servers', 'object', 'MCP servers are stored in native mcp.json and edited by the dedicated MCP provider, not SettingsManager.'),
  readOnlyNative('keybindings', 'object', 'Pi keybindings use the separate keybindings store; no settings-manager editor is available.'),
  readOnlyNative('environment', 'object', 'Environment and CLI overrides are not writable through SettingsManager; only native provenance is reported.'),
]

const herdr = [
  ['config.status.enabled', 'boolean', 'boolean'],
  ['config.models.default', 'string', 'non-empty-string'],
  ['config.models.agents', 'object', 'string-map'],
  ['config.models.tasks', 'object', 'object'],
  ['config.models.tasksMeta', 'object', 'object'],
  ['config.roles.bundled', 'boolean', 'boolean'],
  ['config.persistent.maxAgents', 'number', 'positive-integer'],
  ['config.supervision.forcePolling', 'boolean', 'boolean'],
  ['config.supervision.hangWarningMinutes', 'number', 'non-negative-integer'],
  ['config.panes.mode', 'string', 'enum:herdr-pane-mode'],
  ['config.panes.direction', 'string', 'enum:herdr-pane-direction'],
  ['config.panes.maxPerTab', 'number', 'positive-integer'],
] as const

const herdrDefinitionFields = [
  ['name', 'non-empty-string'], ['description', 'herdr-scalar'], ['model', 'non-empty-string'],
  ['tools', 'herdr-scalar'], ['system-prompt', 'enum:herdr-system-prompt'], ['skills', 'herdr-scalar'],
  ['skill', 'herdr-scalar'], ['thinking', 'enum:herdr-thinking'], ['deny-tools', 'herdr-scalar'],
  ['spawning', 'enum:herdr-boolean'], ['persistent', 'enum:herdr-boolean'], ['auto-exit', 'enum:herdr-boolean'],
  ['interactive', 'enum:herdr-boolean'], ['session-mode', 'enum:herdr-session-mode'], ['cwd', 'herdr-scalar'],
  ['disable-model-invocation', 'enum:herdr-boolean'],
] as const

const tintinwebSubagents = [
  ['maxConcurrent', 'number', 'positive-integer'], ['maxConcurrentForeground', 'number', 'non-negative-integer'],
  ['defaultMaxTurns', 'number', 'non-negative-integer'], ['graceTurns', 'number', 'positive-integer'],
  ['defaultJoinMode', 'string', 'enum:subagents-join'], ['backgroundByDefault', 'boolean', 'boolean'],
  ['schedulingEnabled', 'boolean', 'boolean'], ['scopeModels', 'boolean', 'boolean'], ['strictAgentFiles', 'boolean', 'boolean'],
  ['disableDefaultAgents', 'boolean', 'boolean'], ['toolDescriptionMode', 'string', 'enum:subagents-description'],
  ['fleetView', 'boolean', 'boolean'], ['agentMentions', 'string', 'enum:subagents-mentions'], ['rememberAgents', 'boolean', 'boolean'],
  ['widgetMode', 'string', 'enum:subagents-widget'], ['outputTranscript', 'boolean', 'boolean'], ['worktreeIsolation', 'boolean', 'boolean'],
  ['workflowsEnabled', 'boolean', 'boolean'], ['maxSubagentDepth', 'number', 'non-negative-integer'],
  ['fallbackSubagent', 'string', 'string-or-false'], ['reportUsage', 'boolean', 'boolean'], ['showCost', 'boolean', 'boolean'],
  ['showModel', 'boolean', 'boolean'], ['viewerMarkdown', 'string', 'enum:subagents-markdown'],
] as const

const piPretty = [
  ['background', 'string'], ['theme', 'string'], ['icons', 'object'], ['enabledTools', 'string[]'],
  ['disabledTools', 'string[]'], ['highlighting', 'object'], ['preview', 'object'], ['cache', 'object'],
  ['workingIndicator', 'object'], ['thinkingIndicator', 'object'], ['fffHomeScan', 'boolean'], ['fffRootScan', 'boolean'],
] as const

const multiAccount = [
  ['routing', 'object'], ['failover', 'object'], ['accounts', 'object'], ['priority', 'string[]'],
  ['limits', 'object'], ['pins', 'object'], ['onlyActive', 'boolean'], ['enabled', 'boolean'],
] as const

const powerline = [
  ['powerline', 'object'], ['powerlineShortcuts', 'object'], ['bashMode', 'object'],
  ['compaction-policy.json', 'object'], ['stash-history', 'object'],
] as const

const extensionDescriptors: SettingsDescriptor[] = [
  ...herdr.map(([key, type, validator]) => descriptor(key, type, validator, {
    source: 'pi-herdr-agents', scopes: key.startsWith('config.') ? USER_ONLY : USER_PROJECT,
    effect: 'reload', readonly: 'editable',
    description: 'Managed by the Herdr settings provider; the config file is user-scoped.',
  })),
  ...herdrDefinitionFields.map(([key, validator]) => descriptor(`herdr.definitions.{name}.${key}`, 'string', validator, {
    source: 'pi-herdr-agents', scopes: USER_PROJECT, effect: 'new-session', readonly: 'editable',
    description: 'Template for a native Pi agent definition frontmatter field; {name} is the exact Herdr definition name.',
  })),
  ...tintinwebSubagents.map(([key, type, validator]) => descriptor(`subagents.${key}`, type, validator, {
    source: '@tintinweb/pi-subagents',
    scopes: USER_PROJECT,
    effect: key === 'schedulingEnabled' || key === 'toolDescriptionMode' || key === 'workflowsEnabled' ? 'new-session' : 'now',
    readonly: 'editable',
    description: 'User defaults remain manually managed; the scoped provider edits only the project subagents.json file.',
  })),
  ...piPretty.map(([key, type]) => extension(
    '@heyhuynhgiabuu/pi-pretty', `pi-pretty.${key}`, type, 'native-readonly', USER_ONLY, 'reload',
    'The durable pi-pretty.json store has no installed desktop settings adapter; the surface is described but not edited here.',
  )),
  ...multiAccount.map(([key, type]) => extension(
    'pi-multi-account', `multi-account.${key}`, type, 'native-readonly', USER_PROJECT, 'reload',
    'pi-multi-account owns its routing/account configuration and runtime state; no source-backed desktop provider adapter is registered.',
  )),
  ...powerline.map(([key, type]) => extension(
    'pi-powerline-footer', `powerline.${key}`, type, 'native-readonly',
    key === 'compaction-policy.json' || key === 'stash-history' ? USER_ONLY : USER_PROJECT, 'reload',
    'Powerline owns these extension settings/stores; SettingsManager preserves the extension-owned keys but does not expose setters for them.',
  )),
]

export const SETTINGS_DESCRIPTORS: readonly SettingsDescriptor[] = Object.freeze([...native, ...extensionDescriptors])
export const SETTINGS_DESCRIPTOR_BY_KEY: ReadonlyMap<string, SettingsDescriptor> = new Map(
  SETTINGS_DESCRIPTORS.map((entry) => [entry.key, entry]),
)
