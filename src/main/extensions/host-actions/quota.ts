import type { RuntimeScope } from '../../../shared/ipc-contracts.ts'
import {
  HOST_ACTIONS,
  HOST_ACTION_CONSENT,
  HOST_ACTION_LIMITS,
  isEmptyHostActionRequest,
  isQuotaConsentRequest,
  isQuotaHarExtractRequest,
  isQuotaHarExtractResponse,
  isQuotaStatusReadResponse,
  isQuotaUsageFetchResponse,
  type EmptyHostActionRequest,
  type QuotaConsentRequest,
  type QuotaHarExtractRequest,
  type QuotaHarExtractResponse,
  type QuotaProvider,
  type QuotaStatusReadResponse,
  type QuotaUsageFetchResponse,
} from '../../../shared/host-actions.ts'
import type { AuthorizedIpcCaller, CapabilityDefinition } from '../../ipc/register.ts'

export interface QuotaHarExtractionSummary {
  readonly valid: boolean
  readonly detected: boolean
  readonly provider?: 'anthropic-subscription'
  readonly verified: 'verified' | 'not-verified' | 'not-requested'
}

/**
 * Parent adapter must call only the explicit quota command path. It must not expose credentials,
 * write auth.json, or reuse the extension's background status-refresh timer.
 */
export interface QuotaRuntimeBridge {
  readCachedStatus(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<QuotaStatusReadResponse> | QuotaStatusReadResponse
  fetchUsage(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    provider: QuotaProvider | undefined,
    consentLabel: string,
  ): Promise<QuotaUsageFetchResponse> | QuotaUsageFetchResponse
  extractHar(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    harContent: string,
    verifyWithProvider: boolean,
    consentLabel: string,
  ): Promise<QuotaHarExtractionSummary> | QuotaHarExtractionSummary
}

export interface QuotaRequiresRuntimeBridgeAccessor {
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): QuotaRuntimeBridge | null
}

export interface QuotaHostActionOptions {
  readonly bridge: QuotaRequiresRuntimeBridgeAccessor
  readonly authorizeRuntimeCaller: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => boolean
}

function runtimeBridge(
  options: QuotaHostActionOptions,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): { readonly scope: RuntimeScope; readonly bridge: QuotaRuntimeBridge } {
  if (!scope || !options.authorizeRuntimeCaller(caller, scope)) throw new Error('A current authorized runtime scope is required for quota actions.')
  const bridge = options.bridge.resolve(caller, scope)
  if (!bridge) throw new Error('Quota runtime bridge is unavailable.')
  return { scope, bridge }
}

function safeUsage(value: QuotaStatusReadResponse | QuotaUsageFetchResponse): {
  readonly status: 'ok' | 'partial' | 'unsupported' | 'unknown'
  readonly display?: string
  readonly usage?: QuotaStatusReadResponse['usage']
} {
  const status = ['ok', 'partial', 'unsupported', 'unknown'].includes(value.status) ? value.status : 'unknown'
  const display = typeof value.display === 'string' ? value.display.slice(0, HOST_ACTION_LIMITS.quotaDisplayCharacters) : undefined
  const nativeUsage: unknown = value.usage
  let usage: QuotaStatusReadResponse['usage']
  if (nativeUsage !== undefined && nativeUsage !== null && typeof nativeUsage === 'object') {
    const fields = nativeUsage as Record<string, unknown>
    const sanitizeWindow = (window: unknown): NonNullable<QuotaStatusReadResponse['usage']>['fiveHour'] => {
      if (window === null || window === undefined || typeof window !== 'object') return null
      const candidate = window as Record<string, unknown>
      if (typeof candidate.remainingPct !== 'number' || !Number.isFinite(candidate.remainingPct)) return null
      return {
        remainingPct: Math.min(100, Math.max(0, candidate.remainingPct)),
        resetAt: typeof candidate.resetAt === 'string' ? candidate.resetAt.slice(0, 80) : null,
      }
    }
    usage = {
      fiveHour: sanitizeWindow(fields.fiveHour),
      weekly: sanitizeWindow(fields.weekly),
    }
  }
  return {
    status,
    ...(display !== undefined ? { display } : {}),
    ...(usage ? { usage } : {}),
  }
}

/** All network-capable methods are single explicit calls gated by exact consent DTOs. */
export function registerQuotaHostActions(options: QuotaHostActionOptions): readonly CapabilityDefinition<any, any>[] {
  const statusRead: CapabilityDefinition<EmptyHostActionRequest, QuotaStatusReadResponse> = {
    id: HOST_ACTIONS.quota.statusRead,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isQuotaStatusReadResponse,
    handle: async ({ caller, scope }) => {
      const resolved = runtimeBridge(options, caller, scope)
      const result = await resolved.bridge.readCachedStatus(caller, resolved.scope)
      return {
        provider: typeof result.provider === 'string' ? result.provider.slice(0, HOST_ACTION_LIMITS.providerCharacters) : null,
        ...safeUsage(result),
      }
    },
  }

  const usageFetch: CapabilityDefinition<QuotaConsentRequest, QuotaUsageFetchResponse> = {
    id: HOST_ACTIONS.quota.usageFetch,
    scope: 'runtime',
    validateRequest: isQuotaConsentRequest,
    validateResponse: isQuotaUsageFetchResponse,
    handle: async ({ caller, scope }, request) => {
      const resolved = runtimeBridge(options, caller, scope)
      if (request.consentLabel !== HOST_ACTION_CONSENT[HOST_ACTIONS.quota.usageFetch].consentLabel) {
        throw new Error('Quota usage requires explicit per-call consent.')
      }
      const result = await resolved.bridge.fetchUsage(caller, resolved.scope, request.provider, request.consentLabel)
      return {
        provider: typeof result.provider === 'string' ? result.provider.slice(0, HOST_ACTION_LIMITS.providerCharacters) : 'unknown',
        ...safeUsage(result),
      }
    },
  }

  const harExtract: CapabilityDefinition<QuotaHarExtractRequest, QuotaHarExtractResponse> = {
    id: HOST_ACTIONS.quota.harExtract,
    scope: 'runtime',
    validateRequest: isQuotaHarExtractRequest,
    validateResponse: isQuotaHarExtractResponse,
    handle: async ({ caller, scope }, request) => {
      const resolved = runtimeBridge(options, caller, scope)
      if (request.consentLabel !== HOST_ACTION_CONSENT[HOST_ACTIONS.quota.harExtract].consentLabel) {
        throw new Error('HAR extraction requires explicit per-call consent.')
      }
      const summary = await resolved.bridge.extractHar(
        caller,
        resolved.scope,
        request.harContent,
        request.verify,
        request.consentLabel,
      )
      return {
        valid: summary.valid === true,
        detected: summary.detected === true,
        ...(summary.provider === 'anthropic-subscription' ? { provider: summary.provider } : {}),
        verified: request.verify
          ? (summary.verified === 'verified' ? 'verified' : 'not-verified')
          : 'not-requested',
      }
    },
  }

  return [statusRead, usageFetch, harExtract]
}
