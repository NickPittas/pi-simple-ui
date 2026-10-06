import './ipc-contracts.ts'
import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

/**
 * Config-only MCP management. Pi (the pi-mcp-adapter extension) owns connections, OAuth and tool exposure; the app only edits
 * the adapter's native JSON files. Secret values (env / header values, bearer tokens, OAuth secrets, URL query strings) are never
 * part of any response; a kv entry sent back without a `value` means "keep the stored value for this key".
 */

/** Adapter config sources in ascending precedence (later wins), see pi-mcp-adapter config.ts getConfigSources. */
export type NativeMcpOrigin = 'shared-global' | 'agents-global' | 'agents-nested' | 'user' | 'shared-project' | 'project'
export const NATIVE_MCP_ORIGINS: readonly NativeMcpOrigin[] = ['shared-global', 'agents-global', 'agents-nested', 'user', 'shared-project', 'project']
export const NATIVE_MCP_WRITABLE_ORIGINS: readonly NativeMcpOrigin[] = ['user', 'shared-project', 'project']
export type NativeMcpTransport = 'stdio' | 'http' | 'sse' | 'socket' | 'override'
export const NATIVE_MCP_LIFECYCLES = ['keep-alive', 'lazy', 'lazy-keep-alive', 'eager'] as const
export const NATIVE_MCP_AUTH = ['default', 'oauth', 'bearer', 'none'] as const
export type NativeMcpLifecycle = typeof NATIVE_MCP_LIFECYCLES[number]
export type NativeMcpAuth = typeof NATIVE_MCP_AUTH[number]

/** A redacted key/value entry. `ref` is set only for a pure `${VAR}` style reference (not a secret); everything else is masked. */
export interface NativeMcpKvView { readonly key: string; readonly kind: 'literal' | 'reference' | 'command'; readonly ref?: string }
/** `value` absent = keep the stored value of an existing key. */
export interface NativeMcpKvInput { readonly key: string; readonly value?: string }

export interface NativeMcpFileInfo {
  readonly origin: NativeMcpOrigin
  readonly label: string
  readonly path: string
  readonly exists: boolean
  readonly writable: boolean
  readonly revision: string
  readonly error: string | null
}

export interface NativeMcpServerView {
  readonly id: string
  readonly name: string
  readonly origin: NativeMcpOrigin
  readonly writable: boolean
  readonly transport: NativeMcpTransport
  /** Literal `disabled: true` in this entry (the only native disable switch). */
  readonly disabled: boolean
  /** Effective state after the adapter's precedence merge. */
  readonly effectiveDisabled: boolean
  /** Origin of the higher-precedence entry that overrides or merges over this one, if any. */
  readonly shadowedBy: NativeMcpOrigin | null
  readonly command?: string
  readonly args: readonly string[]
  readonly cwd?: string
  /** Userinfo, query and fragment removed. */
  readonly url?: string
  readonly urlRedacted: boolean
  readonly socket?: string
  readonly env: readonly NativeMcpKvView[]
  readonly headers: readonly NativeMcpKvView[]
  readonly lifecycle?: NativeMcpLifecycle
  readonly auth: NativeMcpAuth
  readonly httpTransport?: 'streamable-http' | 'sse'
  /** true | false | 'list' (a per-tool list is configured; preserved untouched). */
  readonly directTools?: boolean | 'list'
  readonly idleTimeout?: number
  readonly requestTimeoutMs?: number
  readonly exposeResources?: boolean
  readonly debug?: boolean
  readonly includeTools: readonly string[]
  readonly excludeTools: readonly string[]
  /** Names only. Values of these keys are preserved on save and never sent (they may hold credentials). */
  readonly extraKeys: readonly string[]
  readonly warnings: readonly string[]
}

export interface NativeMcpListResult {
  readonly servers: readonly NativeMcpServerView[]
  readonly files: readonly NativeMcpFileInfo[]
  readonly hasProject: boolean
}

export interface NativeMcpConfigInput {
  readonly transport: Exclude<NativeMcpTransport, 'socket'>
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly url?: string
  /** When the url shown was the redacted form, keep the stored query/userinfo if the visible part is unchanged. */
  readonly keepUrlExtras?: boolean
  readonly env?: readonly NativeMcpKvInput[]
  readonly headers?: readonly NativeMcpKvInput[]
  readonly lifecycle?: NativeMcpLifecycle
  readonly auth?: NativeMcpAuth
  readonly directTools?: boolean | 'keep'
  readonly idleTimeout?: number
  readonly requestTimeoutMs?: number
  readonly exposeResources?: boolean
  readonly debug?: boolean
  readonly includeTools?: readonly string[]
  readonly excludeTools?: readonly string[]
  readonly disabled?: boolean
}

export interface NativeMcpSaveRequest {
  readonly origin: NativeMcpOrigin
  /** Existing server name to edit, or null to create. */
  readonly name: string | null
  readonly newName: string
  readonly expectedRevision: string
  readonly config: NativeMcpConfigInput
}
export interface NativeMcpRemoveRequest { readonly origin: NativeMcpOrigin; readonly name: string; readonly expectedRevision: string }
export interface NativeMcpEnableRequest { readonly origin: NativeMcpOrigin; readonly name: string; readonly enabled: boolean; readonly expectedRevision: string }
export interface NativeMcpMutationResult {
  readonly outcome: 'saved' | 'conflict' | 'invalid' | 'rejected'
  readonly revision: string | null
  readonly reason: string | null
  /** The adapter reads config at session start only; a Pi restart (or /reload) applies the change. */
  readonly restartRequired: boolean
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts {
    'native.mcp.list': { readonly request: Record<string, never>; readonly response: NativeMcpListResult }
    'native.mcp.save': { readonly request: NativeMcpSaveRequest; readonly response: NativeMcpMutationResult }
    'native.mcp.remove': { readonly request: NativeMcpRemoveRequest; readonly response: NativeMcpMutationResult }
    'native.mcp.enable': { readonly request: NativeMcpEnableRequest; readonly response: NativeMcpMutationResult }
  }
}

const str = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max
const nonEmpty = (value: unknown, max = 4096): value is string => str(value, max) && value.length > 0
const optional = <T>(value: Record<string, unknown>, key: string, check: (v: unknown) => v is T): boolean => !Object.hasOwn(value, key) || value[key] === undefined || check(value[key])
const bool = (value: unknown): value is boolean => typeof value === 'boolean'
const posInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000
const revision = (value: unknown): value is string => value === '' || (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
const origin = (value: unknown): value is NativeMcpOrigin => NATIVE_MCP_ORIGINS.includes(value as NativeMcpOrigin)
const strList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every((item) => str(item, 4096))
const kvList = (value: unknown): value is NativeMcpKvInput[] => Array.isArray(value) && value.length <= 256 && value.every((item) => isPlainRecord(item)
  && Object.keys(item).every((key) => key === 'key' || key === 'value') && nonEmpty(item.key, 256) && (item.value === undefined || str(item.value, 16384)))

export function isNativeMcpEmptyRequest(value: unknown): value is Record<string, never> {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

export function isNativeMcpConfigInput(value: unknown): value is NativeMcpConfigInput {
  if (!isPlainRecord(value)) return false
  const allowed = ['transport', 'command', 'args', 'cwd', 'url', 'keepUrlExtras', 'env', 'headers', 'lifecycle', 'auth', 'directTools', 'idleTimeout', 'requestTimeoutMs', 'exposeResources', 'debug', 'includeTools', 'excludeTools', 'disabled']
  return Object.keys(value).every((key) => allowed.includes(key))
    && ['stdio', 'http', 'sse', 'override'].includes(value.transport as string)
    && optional(value, 'command', (v): v is string => str(v)) && optional(value, 'args', strList) && optional(value, 'cwd', (v): v is string => str(v))
    && optional(value, 'url', (v): v is string => str(v, 8192)) && optional(value, 'keepUrlExtras', bool)
    && optional(value, 'env', kvList) && optional(value, 'headers', kvList)
    && optional(value, 'lifecycle', (v): v is NativeMcpLifecycle => NATIVE_MCP_LIFECYCLES.includes(v as NativeMcpLifecycle))
    && optional(value, 'auth', (v): v is NativeMcpAuth => NATIVE_MCP_AUTH.includes(v as NativeMcpAuth))
    && optional(value, 'directTools', (v): v is boolean | 'keep' => bool(v) || v === 'keep')
    && optional(value, 'idleTimeout', posInt) && optional(value, 'requestTimeoutMs', posInt)
    && optional(value, 'exposeResources', bool) && optional(value, 'debug', bool) && optional(value, 'disabled', bool)
    && optional(value, 'includeTools', strList) && optional(value, 'excludeTools', strList)
}

export function isNativeMcpSaveRequest(value: unknown): value is NativeMcpSaveRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['origin', 'name', 'newName', 'expectedRevision', 'config'])
    && origin(value.origin) && (value.name === null || nonEmpty(value.name, 256)) && nonEmpty(value.newName, 256)
    && revision(value.expectedRevision) && isNativeMcpConfigInput(value.config)
}
export function isNativeMcpRemoveRequest(value: unknown): value is NativeMcpRemoveRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['origin', 'name', 'expectedRevision']) && origin(value.origin) && nonEmpty(value.name, 256) && revision(value.expectedRevision)
}
export function isNativeMcpEnableRequest(value: unknown): value is NativeMcpEnableRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['origin', 'name', 'enabled', 'expectedRevision'])
    && origin(value.origin) && nonEmpty(value.name, 256) && bool(value.enabled) && revision(value.expectedRevision)
}

const kvView = (value: unknown): boolean => isPlainRecord(value) && nonEmpty(value.key, 256) && ['literal', 'reference', 'command'].includes(value.kind as string)
export function isNativeMcpListResult(value: unknown): value is NativeMcpListResult {
  return isPlainRecord(value) && hasExactKeys(value, ['servers', 'files', 'hasProject']) && bool(value.hasProject)
    && Array.isArray(value.files) && value.files.every((file) => isPlainRecord(file) && origin(file.origin) && nonEmpty(file.path, 4096) && bool(file.exists) && bool(file.writable) && revision(file.revision))
    && Array.isArray(value.servers) && value.servers.every((server) => isPlainRecord(server) && nonEmpty(server.id, 600) && nonEmpty(server.name, 256) && origin(server.origin)
      && Array.isArray(server.env) && server.env.every(kvView) && Array.isArray(server.headers) && server.headers.every(kvView))
}
export function isNativeMcpMutationResult(value: unknown): value is NativeMcpMutationResult {
  return isPlainRecord(value) && hasExactKeys(value, ['outcome', 'revision', 'reason', 'restartRequired'])
    && ['saved', 'conflict', 'invalid', 'rejected'].includes(value.outcome as string)
    && (value.revision === null || revision(value.revision)) && (value.reason === null || typeof value.reason === 'string') && bool(value.restartRequired)
}
