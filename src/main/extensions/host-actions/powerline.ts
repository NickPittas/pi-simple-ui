import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RuntimeScope } from '../../../shared/ipc-contracts.ts'
import {
  HOST_ACTIONS,
  HOST_ACTION_LIMITS,
  isEmptyHostActionRequest,
  isPowerlineQueueClearResponse,
  isPowerlineQueueReadResponse,
  isPowerlineSettingsReadResponse,
  isPowerlineSettingsWriteRequest,
  isPowerlineSettingsWriteResponse,
  isPowerlineStashHistoryResponse,
  isPowerlineStatusReadRequest,
  isPowerlineStatusReadResponse,
  type EmptyHostActionRequest,
  type PowerlinePreset,
  type PowerlineQueueClearResponse,
  type PowerlineQueueReadResponse,
  type PowerlineSegment,
  type PowerlineSeparator,
  type PowerlineSettings,
  type PowerlineSettingsReadResponse,
  type PowerlineSettingsWriteRequest,
  type PowerlineSettingsWriteResponse,
  type PowerlineStashHistoryResponse,
  type PowerlineStatusReadRequest,
  type PowerlineStatusReadResponse,
} from '../../../shared/host-actions.ts'
import type { ChatInputService } from '../../pi/input-service.ts'
import type { AuthorizedIpcCaller, CapabilityDefinition } from '../../ipc/register.ts'

export interface PowerlineRuntimeBridge {
  /** Public parent accessors for the active session title, model label, and cwd. */
  readStatusText(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    field: 'title' | 'model' | 'cwd',
  ): Promise<string> | string
}

/** Requires-runtime-bridge accessor; runtime state is never reached through extension-private globals. */
export interface PowerlineRequiresRuntimeBridgeAccessor {
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): PowerlineRuntimeBridge | null
}

export interface PowerlineHostActionOptions {
  readonly chatInput: ChatInputService
  readonly bridge: PowerlineRequiresRuntimeBridgeAccessor
  readonly authorizeRuntimeCaller: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => boolean
}

function requireScope(
  authorizeRuntimeCaller: PowerlineHostActionOptions['authorizeRuntimeCaller'],
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): RuntimeScope {
  if (!scope || !authorizeRuntimeCaller(caller, scope)) throw new Error('A current authorized runtime scope is required for Powerline actions.')
  return scope
}

function requireBridge(
  accessor: PowerlineRequiresRuntimeBridgeAccessor,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope,
): PowerlineRuntimeBridge {
  const bridge = accessor.resolve(caller, scope)
  if (!bridge) throw new Error('Powerline runtime bridge is unavailable.')
  return bridge
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim()
  if (!configured) return join(getHomeDir(), '.pi', 'agent')
  if (configured === '~') return getHomeDir()
  if (configured.startsWith('~/') || (process.platform === 'win32' && configured.startsWith('~\\'))) {
    return join(getHomeDir(), configured.slice(2))
  }
  if (configured.startsWith('file://')) return fileURLToPath(configured)
  return configured
}

function globalSettingsPath(): string {
  return join(getAgentDir(), 'settings.json')
}

function projectSettingsPath(cwd: string): string {
  return join(cwd, '.pi', 'settings.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readSettingsFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function readWritableSettingsFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function mergeRecords(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = result[key]
    result[key] = isRecord(current) && isRecord(value) ? mergeRecords(current, value) : value
  }
  return result
}

const SEGMENTS: readonly string[] = [
  'model', 'shell_mode', 'path', 'git', 'subagents', 'queue', 'token_in', 'token_out', 'token_total', 'cost',
  'context_pct', 'context_total', 'time_spent', 'time', 'session', 'hostname', 'cache_read', 'cache_write', 'thinking', 'extension_statuses',
]
const PRESETS: readonly string[] = ['default', 'minimal', 'compact', 'full', 'nerd', 'ascii']
const SEPARATORS: readonly string[] = ['powerline', 'powerline-thin', 'slash', 'pipe', 'block', 'none', 'ascii', 'dot', 'chevron', 'star']

function readAllowlistedPowerlineSettings(settings: Record<string, unknown>): PowerlineSettings {
  const powerline = isRecord(settings.powerline) ? settings.powerline : {}
  const result: {
    preset?: PowerlinePreset
    placement?: 'above' | 'below'
    separator?: PowerlineSeparator
    disabledSegments?: PowerlineSegment[]
    welcome?: boolean
    stashSharpSShortcut?: boolean
    compactPromptMode?: 'queue' | 'native'
    sendDelayMs?: number
    autoFollowUp?: boolean
  } = {}

  if (typeof powerline.preset === 'string' && PRESETS.includes(powerline.preset)) result.preset = powerline.preset as PowerlinePreset
  if (powerline.placement === 'above' || powerline.placement === 'below') result.placement = powerline.placement
  if (typeof powerline.separator === 'string' && SEPARATORS.includes(powerline.separator)) result.separator = powerline.separator as PowerlineSeparator
  if (Array.isArray(powerline.disabledSegments)) {
    result.disabledSegments = powerline.disabledSegments
      .filter((segment): segment is string => typeof segment === 'string' && SEGMENTS.includes(segment))
      .slice(0, HOST_ACTION_LIMITS.settingsSegments) as PowerlineSegment[]
  }
  if (typeof powerline.welcome === 'boolean') result.welcome = powerline.welcome
  if (typeof powerline.stashSharpSShortcut === 'boolean') result.stashSharpSShortcut = powerline.stashSharpSShortcut
  if (typeof powerline.sendDelayMs === 'number' && Number.isSafeInteger(powerline.sendDelayMs) && powerline.sendDelayMs >= 0 && powerline.sendDelayMs <= 30_000) {
    result.sendDelayMs = powerline.sendDelayMs
  }
  if (typeof powerline.autoFollowUp === 'boolean') result.autoFollowUp = powerline.autoFollowUp
  if (isRecord(powerline.queue)) {
    if (powerline.queue.compactPromptMode === 'queue' || powerline.queue.compactPromptMode === 'native') {
      result.compactPromptMode = powerline.queue.compactPromptMode
    }
  }
  return result
}

function normalizeSettingsPatch(patch: PowerlineSettings): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  if (patch.preset !== undefined) normalized.preset = patch.preset
  if (patch.placement !== undefined) normalized.placement = patch.placement
  if (patch.separator !== undefined) normalized.separator = patch.separator
  if (patch.disabledSegments !== undefined) normalized.disabledSegments = [...patch.disabledSegments]
  if (patch.welcome !== undefined) normalized.welcome = patch.welcome
  if (patch.stashSharpSShortcut !== undefined) normalized.stashSharpSShortcut = patch.stashSharpSShortcut
  if (patch.sendDelayMs !== undefined) normalized.sendDelayMs = patch.sendDelayMs
  if (patch.autoFollowUp !== undefined) normalized.autoFollowUp = patch.autoFollowUp
  if (patch.compactPromptMode !== undefined) normalized.queue = { compactPromptMode: patch.compactPromptMode }
  return normalized
}

function writeSettings(cwd: string, patch: PowerlineSettings): boolean {
  const globalPath = globalSettingsPath()
  const projectPath = projectSettingsPath(cwd)
  const globalSettings = readWritableSettingsFile(globalPath)
  const projectSettings = readWritableSettingsFile(projectPath)
  if (!globalSettings || !projectSettings) return false

  const writeToProject = Object.hasOwn(projectSettings, 'powerline')
  const path = writeToProject ? projectPath : globalPath
  const settings = writeToProject ? projectSettings : globalSettings
  const existingPowerline = isRecord(settings.powerline) ? settings.powerline : {}
  const update = normalizeSettingsPatch(patch)
  const nextPowerline = { ...existingPowerline, ...update }
  if (isRecord(update.queue)) {
    nextPowerline.queue = { ...(isRecord(existingPowerline.queue) ? existingPowerline.queue : {}), ...update.queue }
  }
  settings.powerline = nextPowerline

  let temporaryPath: string | undefined
  try {
    mkdirSync(dirname(path), { recursive: true })
    temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporaryPath, path)
    return true
  } catch {
    if (temporaryPath) {
      try { rmSync(temporaryPath, { force: true }) } catch { /* best-effort temp-file cleanup */ }
    }
    return false
  }
}

function readStashHistory(): string[] {
  const path = join(getAgentDir(), 'powerline-footer', 'stash-history.json')
  try {
    if (!existsSync(path)) return []
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed) || !Array.isArray(parsed.history)) return []
    const history: string[] = []
    for (const entry of parsed.history) {
      if (typeof entry !== 'string' || !entry.trim() || history[history.length - 1] === entry) continue
      history.push(entry.slice(0, HOST_ACTION_LIMITS.stashHistoryCharacters))
      if (history.length >= HOST_ACTION_LIMITS.stashHistoryCount) break
    }
    return history
  } catch {
    return []
  }
}

function safeStatusText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, HOST_ACTION_LIMITS.statusCharacters)
}

/** Powerline host actions are distinctly namespaced and never register or intercept slash commands. */
export function registerPowerlineHostActions(options: PowerlineHostActionOptions): readonly CapabilityDefinition<any, any>[] {
  const queueRead: CapabilityDefinition<EmptyHostActionRequest, PowerlineQueueReadResponse> = {
    id: HOST_ACTIONS.powerline.queueRead,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isPowerlineQueueReadResponse,
    handle: ({ caller, scope }) => {
      const runtimeScope = requireScope(options.authorizeRuntimeCaller, caller, scope)
      return options.chatInput.readQueue(runtimeScope)
    },
  }

  const queueClear: CapabilityDefinition<EmptyHostActionRequest, PowerlineQueueClearResponse> = {
    id: HOST_ACTIONS.powerline.queueClear,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isPowerlineQueueClearResponse,
    handle: ({ caller, scope }) => {
      const runtimeScope = requireScope(options.authorizeRuntimeCaller, caller, scope)
      return options.chatInput.clearQueue(runtimeScope)
    },
  }

  const stashHistoryRead: CapabilityDefinition<EmptyHostActionRequest, PowerlineStashHistoryResponse> = {
    id: HOST_ACTIONS.powerline.stashHistoryRead,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isPowerlineStashHistoryResponse,
    handle: ({ caller, scope }) => {
      requireScope(options.authorizeRuntimeCaller, caller, scope)
      return { history: readStashHistory() }
    },
  }

  const settingsRead: CapabilityDefinition<EmptyHostActionRequest, PowerlineSettingsReadResponse> = {
    id: HOST_ACTIONS.powerline.settingsRead,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isPowerlineSettingsReadResponse,
    handle: async ({ caller, scope }) => {
      const runtimeScope = requireScope(options.authorizeRuntimeCaller, caller, scope)
      const bridge = requireBridge(options.bridge, caller, runtimeScope)
      const cwdValue = await bridge.readStatusText(caller, runtimeScope, 'cwd')
      if (!isAbsolute(cwdValue)) throw new Error('The active runtime did not provide an absolute working directory.')
      const globalPowerline = readSettingsFile(globalSettingsPath()).powerline
      const projectPowerline = readSettingsFile(projectSettingsPath(resolve(cwdValue))).powerline
      const mergedPowerline = mergeRecords(
        isRecord(globalPowerline) ? globalPowerline : {},
        isRecord(projectPowerline) ? projectPowerline : {},
      )
      return { settings: readAllowlistedPowerlineSettings({ powerline: mergedPowerline }) }
    },
  }

  const settingsWrite: CapabilityDefinition<PowerlineSettingsWriteRequest, PowerlineSettingsWriteResponse> = {
    id: HOST_ACTIONS.powerline.settingsWrite,
    scope: 'runtime',
    validateRequest: isPowerlineSettingsWriteRequest,
    validateResponse: isPowerlineSettingsWriteResponse,
    handle: async ({ caller, scope }, request) => {
      const runtimeScope = requireScope(options.authorizeRuntimeCaller, caller, scope)
      const bridge = requireBridge(options.bridge, caller, runtimeScope)
      const cwd = await bridge.readStatusText(caller, runtimeScope, 'cwd')
      if (!isAbsolute(cwd)) throw new Error('The active runtime did not provide an absolute working directory.')
      return { saved: writeSettings(resolve(cwd), request.patch) }
    },
  }

  const statusRead: CapabilityDefinition<PowerlineStatusReadRequest, PowerlineStatusReadResponse> = {
    id: HOST_ACTIONS.powerline.statusRead,
    scope: 'runtime',
    validateRequest: isPowerlineStatusReadRequest,
    validateResponse: isPowerlineStatusReadResponse,
    handle: async ({ caller, scope }, request) => {
      const runtimeScope = requireScope(options.authorizeRuntimeCaller, caller, scope)
      const bridge = requireBridge(options.bridge, caller, runtimeScope)
      const value = await bridge.readStatusText(caller, runtimeScope, request.field)
      return { field: request.field, value: safeStatusText(value) }
    },
  }

  return [queueRead, queueClear, stashHistoryRead, settingsRead, settingsWrite, statusRead]
}
