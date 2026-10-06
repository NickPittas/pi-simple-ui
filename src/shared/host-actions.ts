import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

/** Host-owned adapters for installed extension commands. These IDs never replace Pi commands. */
export const HOST_ACTIONS = Object.freeze({
  intercom: Object.freeze({
    sessionsList: 'intercom.sessions-list',
    overlayState: 'intercom.overlay-state',
    editorInsert: 'intercom.editor-insert',
    editorInserted: 'intercom.editor-inserted',
    aliasPersist: 'intercom.alias-persist',
    transportStatus: 'intercom.transport-status',
  } as const),
  preview: Object.freeze({
    markdownRender: 'preview.markdown-render',
    browserOpen: 'preview.browser-open',
    pdfExport: 'preview.pdf-export',
    cacheClear: 'preview.cache-clear',
  } as const),
  powerline: Object.freeze({
    queueRead: 'powerline.queue-read',
    queueClear: 'powerline.queue-clear',
    stashHistoryRead: 'powerline.stash-history-read',
    settingsRead: 'powerline.settings-read',
    settingsWrite: 'powerline.settings-write',
    statusRead: 'powerline.status-read',
  } as const),
  tasks: Object.freeze({
    listRead: 'tasks.list-read',
    itemRead: 'tasks.item-read',
    statusRead: 'tasks.status-read',
  } as const),
  fff: Object.freeze({
    modeRead: 'fff.mode-read',
    healthRead: 'fff.health-read',
    rescan: 'fff.rescan',
  } as const),
  quota: Object.freeze({
    statusRead: 'quota.status-read',
    usageFetch: 'quota.usage-fetch',
    harExtract: 'quota.har-extract',
  } as const),
  webAccess: Object.freeze({
    cachedResultsRead: 'web-access.cached-results-read',
    searchRun: 'web-access.search-run',
    curatorOpen: 'web-access.curator-open',
    curatorStatusRead: 'web-access.curator-status-read',
    googleAccountStatus: 'web-access.google-account-status',
  } as const),
  multiAccount: Object.freeze({
    accountsRead: 'multi-account.accounts-read',
    routingRead: 'multi-account.routing-read',
    failoverStatusRead: 'multi-account.failover-status-read',
  } as const),
} as const)

export const HOST_ACTION_CONSENT = Object.freeze({
  [HOST_ACTIONS.quota.usageFetch]: Object.freeze({
    requiresConsent: true,
    consentLabel: 'Fetch quota usage from the selected provider now.',
  } as const),
  [HOST_ACTIONS.quota.harExtract]: Object.freeze({
    requiresConsent: true,
    consentLabel: 'Read this HAR locally and optionally verify extracted quota credentials with the provider.',
  } as const),
  [HOST_ACTIONS.webAccess.searchRun]: Object.freeze({
    requiresConsent: true,
    consentLabel: 'Send this search to the configured external web-search provider(s).',
  } as const),
  [HOST_ACTIONS.webAccess.googleAccountStatus]: Object.freeze({
    requiresConsent: true,
    consentLabel: 'Read local browser cookies and contact Google to identify the active account.',
  } as const),
} as const)

export interface EmptyHostActionRequest {}

export interface IntercomSessionSummary {
  readonly id: string
  readonly name?: string
  readonly cwd?: string
  readonly state?: 'active' | 'idle' | 'unknown'
}

export interface IntercomSessionsListResponse {
  readonly sessions: readonly IntercomSessionSummary[]
}

export interface IntercomOverlayStateResponse {
  readonly open: boolean
  readonly selectedSessionId?: string
}

export interface IntercomEditorInsertRequest {
  readonly insertion: 'append' | 'replace'
}

export interface IntercomEditorInsertedPayload {
  readonly text: string
  readonly insertion: 'append' | 'replace'
}

export interface IntercomEditorInsertResponse {
  readonly inserted: boolean
}

export interface IntercomAliasPersistRequest {
  readonly alias: string
}

export interface IntercomAliasPersistResponse {
  readonly saved: boolean
}

export interface IntercomTransportStatusResponse {
  readonly state: 'connected' | 'connecting' | 'disconnected' | 'unknown'
  readonly localBrokerAvailable: boolean
}

export interface PreviewMarkdownRenderRequest {
  readonly markdown: string
}

export interface PreviewMarkdownRenderResponse {
  readonly previewId: string
  readonly rendered: boolean
}

export interface PreviewBrowserOpenRequest {
  readonly previewId: string
  /** True only for a direct user gesture; the host only opens its own generated local file. */
  readonly userInitiated: true
}

export interface PreviewBrowserOpenResponse {
  readonly opened: boolean
  readonly status: 'opened' | 'requires-runtime-bridge' | 'failed'
}

export interface PreviewPdfExportRequest {
  readonly markdown: string
}

export interface PreviewPdfExportResponse {
  readonly opened: boolean
  readonly status: 'exported' | 'requires-runtime-bridge' | 'failed'
}

export interface PreviewCacheClearResponse {
  readonly cleared: boolean
}

export interface PowerlineQueueReadResponse {
  readonly steering: readonly string[]
  readonly followUp: readonly string[]
  readonly pending: number
}

export interface PowerlineQueueClearResponse {
  readonly cleared: PowerlineQueueReadResponse
}

export interface PowerlineStashHistoryResponse {
  readonly history: readonly string[]
}

export type PowerlinePreset = 'default' | 'minimal' | 'compact' | 'full' | 'nerd' | 'ascii'
export type PowerlineSeparator = 'powerline' | 'powerline-thin' | 'slash' | 'pipe' | 'block' | 'none' | 'ascii' | 'dot' | 'chevron' | 'star'
export type PowerlineSegment =
  | 'model' | 'shell_mode' | 'path' | 'git' | 'subagents' | 'queue'
  | 'token_in' | 'token_out' | 'token_total' | 'cost' | 'context_pct'
  | 'context_total' | 'time_spent' | 'time' | 'session' | 'hostname'
  | 'cache_read' | 'cache_write' | 'thinking' | 'extension_statuses'

/** Deliberately allowlisted subset of pi-powerline-footer's native settings. */
export interface PowerlineSettings {
  readonly preset?: PowerlinePreset
  readonly placement?: 'above' | 'below'
  readonly separator?: PowerlineSeparator
  readonly disabledSegments?: readonly PowerlineSegment[]
  readonly welcome?: boolean
  readonly stashSharpSShortcut?: boolean
  readonly compactPromptMode?: 'queue' | 'native'
  readonly sendDelayMs?: number
  readonly autoFollowUp?: boolean
}

export interface PowerlineSettingsReadResponse {
  readonly settings: PowerlineSettings
}

export interface PowerlineSettingsWriteRequest {
  readonly patch: PowerlineSettings
}

export interface PowerlineSettingsWriteResponse {
  readonly saved: boolean
}

export interface PowerlineStatusReadRequest {
  readonly field: 'title' | 'model' | 'cwd'
}

export interface PowerlineStatusReadResponse {
  readonly field: 'title' | 'model' | 'cwd'
  readonly value: string
}

export type InstalledTaskStatus = 'pending' | 'in_progress' | 'completed'
export interface InstalledTaskSummary {
  readonly id: string
  readonly subject: string
  readonly description: string
  readonly status: InstalledTaskStatus
  readonly activeForm?: string
  readonly owner?: string
  readonly blocks: readonly string[]
  readonly blockedBy: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}
export type TasksBackingStore = 'file' | 'memory' | 'unavailable'
export interface TasksListReadRequest {
  readonly limit?: number
  readonly status?: InstalledTaskStatus
}
export interface TasksListReadResponse {
  readonly tasks: readonly InstalledTaskSummary[]
  readonly total: number
  readonly truncated: boolean
  readonly store: TasksBackingStore
  readonly mutationDispatchHint: '/tasks'
}
export interface TasksItemReadRequest { readonly id: string }
export interface TasksItemReadResponse {
  readonly task: InstalledTaskSummary | null
  readonly store: TasksBackingStore
  readonly mutationDispatchHint: '/tasks'
}
export interface TasksStatusReadResponse {
  readonly store: TasksBackingStore
  readonly total: number
  readonly pending: number
  readonly inProgress: number
  readonly completed: number
  readonly mutationDispatchHint: '/tasks'
}

export type FffMode = 'tools-and-ui' | 'tools-only' | 'override'
export interface FffModeReadResponse { readonly mode: FffMode }
export interface FffHealthReadResponse {
  readonly available: boolean
  readonly version?: string
  readonly mode: FffMode
  readonly scanning: boolean
  readonly scannedFiles?: number
  readonly indexedFiles?: number
  readonly gitRepositoryFound?: boolean
  readonly frecencyActive?: boolean
  readonly queryTrackerActive?: boolean
}
export interface FffRescanResponse {
  readonly status: 'started' | 'cooldown' | 'already-scanning' | 'unavailable' | 'failed'
  readonly cooldownMs: number
}

export type QuotaProvider = 'openai-codex' | 'opencode-go' | 'anthropic' | 'claude-bridge' | 'zai'
export interface QuotaWindowUsage {
  readonly remainingPct: number
  readonly resetAt: string | null
}
export interface QuotaUsage {
  readonly fiveHour: QuotaWindowUsage | null
  readonly weekly: QuotaWindowUsage | null
}
export interface QuotaStatusReadResponse {
  readonly provider: string | null
  readonly status: 'ok' | 'partial' | 'unsupported' | 'unknown'
  readonly display?: string
  readonly usage?: QuotaUsage
}
export interface QuotaConsentRequest {
  readonly consent: true
  readonly consentLabel: typeof HOST_ACTION_CONSENT[typeof HOST_ACTIONS.quota.usageFetch]['consentLabel']
  readonly provider?: QuotaProvider
}
export interface QuotaUsageFetchResponse {
  readonly provider: string
  readonly status: 'ok' | 'partial' | 'unsupported' | 'unknown'
  readonly display?: string
  readonly usage?: QuotaUsage
}
export interface QuotaHarExtractRequest {
  readonly harContent: string
  readonly verify: boolean
  readonly consent: true
  readonly consentLabel: typeof HOST_ACTION_CONSENT[typeof HOST_ACTIONS.quota.harExtract]['consentLabel']
}
export interface QuotaHarExtractResponse {
  readonly valid: boolean
  readonly detected: boolean
  readonly provider?: 'anthropic-subscription'
  readonly verified: 'verified' | 'not-verified' | 'not-requested'
}

export interface WebCachedResult {
  readonly id: string
  readonly type: 'search' | 'fetch' | 'research'
  readonly timestamp: number
  readonly title: string
  readonly summary: string
}
export interface WebCachedResultsReadRequest { readonly limit?: number }
export interface WebCachedResultsReadResponse { readonly results: readonly WebCachedResult[] }
export interface WebSearchRunRequest {
  readonly queries: readonly string[]
  readonly consent: true
  readonly consentLabel: typeof HOST_ACTION_CONSENT[typeof HOST_ACTIONS.webAccess.searchRun]['consentLabel']
}
export interface WebSearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
}
export interface WebSearchRunResponse {
  readonly provider: string
  readonly results: readonly WebSearchResult[]
}
export interface WebCuratorOpenResponse { readonly opened: boolean }
export interface WebCuratorStatusResponse {
  readonly active: boolean
  readonly phase: 'idle' | 'searching' | 'curating' | 'unknown'
  readonly progress?: number
}
export interface WebGoogleAccountStatusRequest {
  readonly consent: true
  readonly consentLabel: typeof HOST_ACTION_CONSENT[typeof HOST_ACTIONS.webAccess.googleAccountStatus]['consentLabel']
}
export interface WebGoogleAccountStatusResponse {
  readonly available: boolean
  readonly email?: string
}

export interface MultiAccountSummary {
  readonly provider: string
  /** Identifier derived from the auth.json key name, never from credential contents. */
  readonly accountId: string
}
export interface MultiAccountAccountsReadResponse { readonly accounts: readonly MultiAccountSummary[] }
export interface MultiAccountRoutingReadResponse {
  readonly enabled: boolean
  readonly routeSource: 'multi-account' | 'native' | 'unknown'
  readonly provider?: string
  readonly model?: string
  readonly accountId?: string
}
export interface MultiAccountFailoverStatusResponse {
  readonly enabled: boolean
  readonly autoContinue: boolean
  readonly providerOrder: readonly string[]
  readonly cooldowns: readonly { readonly provider: string; readonly until: number }[]
  readonly invalidatedProviders: readonly string[]
  readonly lastSwitch?: { readonly fromProvider: string; readonly toProvider: string; readonly at: number }
}

export interface HostActionCapabilityContracts {
  'intercom.sessions-list': { readonly request: EmptyHostActionRequest; readonly response: IntercomSessionsListResponse }
  'intercom.overlay-state': { readonly request: EmptyHostActionRequest; readonly response: IntercomOverlayStateResponse }
  'intercom.editor-insert': { readonly request: IntercomEditorInsertRequest; readonly response: IntercomEditorInsertResponse }
  'intercom.alias-persist': { readonly request: IntercomAliasPersistRequest; readonly response: IntercomAliasPersistResponse }
  'intercom.transport-status': { readonly request: EmptyHostActionRequest; readonly response: IntercomTransportStatusResponse }
  'preview.markdown-render': { readonly request: PreviewMarkdownRenderRequest; readonly response: PreviewMarkdownRenderResponse }
  'preview.browser-open': { readonly request: PreviewBrowserOpenRequest; readonly response: PreviewBrowserOpenResponse }
  'preview.pdf-export': { readonly request: PreviewPdfExportRequest; readonly response: PreviewPdfExportResponse }
  'preview.cache-clear': { readonly request: EmptyHostActionRequest; readonly response: PreviewCacheClearResponse }
  'powerline.queue-read': { readonly request: EmptyHostActionRequest; readonly response: PowerlineQueueReadResponse }
  'powerline.queue-clear': { readonly request: EmptyHostActionRequest; readonly response: PowerlineQueueClearResponse }
  'powerline.stash-history-read': { readonly request: EmptyHostActionRequest; readonly response: PowerlineStashHistoryResponse }
  'powerline.settings-read': { readonly request: EmptyHostActionRequest; readonly response: PowerlineSettingsReadResponse }
  'powerline.settings-write': { readonly request: PowerlineSettingsWriteRequest; readonly response: PowerlineSettingsWriteResponse }
  'powerline.status-read': { readonly request: PowerlineStatusReadRequest; readonly response: PowerlineStatusReadResponse }
  'tasks.list-read': { readonly request: TasksListReadRequest; readonly response: TasksListReadResponse }
  'tasks.item-read': { readonly request: TasksItemReadRequest; readonly response: TasksItemReadResponse }
  'tasks.status-read': { readonly request: EmptyHostActionRequest; readonly response: TasksStatusReadResponse }
  'fff.mode-read': { readonly request: EmptyHostActionRequest; readonly response: FffModeReadResponse }
  'fff.health-read': { readonly request: EmptyHostActionRequest; readonly response: FffHealthReadResponse }
  'fff.rescan': { readonly request: EmptyHostActionRequest; readonly response: FffRescanResponse }
  'quota.status-read': { readonly request: EmptyHostActionRequest; readonly response: QuotaStatusReadResponse }
  'quota.usage-fetch': { readonly request: QuotaConsentRequest; readonly response: QuotaUsageFetchResponse }
  'quota.har-extract': { readonly request: QuotaHarExtractRequest; readonly response: QuotaHarExtractResponse }
  'web-access.cached-results-read': { readonly request: WebCachedResultsReadRequest; readonly response: WebCachedResultsReadResponse }
  'web-access.search-run': { readonly request: WebSearchRunRequest; readonly response: WebSearchRunResponse }
  'web-access.curator-open': { readonly request: EmptyHostActionRequest; readonly response: WebCuratorOpenResponse }
  'web-access.curator-status-read': { readonly request: EmptyHostActionRequest; readonly response: WebCuratorStatusResponse }
  'web-access.google-account-status': { readonly request: WebGoogleAccountStatusRequest; readonly response: WebGoogleAccountStatusResponse }
  'multi-account.accounts-read': { readonly request: EmptyHostActionRequest; readonly response: MultiAccountAccountsReadResponse }
  'multi-account.routing-read': { readonly request: EmptyHostActionRequest; readonly response: MultiAccountRoutingReadResponse }
  'multi-account.failover-status-read': { readonly request: EmptyHostActionRequest; readonly response: MultiAccountFailoverStatusResponse }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends HostActionCapabilityContracts {}
  interface IpcEventContracts {
    'intercom.editor-inserted': { readonly payload: IntercomEditorInsertedPayload }
  }
}

export const HOST_ACTION_LIMITS = Object.freeze({
  markdownCharacters: 200_000,
  previewHtmlBytes: 1_000_000,
  aliasCharacters: 120,
  sessionCount: 200,
  sessionIdCharacters: 256,
  sessionNameCharacters: 160,
  cwdCharacters: 4096,
  editorTextCharacters: 20_000,
  stashHistoryCount: 12,
  stashHistoryCharacters: 20_000,
  settingsSegments: 32,
  statusCharacters: 2048,
  tasksCount: 500,
  taskIdCharacters: 128,
  taskSubjectCharacters: 1024,
  taskDescriptionCharacters: 16_000,
  taskDependencyCount: 128,
  quotaHarCharacters: 5_000_000,
  quotaDisplayCharacters: 2048,
  webQueryCount: 4,
  webQueryCharacters: 2000,
  webResultCount: 100,
  webTextCharacters: 4096,
  accountCount: 200,
  providerCharacters: 128,
})

export function isEmptyHostActionRequest(value: unknown): value is EmptyHostActionRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

export function isIntercomSessionsListResponse(value: unknown): value is IntercomSessionsListResponse {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['sessions']) || !Array.isArray(value.sessions)
    || value.sessions.length > HOST_ACTION_LIMITS.sessionCount) return false
  return value.sessions.every((session) => isPlainRecord(session)
    && hasExactKeys(session, [
      'id',
      ...(Object.hasOwn(session, 'name') ? ['name'] : []),
      ...(Object.hasOwn(session, 'cwd') ? ['cwd'] : []),
      ...(Object.hasOwn(session, 'state') ? ['state'] : []),
    ])
    && typeof session.id === 'string'
    && session.id.length > 0
    && session.id.length <= HOST_ACTION_LIMITS.sessionIdCharacters
    && (!Object.hasOwn(session, 'name') || (typeof session.name === 'string' && session.name.length <= HOST_ACTION_LIMITS.sessionNameCharacters))
    && (!Object.hasOwn(session, 'cwd') || (typeof session.cwd === 'string' && session.cwd.length <= HOST_ACTION_LIMITS.cwdCharacters))
    && (!Object.hasOwn(session, 'state') || session.state === 'active' || session.state === 'idle' || session.state === 'unknown'))
}

export function isIntercomOverlayStateResponse(value: unknown): value is IntercomOverlayStateResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, Object.hasOwn(value, 'selectedSessionId') ? ['open', 'selectedSessionId'] : ['open'])
    && typeof value.open === 'boolean'
    && (!Object.hasOwn(value, 'selectedSessionId')
      || (typeof value.selectedSessionId === 'string' && value.selectedSessionId.length <= HOST_ACTION_LIMITS.sessionIdCharacters))
}

export function isIntercomEditorInsertRequest(value: unknown): value is IntercomEditorInsertRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['insertion']) && (value.insertion === 'append' || value.insertion === 'replace')
}

export function isIntercomEditorInsertedPayload(value: unknown): value is IntercomEditorInsertedPayload {
  return isPlainRecord(value)
    && hasExactKeys(value, ['text', 'insertion'])
    && typeof value.text === 'string'
    && value.text.length > 0
    && value.text.length <= HOST_ACTION_LIMITS.editorTextCharacters
    && (value.insertion === 'append' || value.insertion === 'replace')
}

export function isIntercomEditorInsertResponse(value: unknown): value is IntercomEditorInsertResponse {
  return isPlainRecord(value) && hasExactKeys(value, ['inserted']) && typeof value.inserted === 'boolean'
}

export function isIntercomAliasPersistRequest(value: unknown): value is IntercomAliasPersistRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['alias'])
    && typeof value.alias === 'string'
    && value.alias.trim().length > 0
    && value.alias.length <= HOST_ACTION_LIMITS.aliasCharacters
    && !/[\u0000-\u001f\u007f]/.test(value.alias)
}

export function isIntercomAliasPersistResponse(value: unknown): value is IntercomAliasPersistResponse {
  return isPlainRecord(value) && hasExactKeys(value, ['saved']) && typeof value.saved === 'boolean'
}

export function isIntercomTransportStatusResponse(value: unknown): value is IntercomTransportStatusResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['state', 'localBrokerAvailable'])
    && ['connected', 'connecting', 'disconnected', 'unknown'].includes(value.state as string)
    && typeof value.localBrokerAvailable === 'boolean'
}

export function isPreviewMarkdownRenderRequest(value: unknown): value is PreviewMarkdownRenderRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['markdown'])
    && typeof value.markdown === 'string'
    && value.markdown.length <= HOST_ACTION_LIMITS.markdownCharacters
}

export function isPreviewMarkdownRenderResponse(value: unknown): value is PreviewMarkdownRenderResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['previewId', 'rendered'])
    && typeof value.previewId === 'string'
    && /^[a-f0-9-]{36}$/.test(value.previewId)
    && typeof value.rendered === 'boolean'
}

export function isPreviewBrowserOpenRequest(value: unknown): value is PreviewBrowserOpenRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['previewId', 'userInitiated'])
    && typeof value.previewId === 'string'
    && /^[a-f0-9-]{36}$/.test(value.previewId)
    && value.userInitiated === true
}

export function isPreviewBrowserOpenResponse(value: unknown): value is PreviewBrowserOpenResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['opened', 'status'])
    && typeof value.opened === 'boolean'
    && ['opened', 'requires-runtime-bridge', 'failed'].includes(value.status as string)
}

export function isPreviewPdfExportRequest(value: unknown): value is PreviewPdfExportRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['markdown'])
    && typeof value.markdown === 'string'
    && value.markdown.length <= HOST_ACTION_LIMITS.markdownCharacters
}

export function isPreviewPdfExportResponse(value: unknown): value is PreviewPdfExportResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['opened', 'status'])
    && typeof value.opened === 'boolean'
    && ['exported', 'requires-runtime-bridge', 'failed'].includes(value.status as string)
}

export function isPreviewCacheClearResponse(value: unknown): value is PreviewCacheClearResponse {
  return isPlainRecord(value) && hasExactKeys(value, ['cleared']) && typeof value.cleared === 'boolean'
}

export function isPowerlineQueueReadResponse(value: unknown): value is PowerlineQueueReadResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['steering', 'followUp', 'pending'])
    && Array.isArray(value.steering)
    && value.steering.every((text) => typeof text === 'string')
    && Array.isArray(value.followUp)
    && value.followUp.every((text) => typeof text === 'string')
    && Number.isSafeInteger(value.pending)
    && (value.pending as number) >= 0
}

export function isPowerlineQueueClearResponse(value: unknown): value is PowerlineQueueClearResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['cleared'])
    && isPowerlineQueueReadResponse(value.cleared)
}

export function isPowerlineStashHistoryResponse(value: unknown): value is PowerlineStashHistoryResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['history'])
    && Array.isArray(value.history)
    && value.history.length <= HOST_ACTION_LIMITS.stashHistoryCount
    && value.history.every((entry) => typeof entry === 'string' && entry.length <= HOST_ACTION_LIMITS.stashHistoryCharacters)
}

const POWERLINE_PRESETS: readonly string[] = ['default', 'minimal', 'compact', 'full', 'nerd', 'ascii']
const POWERLINE_SEPARATORS: readonly string[] = ['powerline', 'powerline-thin', 'slash', 'pipe', 'block', 'none', 'ascii', 'dot', 'chevron', 'star']
const POWERLINE_SEGMENTS: readonly string[] = [
  'model', 'shell_mode', 'path', 'git', 'subagents', 'queue', 'token_in', 'token_out', 'token_total', 'cost',
  'context_pct', 'context_total', 'time_spent', 'time', 'session', 'hostname', 'cache_read', 'cache_write', 'thinking', 'extension_statuses',
]

function validatePowerlineSettings(value: unknown, allowEmpty: boolean): value is PowerlineSettings {
  if (!isPlainRecord(value)) return false
  const allowedKeys = ['preset', 'placement', 'separator', 'disabledSegments', 'welcome', 'stashSharpSShortcut', 'compactPromptMode', 'sendDelayMs', 'autoFollowUp']
  if (Object.keys(value).some((key) => !allowedKeys.includes(key)) || (!allowEmpty && Object.keys(value).length === 0)) return false
  return (!Object.hasOwn(value, 'preset') || POWERLINE_PRESETS.includes(value.preset as string))
    && (!Object.hasOwn(value, 'placement') || value.placement === 'above' || value.placement === 'below')
    && (!Object.hasOwn(value, 'separator') || POWERLINE_SEPARATORS.includes(value.separator as string))
    && (!Object.hasOwn(value, 'disabledSegments')
      || (Array.isArray(value.disabledSegments)
        && value.disabledSegments.length <= HOST_ACTION_LIMITS.settingsSegments
        && value.disabledSegments.every((segment) => POWERLINE_SEGMENTS.includes(segment as string))))
    && (!Object.hasOwn(value, 'welcome') || typeof value.welcome === 'boolean')
    && (!Object.hasOwn(value, 'stashSharpSShortcut') || typeof value.stashSharpSShortcut === 'boolean')
    && (!Object.hasOwn(value, 'compactPromptMode') || value.compactPromptMode === 'queue' || value.compactPromptMode === 'native')
    && (!Object.hasOwn(value, 'sendDelayMs')
      || (typeof value.sendDelayMs === 'number' && Number.isSafeInteger(value.sendDelayMs) && value.sendDelayMs >= 0 && value.sendDelayMs <= 30_000))
    && (!Object.hasOwn(value, 'autoFollowUp') || typeof value.autoFollowUp === 'boolean')
}

export function isPowerlineSettingsReadResponse(value: unknown): value is PowerlineSettingsReadResponse {
  return isPlainRecord(value) && hasExactKeys(value, ['settings']) && validatePowerlineSettings(value.settings, true)
}

export function isPowerlineSettingsWriteRequest(value: unknown): value is PowerlineSettingsWriteRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['patch']) && validatePowerlineSettings(value.patch, false)
}

export function isPowerlineSettingsWriteResponse(value: unknown): value is PowerlineSettingsWriteResponse {
  return isPlainRecord(value) && hasExactKeys(value, ['saved']) && typeof value.saved === 'boolean'
}

export function isPowerlineStatusReadRequest(value: unknown): value is PowerlineStatusReadRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['field'])
    && (value.field === 'title' || value.field === 'model' || value.field === 'cwd')
}

export function isPowerlineStatusReadResponse(value: unknown): value is PowerlineStatusReadResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['field', 'value'])
    && (value.field === 'title' || value.field === 'model' || value.field === 'cwd')
    && typeof value.value === 'string'
    && value.value.length <= HOST_ACTION_LIMITS.statusCharacters
}

const TASK_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']
const TASK_STORES: readonly string[] = ['file', 'memory', 'unavailable']

function isInstalledTaskSummary(value: unknown): value is InstalledTaskSummary {
  if (!isPlainRecord(value)) return false
  const keys = [
    'id', 'subject', 'description', 'status', 'blocks', 'blockedBy', 'createdAt', 'updatedAt',
    ...(Object.hasOwn(value, 'activeForm') ? ['activeForm'] : []),
    ...(Object.hasOwn(value, 'owner') ? ['owner'] : []),
  ]
  return hasExactKeys(value, keys)
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= HOST_ACTION_LIMITS.taskIdCharacters
    && typeof value.subject === 'string' && value.subject.length <= HOST_ACTION_LIMITS.taskSubjectCharacters
    && typeof value.description === 'string' && value.description.length <= HOST_ACTION_LIMITS.taskDescriptionCharacters
    && TASK_STATUSES.includes(value.status as string)
    && (!Object.hasOwn(value, 'activeForm') || (typeof value.activeForm === 'string' && value.activeForm.length <= HOST_ACTION_LIMITS.taskSubjectCharacters))
    && (!Object.hasOwn(value, 'owner') || (typeof value.owner === 'string' && value.owner.length <= HOST_ACTION_LIMITS.taskIdCharacters))
    && Array.isArray(value.blocks) && value.blocks.length <= HOST_ACTION_LIMITS.taskDependencyCount
    && value.blocks.every((id) => typeof id === 'string' && id.length <= HOST_ACTION_LIMITS.taskIdCharacters)
    && Array.isArray(value.blockedBy) && value.blockedBy.length <= HOST_ACTION_LIMITS.taskDependencyCount
    && value.blockedBy.every((id) => typeof id === 'string' && id.length <= HOST_ACTION_LIMITS.taskIdCharacters)
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
    && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
}

function hasTaskMutationHint(value: Record<string, unknown>): boolean {
  return value.mutationDispatchHint === '/tasks'
}

export function isTasksListReadRequest(value: unknown): value is TasksListReadRequest {
  if (!isPlainRecord(value)) return false
  const keys = [
    ...(Object.hasOwn(value, 'limit') ? ['limit'] : []),
    ...(Object.hasOwn(value, 'status') ? ['status'] : []),
  ]
  return hasExactKeys(value, keys)
    && (!Object.hasOwn(value, 'limit') || (Number.isSafeInteger(value.limit) && (value.limit as number) >= 1 && (value.limit as number) <= HOST_ACTION_LIMITS.tasksCount))
    && (!Object.hasOwn(value, 'status') || TASK_STATUSES.includes(value.status as string))
}

export function isTasksItemReadRequest(value: unknown): value is TasksItemReadRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['id'])
    && typeof value.id === 'string'
    && value.id.length > 0
    && value.id.length <= HOST_ACTION_LIMITS.taskIdCharacters
    && !/[\u0000-\u001f\u007f]/.test(value.id)
}

export function isTasksListReadResponse(value: unknown): value is TasksListReadResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['tasks', 'total', 'truncated', 'store', 'mutationDispatchHint'])
    && Array.isArray(value.tasks)
    && value.tasks.length <= HOST_ACTION_LIMITS.tasksCount
    && value.tasks.every(isInstalledTaskSummary)
    && Number.isSafeInteger(value.total) && (value.total as number) >= value.tasks.length
    && typeof value.truncated === 'boolean'
    && TASK_STORES.includes(value.store as string)
    && hasTaskMutationHint(value)
}

export function isTasksItemReadResponse(value: unknown): value is TasksItemReadResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['task', 'store', 'mutationDispatchHint'])
    && (value.task === null || isInstalledTaskSummary(value.task))
    && TASK_STORES.includes(value.store as string)
    && hasTaskMutationHint(value)
}

export function isTasksStatusReadResponse(value: unknown): value is TasksStatusReadResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['store', 'total', 'pending', 'inProgress', 'completed', 'mutationDispatchHint'])
    && TASK_STORES.includes(value.store as string)
    && ['total', 'pending', 'inProgress', 'completed'].every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
    && (value.pending as number) + (value.inProgress as number) + (value.completed as number) === value.total
    && hasTaskMutationHint(value)
}

const FFF_MODES: readonly string[] = ['tools-and-ui', 'tools-only', 'override']
export function isFffModeReadResponse(value: unknown): value is FffModeReadResponse {
  return isPlainRecord(value) && hasExactKeys(value, ['mode']) && FFF_MODES.includes(value.mode as string)
}

export function isFffHealthReadResponse(value: unknown): value is FffHealthReadResponse {
  if (!isPlainRecord(value)) return false
  const keys = [
    'available', 'mode', 'scanning',
    ...(Object.hasOwn(value, 'version') ? ['version'] : []),
    ...(Object.hasOwn(value, 'scannedFiles') ? ['scannedFiles'] : []),
    ...(Object.hasOwn(value, 'indexedFiles') ? ['indexedFiles'] : []),
    ...(Object.hasOwn(value, 'gitRepositoryFound') ? ['gitRepositoryFound'] : []),
    ...(Object.hasOwn(value, 'frecencyActive') ? ['frecencyActive'] : []),
    ...(Object.hasOwn(value, 'queryTrackerActive') ? ['queryTrackerActive'] : []),
  ]
  return hasExactKeys(value, keys)
    && typeof value.available === 'boolean'
    && FFF_MODES.includes(value.mode as string)
    && typeof value.scanning === 'boolean'
    && (!Object.hasOwn(value, 'version') || (typeof value.version === 'string' && value.version.length <= 80))
    && (!Object.hasOwn(value, 'scannedFiles') || (Number.isSafeInteger(value.scannedFiles) && (value.scannedFiles as number) >= 0))
    && (!Object.hasOwn(value, 'indexedFiles') || (Number.isSafeInteger(value.indexedFiles) && (value.indexedFiles as number) >= 0))
    && (!Object.hasOwn(value, 'gitRepositoryFound') || typeof value.gitRepositoryFound === 'boolean')
    && (!Object.hasOwn(value, 'frecencyActive') || typeof value.frecencyActive === 'boolean')
    && (!Object.hasOwn(value, 'queryTrackerActive') || typeof value.queryTrackerActive === 'boolean')
}

export function isFffRescanResponse(value: unknown): value is FffRescanResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['status', 'cooldownMs'])
    && ['started', 'cooldown', 'already-scanning', 'unavailable', 'failed'].includes(value.status as string)
    && Number.isSafeInteger(value.cooldownMs)
    && (value.cooldownMs as number) >= 0
    && (value.cooldownMs as number) <= 60_000
}

function isQuotaUsage(value: unknown): value is QuotaUsage {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['fiveHour', 'weekly'])) return false
  const isWindow = (window: unknown): boolean => window === null || (isPlainRecord(window)
    && hasExactKeys(window, ['remainingPct', 'resetAt'])
    && typeof window.remainingPct === 'number'
    && Number.isFinite(window.remainingPct)
    && window.remainingPct >= 0 && window.remainingPct <= 100
    && (window.resetAt === null || (typeof window.resetAt === 'string' && window.resetAt.length <= 80)))
  return isWindow(value.fiveHour) && isWindow(value.weekly)
}

function isQuotaUsageShape(value: Record<string, unknown>, allowProviderNull: boolean): boolean {
  const keys = [
    'status',
    ...(Object.hasOwn(value, 'provider') ? ['provider'] : []),
    ...(Object.hasOwn(value, 'display') ? ['display'] : []),
    ...(Object.hasOwn(value, 'usage') ? ['usage'] : []),
  ]
  return hasExactKeys(value, keys)
    && ['ok', 'partial', 'unsupported', 'unknown'].includes(value.status as string)
    && (allowProviderNull
      ? (value.provider === null || (typeof value.provider === 'string' && value.provider.length <= HOST_ACTION_LIMITS.providerCharacters))
      : (typeof value.provider === 'string' && value.provider.length > 0 && value.provider.length <= HOST_ACTION_LIMITS.providerCharacters))
    && (!Object.hasOwn(value, 'display') || (typeof value.display === 'string' && value.display.length <= HOST_ACTION_LIMITS.quotaDisplayCharacters))
    && (!Object.hasOwn(value, 'usage') || isQuotaUsage(value.usage))
}

export function isQuotaStatusReadResponse(value: unknown): value is QuotaStatusReadResponse {
  if (!isPlainRecord(value) || !Object.hasOwn(value, 'provider')) return false
  return isQuotaUsageShape(value, true)
}

export function isQuotaConsentRequest(value: unknown): value is QuotaConsentRequest {
  if (!isPlainRecord(value)) return false
  const keys = ['consent', 'consentLabel', ...(Object.hasOwn(value, 'provider') ? ['provider'] : [])]
  return hasExactKeys(value, keys)
    && value.consent === true
    && value.consentLabel === HOST_ACTION_CONSENT[HOST_ACTIONS.quota.usageFetch].consentLabel
    && (!Object.hasOwn(value, 'provider') || ['openai-codex', 'opencode-go', 'anthropic', 'claude-bridge', 'zai'].includes(value.provider as string))
}

export function isQuotaUsageFetchResponse(value: unknown): value is QuotaUsageFetchResponse {
  return isPlainRecord(value) && typeof value.provider === 'string' && isQuotaUsageShape(value, false)
}

export function isQuotaHarExtractRequest(value: unknown): value is QuotaHarExtractRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['harContent', 'verify', 'consent', 'consentLabel'])
    && typeof value.harContent === 'string'
    && value.harContent.length <= HOST_ACTION_LIMITS.quotaHarCharacters
    && typeof value.verify === 'boolean'
    && value.consent === true
    && value.consentLabel === HOST_ACTION_CONSENT[HOST_ACTIONS.quota.harExtract].consentLabel
}

export function isQuotaHarExtractResponse(value: unknown): value is QuotaHarExtractResponse {
  if (!isPlainRecord(value)) return false
  const keys = ['valid', 'detected', 'verified', ...(Object.hasOwn(value, 'provider') ? ['provider'] : [])]
  return hasExactKeys(value, keys)
    && typeof value.valid === 'boolean'
    && typeof value.detected === 'boolean'
    && (!Object.hasOwn(value, 'provider') || value.provider === 'anthropic-subscription')
    && ['verified', 'not-verified', 'not-requested'].includes(value.verified as string)
}

export function isWebCachedResultsReadRequest(value: unknown): value is WebCachedResultsReadRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, Object.hasOwn(value, 'limit') ? ['limit'] : [])
    && (!Object.hasOwn(value, 'limit') || (Number.isSafeInteger(value.limit) && (value.limit as number) >= 1 && (value.limit as number) <= 100))
}

export function isWebCachedResultsReadResponse(value: unknown): value is WebCachedResultsReadResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['results'])
    && Array.isArray(value.results)
    && value.results.length <= HOST_ACTION_LIMITS.webResultCount
    && value.results.every((result) => isPlainRecord(result)
      && hasExactKeys(result, ['id', 'type', 'timestamp', 'title', 'summary'])
      && typeof result.id === 'string' && result.id.length <= 80
      && ['search', 'fetch', 'research'].includes(result.type as string)
      && typeof result.timestamp === 'number' && Number.isFinite(result.timestamp)
      && typeof result.title === 'string' && result.title.length <= HOST_ACTION_LIMITS.webTextCharacters
      && typeof result.summary === 'string' && result.summary.length <= HOST_ACTION_LIMITS.webTextCharacters)
}

export function isWebSearchRunRequest(value: unknown): value is WebSearchRunRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['queries', 'consent', 'consentLabel'])
    && Array.isArray(value.queries)
    && value.queries.length >= 1 && value.queries.length <= HOST_ACTION_LIMITS.webQueryCount
    && value.queries.every((query) => typeof query === 'string' && query.trim().length > 0 && query.length <= HOST_ACTION_LIMITS.webQueryCharacters)
    && value.consent === true
    && value.consentLabel === HOST_ACTION_CONSENT[HOST_ACTIONS.webAccess.searchRun].consentLabel
}

export function isWebSearchRunResponse(value: unknown): value is WebSearchRunResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['provider', 'results'])
    && typeof value.provider === 'string' && value.provider.length <= HOST_ACTION_LIMITS.providerCharacters
    && Array.isArray(value.results) && value.results.length <= HOST_ACTION_LIMITS.webResultCount
    && value.results.every((result) => isPlainRecord(result)
      && hasExactKeys(result, ['title', 'url', 'snippet'])
      && typeof result.title === 'string' && result.title.length <= HOST_ACTION_LIMITS.webTextCharacters
      && typeof result.url === 'string' && result.url.length <= 2048
      && typeof result.snippet === 'string' && result.snippet.length <= HOST_ACTION_LIMITS.webTextCharacters)
}

export function isWebCuratorOpenResponse(value: unknown): value is WebCuratorOpenResponse {
  return isPlainRecord(value) && hasExactKeys(value, ['opened']) && typeof value.opened === 'boolean'
}

export function isWebCuratorStatusResponse(value: unknown): value is WebCuratorStatusResponse {
  if (!isPlainRecord(value)) return false
  const keys = ['active', 'phase', ...(Object.hasOwn(value, 'progress') ? ['progress'] : [])]
  return hasExactKeys(value, keys)
    && typeof value.active === 'boolean'
    && ['idle', 'searching', 'curating', 'unknown'].includes(value.phase as string)
    && (!Object.hasOwn(value, 'progress') || (typeof value.progress === 'number' && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 1))
}

export function isWebGoogleAccountStatusRequest(value: unknown): value is WebGoogleAccountStatusRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['consent', 'consentLabel'])
    && value.consent === true
    && value.consentLabel === HOST_ACTION_CONSENT[HOST_ACTIONS.webAccess.googleAccountStatus].consentLabel
}

export function isWebGoogleAccountStatusResponse(value: unknown): value is WebGoogleAccountStatusResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, Object.hasOwn(value, 'email') ? ['available', 'email'] : ['available'])
    && typeof value.available === 'boolean'
    && (!Object.hasOwn(value, 'email') || (typeof value.email === 'string' && value.email.length <= 320))
}

function isMultiAccountSummary(value: unknown): value is MultiAccountSummary {
  return isPlainRecord(value)
    && hasExactKeys(value, ['provider', 'accountId'])
    && typeof value.provider === 'string' && value.provider.length > 0 && value.provider.length <= HOST_ACTION_LIMITS.providerCharacters
    && typeof value.accountId === 'string' && value.accountId.length > 0 && value.accountId.length <= HOST_ACTION_LIMITS.providerCharacters
}

export function isMultiAccountAccountsReadResponse(value: unknown): value is MultiAccountAccountsReadResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['accounts'])
    && Array.isArray(value.accounts)
    && value.accounts.length <= HOST_ACTION_LIMITS.accountCount
    && value.accounts.every(isMultiAccountSummary)
}

export function isMultiAccountRoutingReadResponse(value: unknown): value is MultiAccountRoutingReadResponse {
  if (!isPlainRecord(value)) return false
  const keys = [
    'enabled', 'routeSource',
    ...(Object.hasOwn(value, 'provider') ? ['provider'] : []),
    ...(Object.hasOwn(value, 'model') ? ['model'] : []),
    ...(Object.hasOwn(value, 'accountId') ? ['accountId'] : []),
  ]
  return hasExactKeys(value, keys)
    && typeof value.enabled === 'boolean'
    && ['multi-account', 'native', 'unknown'].includes(value.routeSource as string)
    && ['provider', 'model', 'accountId'].every((key) => !Object.hasOwn(value, key) || (typeof value[key] === 'string' && (value[key] as string).length <= HOST_ACTION_LIMITS.providerCharacters))
}

export function isMultiAccountFailoverStatusResponse(value: unknown): value is MultiAccountFailoverStatusResponse {
  if (!isPlainRecord(value)) return false
  const keys = ['enabled', 'autoContinue', 'providerOrder', 'cooldowns', 'invalidatedProviders', ...(Object.hasOwn(value, 'lastSwitch') ? ['lastSwitch'] : [])]
  return hasExactKeys(value, keys)
    && typeof value.enabled === 'boolean'
    && typeof value.autoContinue === 'boolean'
    && Array.isArray(value.providerOrder) && value.providerOrder.length <= HOST_ACTION_LIMITS.accountCount
    && value.providerOrder.every((provider) => typeof provider === 'string' && provider.length <= HOST_ACTION_LIMITS.providerCharacters)
    && Array.isArray(value.cooldowns) && value.cooldowns.length <= HOST_ACTION_LIMITS.accountCount
    && value.cooldowns.every((cooldown) => isPlainRecord(cooldown)
      && hasExactKeys(cooldown, ['provider', 'until'])
      && typeof cooldown.provider === 'string' && cooldown.provider.length <= HOST_ACTION_LIMITS.providerCharacters
      && typeof cooldown.until === 'number' && Number.isFinite(cooldown.until))
    && Array.isArray(value.invalidatedProviders) && value.invalidatedProviders.length <= HOST_ACTION_LIMITS.accountCount
    && value.invalidatedProviders.every((provider) => typeof provider === 'string' && provider.length <= HOST_ACTION_LIMITS.providerCharacters)
    && (!Object.hasOwn(value, 'lastSwitch') || (isPlainRecord(value.lastSwitch)
      && hasExactKeys(value.lastSwitch, ['fromProvider', 'toProvider', 'at'])
      && typeof value.lastSwitch.fromProvider === 'string' && value.lastSwitch.fromProvider.length <= HOST_ACTION_LIMITS.providerCharacters
      && typeof value.lastSwitch.toProvider === 'string' && value.lastSwitch.toProvider.length <= HOST_ACTION_LIMITS.providerCharacters
      && typeof value.lastSwitch.at === 'number' && Number.isFinite(value.lastSwitch.at)))
}
