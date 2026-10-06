import type { RuntimeScope } from '../../../shared/ipc-contracts.ts'
import {
  HOST_ACTIONS,
  HOST_ACTION_CONSENT,
  HOST_ACTION_LIMITS,
  isEmptyHostActionRequest,
  isWebCachedResultsReadRequest,
  isWebCachedResultsReadResponse,
  isWebCuratorOpenResponse,
  isWebCuratorStatusResponse,
  isWebGoogleAccountStatusRequest,
  isWebGoogleAccountStatusResponse,
  isWebSearchRunRequest,
  isWebSearchRunResponse,
  type EmptyHostActionRequest,
  type WebCachedResult,
  type WebCachedResultsReadRequest,
  type WebCachedResultsReadResponse,
  type WebCuratorOpenResponse,
  type WebCuratorStatusResponse,
  type WebGoogleAccountStatusRequest,
  type WebGoogleAccountStatusResponse,
  type WebSearchResult,
  type WebSearchRunRequest,
  type WebSearchRunResponse,
} from '../../../shared/host-actions.ts'
import type { AuthorizedIpcCaller, CapabilityDefinition } from '../../ipc/register.ts'

export interface WebSearchResultRecord {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

export interface WebAccessRuntimeBridge {
  /** Reads the extension's storedResults / fetched-content cache only; must not start a fetch. */
  readCachedResults(caller: AuthorizedIpcCaller, scope: RuntimeScope, limit: number): Promise<readonly WebCachedResult[]> | readonly WebCachedResult[]
  /** One foreground search invocation. Parent must honor consent and never attach background polling. */
  runSearch(caller: AuthorizedIpcCaller, scope: RuntimeScope, queries: readonly string[], consentLabel: string): Promise<{ provider: string; results: readonly WebSearchResultRecord[] }> | { provider: string; results: readonly WebSearchResultRecord[] }
  /** Opens an already-running local curator UI only; it must not initiate a search. */
  openExistingCurator(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<boolean> | boolean
  readCuratorStatus(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<WebCuratorStatusResponse> | WebCuratorStatusResponse
  /** Native google-account status is read-only; it may inspect browser cookies and contact Google. */
  readGoogleAccountStatus(caller: AuthorizedIpcCaller, scope: RuntimeScope, consentLabel: string): Promise<WebGoogleAccountStatusResponse> | WebGoogleAccountStatusResponse
}

export interface WebAccessRequiresRuntimeBridgeAccessor {
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): WebAccessRuntimeBridge | null
}

export interface WebAccessHostActionOptions {
  readonly bridge: WebAccessRequiresRuntimeBridgeAccessor
  readonly authorizeRuntimeCaller: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => boolean
}

function runtimeBridge(
  options: WebAccessHostActionOptions,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): { readonly scope: RuntimeScope; readonly bridge: WebAccessRuntimeBridge } {
  if (!scope || !options.authorizeRuntimeCaller(caller, scope)) throw new Error('A current authorized runtime scope is required for web-access actions.')
  const bridge = options.bridge.resolve(caller, scope)
  if (!bridge) throw new Error('Web-access runtime bridge is unavailable.')
  return { scope, bridge }
}

function safeUrl(value: string): string {
  try {
    const parsed = new URL(value)
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.href.slice(0, 2048)
  } catch {
    return ''
  }
}

function safeSearchResult(value: WebSearchResultRecord): WebSearchResult | null {
  const url = safeUrl(value.url)
  if (!url) return null
  return {
    title: typeof value.title === 'string' ? value.title.slice(0, HOST_ACTION_LIMITS.webTextCharacters) : '',
    url,
    snippet: typeof value.snippet === 'string' ? value.snippet.slice(0, HOST_ACTION_LIMITS.webTextCharacters) : '',
  }
}

/** Live search and Google-account probes require an explicit consent DTO on every invocation. */
export function registerWebAccessHostActions(options: WebAccessHostActionOptions): readonly CapabilityDefinition<any, any>[] {
  const cachedResultsRead: CapabilityDefinition<WebCachedResultsReadRequest, WebCachedResultsReadResponse> = {
    id: HOST_ACTIONS.webAccess.cachedResultsRead,
    scope: 'runtime',
    validateRequest: isWebCachedResultsReadRequest,
    validateResponse: isWebCachedResultsReadResponse,
    handle: async ({ caller, scope }, request) => {
      const resolved = runtimeBridge(options, caller, scope)
      const limit = request.limit ?? HOST_ACTION_LIMITS.webResultCount
      const results = await resolved.bridge.readCachedResults(caller, resolved.scope, limit)
      return {
        results: results.slice(0, limit).map((item) => ({
          id: item.id.slice(0, 80),
          type: ['search', 'fetch', 'research'].includes(item.type) ? item.type : 'search',
          timestamp: Number.isFinite(item.timestamp) ? item.timestamp : 0,
          title: item.title.slice(0, HOST_ACTION_LIMITS.webTextCharacters),
          summary: item.summary.slice(0, HOST_ACTION_LIMITS.webTextCharacters),
        })),
      }
    },
  }

  const searchRun: CapabilityDefinition<WebSearchRunRequest, WebSearchRunResponse> = {
    id: HOST_ACTIONS.webAccess.searchRun,
    scope: 'runtime',
    validateRequest: isWebSearchRunRequest,
    validateResponse: isWebSearchRunResponse,
    handle: async ({ caller, scope }, request) => {
      const resolved = runtimeBridge(options, caller, scope)
      const consentLabel = HOST_ACTION_CONSENT[HOST_ACTIONS.webAccess.searchRun].consentLabel
      if (request.consent !== true || request.consentLabel !== consentLabel) throw new Error('External web search requires explicit per-call consent.')
      const response = await resolved.bridge.runSearch(caller, resolved.scope, request.queries, consentLabel)
      const results = response.results.slice(0, HOST_ACTION_LIMITS.webResultCount)
        .flatMap((item) => {
          const safe = safeSearchResult(item)
          return safe ? [safe] : []
        })
      return { provider: response.provider.slice(0, HOST_ACTION_LIMITS.providerCharacters), results }
    },
  }

  const curatorOpen: CapabilityDefinition<EmptyHostActionRequest, WebCuratorOpenResponse> = {
    id: HOST_ACTIONS.webAccess.curatorOpen,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isWebCuratorOpenResponse,
    handle: async ({ caller, scope }) => {
      const resolved = runtimeBridge(options, caller, scope)
      return { opened: await resolved.bridge.openExistingCurator(caller, resolved.scope) }
    },
  }

  const curatorStatusRead: CapabilityDefinition<EmptyHostActionRequest, WebCuratorStatusResponse> = {
    id: HOST_ACTIONS.webAccess.curatorStatusRead,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isWebCuratorStatusResponse,
    handle: async ({ caller, scope }) => {
      const resolved = runtimeBridge(options, caller, scope)
      const status = await resolved.bridge.readCuratorStatus(caller, resolved.scope)
      return {
        active: status.active === true,
        phase: ['idle', 'searching', 'curating', 'unknown'].includes(status.phase) ? status.phase : 'unknown',
        ...(typeof status.progress === 'number' && Number.isFinite(status.progress)
          ? { progress: Math.min(1, Math.max(0, status.progress)) }
          : {}),
      }
    },
  }

  const googleAccountStatus: CapabilityDefinition<WebGoogleAccountStatusRequest, WebGoogleAccountStatusResponse> = {
    id: HOST_ACTIONS.webAccess.googleAccountStatus,
    scope: 'runtime',
    validateRequest: isWebGoogleAccountStatusRequest,
    validateResponse: isWebGoogleAccountStatusResponse,
    handle: async ({ caller, scope }, request) => {
      const resolved = runtimeBridge(options, caller, scope)
      const consentLabel = HOST_ACTION_CONSENT[HOST_ACTIONS.webAccess.googleAccountStatus].consentLabel
      if (request.consent !== true || request.consentLabel !== consentLabel) throw new Error('Google-account status requires explicit per-call consent.')
      const status = await resolved.bridge.readGoogleAccountStatus(caller, resolved.scope, consentLabel)
      const email = typeof status.email === 'string' && status.email.length <= 320 ? status.email : undefined
      return { available: status.available === true, ...(email ? { email } : {}) }
    },
  }

  return [cachedResultsRead, searchRun, curatorOpen, curatorStatusRead, googleAccountStatus]
}
