import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeScope } from '../../../shared/ipc-contracts.ts'
import {
  HOST_ACTIONS,
  HOST_ACTION_LIMITS,
  isEmptyHostActionRequest,
  isMultiAccountAccountsReadResponse,
  isMultiAccountFailoverStatusResponse,
  isMultiAccountRoutingReadResponse,
  type EmptyHostActionRequest,
  type MultiAccountAccountsReadResponse,
  type MultiAccountFailoverStatusResponse,
  type MultiAccountRoutingReadResponse,
  type MultiAccountSummary,
} from '../../../shared/host-actions.ts'
import type { AuthorizedIpcCaller, CapabilityDefinition } from '../../ipc/register.ts'

export interface MultiAccountRouteSnapshot {
  readonly provider?: string
  readonly model?: string
  readonly accountId?: string
  readonly routeSource: 'multi-account' | 'native' | 'unknown'
}

/** Runtime route accessor only; the parent must return identity/status fields and never auth values. */
export interface MultiAccountRuntimeBridge {
  readCurrentRoute(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<MultiAccountRouteSnapshot> | MultiAccountRouteSnapshot
}

export interface MultiAccountRequiresRuntimeBridgeAccessor {
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): MultiAccountRuntimeBridge | null
}

export interface MultiAccountHostActionOptions {
  readonly bridge: MultiAccountRequiresRuntimeBridgeAccessor
  readonly authorizeRuntimeCaller: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => boolean
  readonly agentDir?: string
}

const MAX_NATIVE_FILE_BYTES = 4 * 1024 * 1024
const ACCOUNT_SLOT = /^(.+)-account-(\d+)$/
const SAFE_PROVIDER_ID = /^[a-zA-Z0-9._-]{1,128}$/
const DEFAULT_PROVIDER_ORDER = ['anthropic', 'openai-codex', 'kimi-coding', 'cursor', 'qwen', 'ollama'] as const

function agentDir(options: MultiAccountHostActionOptions): string {
  return options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
}

function readRecord(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_NATIVE_FILE_BYTES) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function runtimeBridge(
  options: MultiAccountHostActionOptions,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): { readonly scope: RuntimeScope; readonly bridge: MultiAccountRuntimeBridge } {
  if (!scope || !options.authorizeRuntimeCaller(caller, scope)) throw new Error('A current authorized runtime scope is required for multi-account actions.')
  const bridge = options.bridge.resolve(caller, scope)
  if (!bridge) throw new Error('Multi-account runtime bridge is unavailable.')
  return { scope, bridge }
}

function hasNativeAuthEntry(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  // Inspect only structural markers; credential contents are never read into a response.
  return typeof entry.type === 'string' || Object.hasOwn(entry, 'key') || Object.hasOwn(entry, 'access')
}

function safeProvider(value: string): string | null {
  return SAFE_PROVIDER_ID.test(value) ? value.slice(0, HOST_ACTION_LIMITS.providerCharacters) : null
}

function accountSummaries(directory: string): MultiAccountSummary[] {
  const fileNames = ['auth.json', 'pi-multi-account-proxy-oauth.json']
  const entries = new Map<string, MultiAccountSummary>()
  for (const fileName of fileNames) {
    const parsed = readRecord(join(directory, fileName))
    for (const [key, value] of Object.entries(parsed)) {
      if (!SAFE_PROVIDER_ID.test(key) || !hasNativeAuthEntry(value)) continue
      const slot = ACCOUNT_SLOT.exec(key)
      const provider = safeProvider(slot?.[1] ?? key)
      const accountId = safeProvider(key)
      if (provider && accountId) entries.set(key, { provider, accountId })
    }
  }
  return [...entries.values()].sort((left, right) => left.provider.localeCompare(right.provider) || left.accountId.localeCompare(right.accountId))
    .slice(0, HOST_ACTION_LIMITS.accountCount)
}

function nativeEnabled(directory: string): boolean {
  const config = readRecord(join(directory, 'provider-failover.json'))
  return typeof config.enabled === 'boolean' ? config.enabled : true
}

function sanitizeFailoverStatus(directory: string): MultiAccountFailoverStatusResponse {
  const config = readRecord(join(directory, 'provider-failover.json'))
  const state = readRecord(join(directory, 'provider-failover-state.json'))
  const configuredOrder = Array.isArray(config.providerOrder)
    ? config.providerOrder.filter((family): family is string => typeof family === 'string' && DEFAULT_PROVIDER_ORDER.includes(family as typeof DEFAULT_PROVIDER_ORDER[number]))
    : [...DEFAULT_PROVIDER_ORDER]
  const exhausted = state.exhaustedUntilByProvider
  const cooldowns: Array<{ provider: string; until: number }> = []
  if (exhausted !== null && typeof exhausted === 'object' && !Array.isArray(exhausted)) {
    for (const [provider, until] of Object.entries(exhausted as Record<string, unknown>)) {
      const safe = safeProvider(provider)
      if (safe && typeof until === 'number' && Number.isFinite(until) && until > Date.now()) cooldowns.push({ provider: safe, until })
    }
  }

  const invalidatedProviders = state.invalidatedByProvider !== null
    && typeof state.invalidatedByProvider === 'object'
    && !Array.isArray(state.invalidatedByProvider)
    ? Object.keys(state.invalidatedByProvider as Record<string, unknown>)
      .map(safeProvider)
      .filter((provider): provider is string => provider !== null)
    : []

  let lastSwitch: MultiAccountFailoverStatusResponse['lastSwitch']
  if (Array.isArray(state.lastSwitches) && state.lastSwitches.length > 0) {
    const newest = state.lastSwitches[0]
    if (newest !== null && typeof newest === 'object' && !Array.isArray(newest)) {
      const record = newest as Record<string, unknown>
      const from = record.from !== null && typeof record.from === 'object' ? (record.from as Record<string, unknown>).provider : undefined
      const to = record.to !== null && typeof record.to === 'object' ? (record.to as Record<string, unknown>).provider : undefined
      if (typeof from === 'string' && typeof to === 'string' && typeof record.at === 'number' && Number.isFinite(record.at)) {
        const fromProvider = safeProvider(from)
        const toProvider = safeProvider(to)
        if (fromProvider && toProvider) lastSwitch = { fromProvider, toProvider, at: record.at }
      }
    }
  }

  return {
    enabled: typeof config.enabled === 'boolean' ? config.enabled : true,
    autoContinue: typeof config.autoContinue === 'boolean' ? config.autoContinue : true,
    providerOrder: [...new Set(configuredOrder)].slice(0, HOST_ACTION_LIMITS.accountCount),
    cooldowns: cooldowns.slice(0, HOST_ACTION_LIMITS.accountCount),
    invalidatedProviders: [...new Set(invalidatedProviders)].slice(0, HOST_ACTION_LIMITS.accountCount),
    ...(lastSwitch ? { lastSwitch } : {}),
  }
}

function safeRouteValue(value: unknown): string | undefined {
  return typeof value === 'string' ? safeProvider(value) ?? undefined : undefined
}

function safeModelId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,128}$/.test(value) ? value : undefined
}

/** Read-only access to native account identities and route metadata; never reads/returns credential values. */
export function registerMultiAccountHostActions(options: MultiAccountHostActionOptions): readonly CapabilityDefinition<any, any>[] {
  const accountsRead: CapabilityDefinition<EmptyHostActionRequest, MultiAccountAccountsReadResponse> = {
    id: HOST_ACTIONS.multiAccount.accountsRead,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isMultiAccountAccountsReadResponse,
    handle: ({ caller, scope }) => {
      if (!scope || !options.authorizeRuntimeCaller(caller, scope)) throw new Error('A current authorized runtime scope is required for multi-account actions.')
      return { accounts: accountSummaries(agentDir(options)) }
    },
  }

  const routingRead: CapabilityDefinition<EmptyHostActionRequest, MultiAccountRoutingReadResponse> = {
    id: HOST_ACTIONS.multiAccount.routingRead,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isMultiAccountRoutingReadResponse,
    handle: async ({ caller, scope }) => {
      const resolved = runtimeBridge(options, caller, scope)
      const route = await resolved.bridge.readCurrentRoute(caller, resolved.scope)
      return {
        enabled: nativeEnabled(agentDir(options)),
        routeSource: ['multi-account', 'native', 'unknown'].includes(route.routeSource) ? route.routeSource : 'unknown',
        ...(safeRouteValue(route.provider) ? { provider: safeRouteValue(route.provider) } : {}),
        ...(safeModelId(route.model) ? { model: safeModelId(route.model) } : {}),
        ...(safeRouteValue(route.accountId) ? { accountId: safeRouteValue(route.accountId) } : {}),
      }
    },
  }

  const failoverStatusRead: CapabilityDefinition<EmptyHostActionRequest, MultiAccountFailoverStatusResponse> = {
    id: HOST_ACTIONS.multiAccount.failoverStatusRead,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isMultiAccountFailoverStatusResponse,
    handle: ({ caller, scope }) => {
      if (!scope || !options.authorizeRuntimeCaller(caller, scope)) throw new Error('A current authorized runtime scope is required for multi-account actions.')
      return sanitizeFailoverStatus(agentDir(options))
    },
  }

  return [accountsRead, routingRead, failoverStatusRead]
}
