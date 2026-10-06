import {
  hasExactKeys,
  isPlainRecord,
  isRuntimeScope,
  type RuntimeScope,
} from './ipc-contracts.ts'

export const HERDR_LAUNCH_CAPABILITY = 'herdr.launch.prepare' as const
export const LAUNCH_ENV = Object.freeze({
  token: 'PI_DESKTOP_LAUNCH_TOKEN',
  endpoint: 'PI_DESKTOP_LAUNCH_ENDPOINT',
})

export type LaunchTrustDecision = 'trusted' | 'denied' | 'undecided'

export interface LaunchResourceConstraints {
  readonly allowedCwdRoot: string
  readonly projectExtensions: boolean
  readonly projectSkills: boolean
  readonly projectPromptTemplates: boolean
  readonly projectThemes: boolean
  readonly projectContextFiles: boolean
  readonly projectMcpConfig: boolean
}

/** Serializable, immutable launch scope transferred to the single child process. */
export interface LaunchScopeDescriptor {
  readonly launchId: string
  readonly runtimeScope: RuntimeScope
  readonly runtimeId: string
  readonly workspaceRoot: string
  readonly agentDir: string
  readonly trustDecision: LaunchTrustDecision
  readonly targetCwd: string
  readonly targetAgentDir: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly resourceConstraints: LaunchResourceConstraints
  readonly herdr: {
    readonly socketPath: string
    readonly paneId: string
  }
}

export type LaunchExchangeRejection = 'invalid' | 'expired' | 'used' | 'revoked' | 'unavailable'

export type LaunchExchangeResponse =
  | { readonly outcome: 'granted'; readonly descriptor: LaunchScopeDescriptor }
  | { readonly outcome: 'rejected'; readonly reason: LaunchExchangeRejection }

export interface HerdrLaunchAgentSpec {
  readonly kind: 'fresh' | 'resume' | 'handoff'
  readonly launchId?: string
  readonly cwd: string
  readonly agentDir?: string
  readonly sessionFile?: string
  readonly sourceSessionFile?: string
  /** Herdr pane id returned by the app-local pane creation operation. */
  readonly herdrPaneId: string
  /** Native Pi CLI argv. The executable and launch capability are never caller-controlled. */
  readonly args: readonly string[]
}

export interface HerdrLaunchPrepareRequest {
  readonly agentSpec: HerdrLaunchAgentSpec
}

export interface HerdrLaunchCommand {
  readonly executable: 'pi'
  readonly args: readonly string[]
}

export interface HerdrLaunchPreparedResponse {
  readonly command: HerdrLaunchCommand
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
}

export interface HerdrLaunchCapabilityContracts {
  'herdr.launch.prepare': {
    readonly request: HerdrLaunchPrepareRequest
    readonly response: HerdrLaunchPreparedResponse
  }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends HerdrLaunchCapabilityContracts {}
}

const MAX_PATH_LENGTH = 4_096
const MAX_RUNTIME_ID_LENGTH = 160
const MAX_LAUNCH_ID_LENGTH = 128
const MAX_ARGS = 256
const MAX_ARG_LENGTH = 16_384
const MAX_ARGS_TOTAL_LENGTH = 128 * 1024
const TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{40,128}$/
const LAUNCH_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

function isBoundedPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PATH_LENGTH
    && !value.includes('\0')
}

function isAbsolutePath(value: unknown): value is string {
  return isBoundedPath(value) && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
}

function isLaunchId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_LAUNCH_ID_LENGTH && LAUNCH_ID_PATTERN.test(value)
}

function isArgs(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGS) return false
  let totalLength = 0
  for (const item of value) {
    if (typeof item !== 'string' || item.length > MAX_ARG_LENGTH || item.includes('\0')) return false
    totalLength += item.length
    if (totalLength > MAX_ARGS_TOTAL_LENGTH) return false
  }
  return true
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key))
}

function isResourceConstraints(value: unknown): value is LaunchResourceConstraints {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      'allowedCwdRoot', 'projectExtensions', 'projectSkills', 'projectPromptTemplates',
      'projectThemes', 'projectContextFiles', 'projectMcpConfig',
    ])
    && isAbsolutePath(value.allowedCwdRoot)
    && typeof value.projectExtensions === 'boolean'
    && typeof value.projectSkills === 'boolean'
    && typeof value.projectPromptTemplates === 'boolean'
    && typeof value.projectThemes === 'boolean'
    && typeof value.projectContextFiles === 'boolean'
    && typeof value.projectMcpConfig === 'boolean'
}

function isHerdrEndpoint(value: unknown): value is { readonly socketPath: string; readonly paneId: string } {
  return isPlainRecord(value)
    && hasExactKeys(value, ['socketPath', 'paneId'])
    && isBoundedPath(value.socketPath)
    && typeof value.paneId === 'string'
    && value.paneId.length > 0
    && value.paneId.length <= 256
    && !value.paneId.includes('\0')
}

export function isLaunchScopeDescriptor(value: unknown): value is LaunchScopeDescriptor {
  if (!isPlainRecord(value)) return false
  return hasExactKeys(value, [
    'launchId', 'runtimeScope', 'runtimeId', 'workspaceRoot', 'agentDir', 'trustDecision',
    'targetCwd', 'targetAgentDir', 'issuedAt', 'expiresAt', 'resourceConstraints', 'herdr',
  ])
    && isLaunchId(value.launchId)
    && isRuntimeScope(value.runtimeScope)
    && typeof value.runtimeId === 'string'
    && value.runtimeId.length > 0
    && value.runtimeId.length <= MAX_RUNTIME_ID_LENGTH
    && /^[a-zA-Z0-9._:-]+$/.test(value.runtimeId)
    && isAbsolutePath(value.workspaceRoot)
    && isAbsolutePath(value.agentDir)
    && (value.trustDecision === 'trusted' || value.trustDecision === 'denied' || value.trustDecision === 'undecided')
    && isAbsolutePath(value.targetCwd)
    && isAbsolutePath(value.targetAgentDir)
    && Number.isSafeInteger(value.issuedAt)
    && Number.isSafeInteger(value.expiresAt)
    && (value.issuedAt as number) >= 0
    && (value.expiresAt as number) > (value.issuedAt as number)
    && (value.expiresAt as number) - (value.issuedAt as number) <= 60_000
    && isResourceConstraints(value.resourceConstraints)
    && isHerdrEndpoint(value.herdr)
}

export function isLaunchExchangeRequest(value: unknown): value is { readonly token: string } {
  return isPlainRecord(value)
    && hasExactKeys(value, ['token'])
    && typeof value.token === 'string'
    && value.token.length <= 1_200
    && TOKEN_PATTERN.test(value.token)
}

export function isLaunchExchangeResponse(value: unknown): value is LaunchExchangeResponse {
  if (!isPlainRecord(value)) return false
  if (value.outcome === 'granted') {
    return hasExactKeys(value, ['outcome', 'descriptor']) && isLaunchScopeDescriptor(value.descriptor)
  }
  return value.outcome === 'rejected'
    && hasExactKeys(value, ['outcome', 'reason'])
    && ['invalid', 'expired', 'used', 'revoked', 'unavailable'].includes(value.reason as string)
}

function validAgentSpec(value: unknown): value is HerdrLaunchAgentSpec {
  if (!isPlainRecord(value)) return false
  const common = ['kind', 'cwd', 'args', 'herdrPaneId']
  const optional = ['launchId', 'agentDir', 'sessionFile', 'sourceSessionFile']
  if (!hasOnlyKeys(value, common, optional)
    || !['fresh', 'resume', 'handoff'].includes(value.kind as string)
    || !isAbsolutePath(value.cwd)
    || !isArgs(value.args)) return false
  if (value.launchId !== undefined && !isLaunchId(value.launchId)) return false
  if (value.agentDir !== undefined && !isAbsolutePath(value.agentDir)) return false
  if (value.sessionFile !== undefined && !isAbsolutePath(value.sessionFile)) return false
  if (value.sourceSessionFile !== undefined && !isAbsolutePath(value.sourceSessionFile)) return false
  if (typeof value.herdrPaneId !== 'string'
    || value.herdrPaneId.length === 0
    || value.herdrPaneId.length > 256
    || value.herdrPaneId.includes('\0')) return false
  if (value.sessionFile === undefined) return false
  if (value.kind === 'handoff' && value.sourceSessionFile === undefined) return false
  return value.kind !== 'fresh' || value.sourceSessionFile === undefined
}

export function isHerdrLaunchPrepareRequest(value: unknown): value is HerdrLaunchPrepareRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['agentSpec'])
    && validAgentSpec(value.agentSpec)
}

function isCommand(value: unknown): value is HerdrLaunchCommand {
  return isPlainRecord(value)
    && hasExactKeys(value, ['executable', 'args'])
    && value.executable === 'pi'
    && isArgs(value.args)
}

export function isHerdrLaunchPreparedResponse(value: unknown): value is HerdrLaunchPreparedResponse {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['command', 'env', 'cwd'])
    || !isCommand(value.command)
    || !isAbsolutePath(value.cwd)
    || !isPlainRecord(value.env)) return false
  const allowedEnvironment = new Set([
    'PI_CODING_AGENT_DIR', 'PI_DESKTOP_LAUNCH_TOKEN', 'PI_DESKTOP_LAUNCH_ENDPOINT',
    'HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID',
  ])
  return hasExactKeys(value.env, [
    'PI_CODING_AGENT_DIR', 'PI_DESKTOP_LAUNCH_TOKEN', 'PI_DESKTOP_LAUNCH_ENDPOINT',
    'HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID',
  ])
    && Object.entries(value.env).every(([key, item]) => allowedEnvironment.has(key)
    && typeof item === 'string'
    && item.length <= MAX_PATH_LENGTH
    && !item.includes('\0'))
    && typeof value.env.PI_CODING_AGENT_DIR === 'string'
    && typeof value.env.PI_DESKTOP_LAUNCH_TOKEN === 'string'
    && TOKEN_PATTERN.test(value.env.PI_DESKTOP_LAUNCH_TOKEN)
    && typeof value.env.PI_DESKTOP_LAUNCH_ENDPOINT === 'string'
    && value.env.HERDR_ENV === '1'
    && typeof value.env.HERDR_SOCKET_PATH === 'string'
    && typeof value.env.HERDR_PANE_ID === 'string'
}
