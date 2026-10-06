import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'
import { isAbsolute } from 'node:path'
import type {
  McpConfigScope,
  McpToolExposureResolution,
} from '../../shared/mcp.ts'
import { isPlainRecord } from '../../shared/ipc-contracts.ts'
import { ScopedSettingsService } from '../config/settings-service.ts'
import type {
  NativeMcpExposure,
  NativeMcpFacade,
  NativeMcpServerState,
  NativeMcpTool,
} from './native-facade.ts'

export type { McpToolExposureResolution } from '../../shared/mcp.ts'
export type McpToolExposureSource = McpToolExposureResolution['source']

export interface McpExposureContext {
  readonly cwd: string
  readonly projectTrusted: boolean
  readonly nativeToolExposureConfigs?: Readonly<Record<string, Readonly<Record<string, NativeMcpExposure>>>>
  /** Rechecked after asynchronous native reads and immediately before persistence. */
  readonly reauthorize?: () => boolean
}

export interface McpExposureSettingsSnapshot {
  readonly userOverrides: Readonly<Record<string, Readonly<Record<string, NativeMcpExposure>>>>
  readonly projectOverrides: Readonly<Record<string, Readonly<Record<string, NativeMcpExposure>>>> | undefined
  readonly projectTrusted: boolean
  readonly userRevision: number
  readonly projectRevision: number | null
}

export interface McpExposureSettingsWrite {
  readonly scope: McpConfigScope
  readonly expectedRevision: number
  readonly server: string
  readonly tool: string
  readonly exposure: NativeMcpExposure | null
}

export interface McpExposureSettingsMutation {
  readonly outcome: 'saved' | 'conflict'
  readonly snapshot: McpExposureSettingsSnapshot
}

/** Persistence boundary for the app-owned overlays; revisions are native file revisions. */
export interface McpExposureSettingsStore {
  readExposureOverrides(context: McpExposureContext): McpExposureSettingsSnapshot | Promise<McpExposureSettingsSnapshot>
  writeExposureOverride(
    context: McpExposureContext,
    input: McpExposureSettingsWrite,
  ): McpExposureSettingsMutation | Promise<McpExposureSettingsMutation>
}

export interface ScopedMcpExposureSettingsStoreOptions {
  readonly agentDir: string
}

const EXPOSURES: ReadonlySet<string> = new Set(['codemode', 'deferred', 'direct', 'hidden'])
const USER_EXPOSURE_PATH = 'mcp-exposure.json'
const PROJECT_EXPOSURE_PATH = `${CONFIG_DIR_NAME}/mcp-exposure.json`
const MAX_EXPOSURE_OVERRIDES = 8_192

function isExposure(value: unknown): value is NativeMcpExposure {
  return typeof value === 'string' && EXPOSURES.has(value)
}

function isServerName(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value)
}

function isToolName(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes('\0')
    && !['__proto__', 'constructor', 'prototype'].includes(value)
}

function encodedOverrideKey(server: string, tool: string): string {
  return Buffer.from(JSON.stringify([server, tool]), 'utf8').toString('base64url')
}

function decodedOverrideKey(key: string): { readonly server: string; readonly tool: string } | undefined {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(key)) return undefined
    const decoded = Buffer.from(key, 'base64url')
    if (decoded.toString('base64url') !== key) return undefined
    const value: unknown = JSON.parse(decoded.toString('utf8'))
    if (!Array.isArray(value) || value.length !== 2
      || typeof value[0] !== 'string' || typeof value[1] !== 'string'
      || !isServerName(value[0]) || !isToolName(value[1])) return undefined
    return { server: value[0], tool: value[1] }
  } catch {
    return undefined
  }
}

function collectOverrides(document: Record<string, unknown>): Record<string, Record<string, NativeMcpExposure>> {
  const result = Object.create(null) as Record<string, Record<string, NativeMcpExposure>>
  const stored = document.toolExposure
  if (stored === undefined) return result
  if (!isPlainRecord(stored) || Object.keys(stored).length > MAX_EXPOSURE_OVERRIDES) {
    throw new TypeError('MCP exposure overrides are invalid.')
  }
  for (const [encoded, exposure] of Object.entries(stored)) {
    const identity = decodedOverrideKey(encoded)
    if (!identity || !isExposure(exposure)) throw new TypeError('MCP exposure override entry is invalid.')
    const serverOverrides = result[identity.server] ?? (result[identity.server] = Object.create(null) as Record<string, NativeMcpExposure>)
    serverOverrides[identity.tool] = exposure
  }
  return result
}

/** Persists overrides in scoped, symlink-safe settings files, separate from native mcp.json. */
export class ScopedMcpExposureSettingsStore implements McpExposureSettingsStore {
  private readonly agentDir: string

  constructor(options: ScopedMcpExposureSettingsStoreOptions) {
    this.agentDir = options.agentDir
    // Constructor validates roots and normalizes them consistently with writes.
    new ScopedSettingsService({ user: this.agentDir })
  }

  readExposureOverrides(context: McpExposureContext): McpExposureSettingsSnapshot {
    const settings = this.settings(context)
    const user = settings.readJson('user', USER_EXPOSURE_PATH)
    const project = context.projectTrusted ? settings.readJson('project', PROJECT_EXPOSURE_PATH) : undefined
    return {
      userOverrides: collectOverrides(user.document),
      projectOverrides: project ? collectOverrides(project.document) : undefined,
      projectTrusted: context.projectTrusted,
      userRevision: user.revision,
      projectRevision: project?.revision ?? null,
    }
  }

  writeExposureOverride(
    context: McpExposureContext,
    input: McpExposureSettingsWrite,
  ): McpExposureSettingsMutation {
    if (!isServerName(input.server) || !isToolName(input.tool)
      || (input.exposure !== null && !isExposure(input.exposure))) {
      throw new TypeError('MCP exposure override request is invalid.')
    }
    if (input.scope === 'project' && !context.projectTrusted) {
      throw new TypeError('Project MCP exposure overrides require a trusted workspace.')
    }
    const settings = this.settings(context)
    const path = input.scope === 'user' ? USER_EXPOSURE_PATH : PROJECT_EXPOSURE_PATH
    const key = encodedOverrideKey(input.server, input.tool)
    const mutation = input.exposure === null
      ? settings.updateJson(input.scope, path, input.expectedRevision, {}, [`toolExposure.${key}`])
      : settings.updateJson(input.scope, path, input.expectedRevision, { toolExposure: { [key]: input.exposure } })
    return {
      outcome: mutation.outcome,
      snapshot: this.readExposureOverrides(context),
    }
  }

  private settings(context: McpExposureContext): ScopedSettingsService {
    if (!context.cwd || !isAbsolute(context.cwd) || context.cwd.includes('\0')) {
      throw new TypeError('MCP exposure workspace path is invalid.')
    }
    return new ScopedSettingsService({ user: this.agentDir, project: context.cwd })
  }
}

export interface McpExposureServiceOptions {
  readonly native: Pick<NativeMcpFacade, 'listServers' | 'getServerState' | 'listTools'>
  readonly settings: McpExposureSettingsStore
  /** Native per-tool `toolExposure` entries after global/project config merge. */
  readonly nativeToolExposureConfigs?: Readonly<Record<string, Readonly<Record<string, NativeMcpExposure>>>>
  readonly resolveNativeToolExposure?: (server: NativeMcpServerState, toolName: string) => NativeMcpExposure | undefined
}

export interface McpExposureReadResult {
  readonly outcome: 'resolved' | 'unavailable'
  readonly resolution: McpToolExposureResolution | null
  readonly userRevision: number | null
  readonly projectRevision: number | null
}

export type McpExposureUpdateResult = Omit<McpExposureReadResult, 'outcome'> & {
  readonly outcome: 'saved' | 'conflict' | 'unavailable'
}

function patternMatches(pattern: string, toolName: string): boolean {
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${expression}$`).test(toolName)
}

function configuredNativeToolExposure(
  config: Readonly<Record<string, NativeMcpExposure>> | undefined,
  toolName: string,
): NativeMcpExposure | undefined {
  if (!config) return undefined
  const exact = config[toolName]
  if (isExposure(exact)) return exact
  for (const [pattern, exposure] of Object.entries(config)) {
    if (pattern.includes('*') && patternMatches(pattern, toolName) && isExposure(exposure)) return exposure
  }
  return undefined
}

export class McpExposureService {
  private readonly native: McpExposureServiceOptions['native']
  private readonly settings: McpExposureSettingsStore
  private readonly nativeToolExposureConfigs: McpExposureServiceOptions['nativeToolExposureConfigs']
  private readonly resolveNativeToolExposure?: McpExposureServiceOptions['resolveNativeToolExposure']

  constructor(options: McpExposureServiceOptions) {
    this.native = options.native
    this.settings = options.settings
    this.nativeToolExposureConfigs = options.nativeToolExposureConfigs
    this.resolveNativeToolExposure = options.resolveNativeToolExposure
  }

  usesNativeFacade(native: NativeMcpFacade): boolean {
    return this.native === native
  }

  async resolveTool(serverName: string, toolName: string, context: McpExposureContext): Promise<McpToolExposureResolution> {
    const snapshot = await this.settings.readExposureOverrides(context)
    if (!this.contextIsCurrent(context)) throw new TypeError('MCP exposure authorization is no longer current.')
    return this.resolveWithSnapshot(serverName, toolName, snapshot, context)
  }

  async resolveTools(
    serverName: string,
    toolNames: readonly string[],
    context: McpExposureContext,
  ): Promise<readonly McpToolExposureResolution[]> {
    const snapshot = await this.settings.readExposureOverrides(context)
    if (!this.contextIsCurrent(context)) throw new TypeError('MCP exposure authorization is no longer current.')
    return toolNames.map((toolName) => this.resolveWithSnapshot(serverName, toolName, snapshot, context))
  }

  async readToolExposure(
    serverName: string,
    toolName: string,
    context: McpExposureContext,
  ): Promise<McpExposureReadResult> {
    const server = this.native.getServerState(serverName)
    if (!server || !server.config.enabled) {
      return { outcome: 'unavailable', resolution: null, userRevision: null, projectRevision: null }
    }
    const tools = await this.native.listTools(serverName)
    if (!tools.some((tool) => tool.name === toolName) || !this.contextIsCurrent(context)) {
      return { outcome: 'unavailable', resolution: null, userRevision: null, projectRevision: null }
    }
    const snapshot = await this.settings.readExposureOverrides(context)
    if (!this.contextIsCurrent(context)) {
      return { outcome: 'unavailable', resolution: null, userRevision: null, projectRevision: null }
    }
    return {
      outcome: 'resolved',
      resolution: this.resolveWithSnapshot(serverName, toolName, snapshot, context),
      userRevision: snapshot.userRevision,
      projectRevision: snapshot.projectRevision,
    }
  }

  async updateToolExposure(
    input: McpExposureSettingsWrite,
    context: McpExposureContext,
  ): Promise<McpExposureUpdateResult> {
    const server = this.native.getServerState(input.server)
    if (!server || !server.config.enabled) {
      return { outcome: 'unavailable', resolution: null, userRevision: null, projectRevision: null }
    }
    const tools = await this.native.listTools(input.server)
    if (!tools.some((tool) => tool.name === input.tool) || !this.contextIsCurrent(context)) {
      return { outcome: 'unavailable', resolution: null, userRevision: null, projectRevision: null }
    }
    const mutation = await this.settings.writeExposureOverride(context, input)
    if (!this.contextIsCurrent(context)) {
      return { outcome: 'unavailable', resolution: null, userRevision: null, projectRevision: null }
    }
    return {
      outcome: mutation.outcome,
      resolution: this.resolveWithSnapshot(input.server, input.tool, mutation.snapshot, context),
      userRevision: mutation.snapshot.userRevision,
      projectRevision: mutation.snapshot.projectRevision,
    }
  }

  async resolveServerTools(
    serverName: string,
    context: McpExposureContext,
  ): Promise<readonly (NativeMcpTool & { readonly exposure: McpToolExposureResolution })[]> {
    const tools = await this.native.listTools(serverName)
    const exposures = await this.resolveTools(serverName, tools.map((tool) => tool.name), context)
    return tools.map((tool, index) => ({
      ...tool,
      exposure: exposures[index]!,
    }))
  }

  async resolveCatalog(
    context: McpExposureContext,
  ): Promise<readonly (NativeMcpTool & { readonly exposure: McpToolExposureResolution })[]> {
    const servers = this.native.listServers().filter((server) => server.config.enabled && server.state === 'connected')
    const result: Array<NativeMcpTool & { readonly exposure: McpToolExposureResolution }> = []
    for (const server of servers.slice(0, 100)) {
      const tools = await this.resolveServerTools(server.name, context)
      result.push(...tools.slice(0, Math.max(0, 512 - result.length)))
      if (result.length >= 512) break
    }
    return result
  }

  private resolveWithSnapshot(
    serverName: string,
    toolName: string,
    snapshot: McpExposureSettingsSnapshot,
    context: McpExposureContext,
  ): McpToolExposureResolution {
    const server = this.native.getServerState(serverName)
    const nativeToolExposure = server
      ? this.resolveNativeToolExposure?.(server, toolName)
        ?? configuredNativeToolExposure(
          context.nativeToolExposureConfigs?.[serverName] ?? this.nativeToolExposureConfigs?.[serverName],
          toolName,
        )
      : undefined
    const nativeServerExposure = server?.config.exposure
    const nativeExposure = isExposure(nativeToolExposure)
      ? nativeToolExposure
      : isExposure(nativeServerExposure)
        ? nativeServerExposure
        : 'codemode'
    const nativeSource = isExposure(nativeToolExposure)
      ? 'native-tool'
      : isExposure(nativeServerExposure)
        ? 'native-server'
        : 'native-default'
    const project = snapshot.projectTrusted ? snapshot.projectOverrides?.[serverName]?.[toolName] : undefined
    const user = snapshot.userOverrides[serverName]?.[toolName]
    const exposure = project ?? user ?? nativeExposure
    const source = project ? 'project' : user ? 'user' : nativeSource
    return {
      server: serverName,
      tool: toolName,
      exposure,
      source,
      nativeExposure,
      nativeSource,
      serverState: server?.state ?? 'unknown',
    }
  }

  private contextIsCurrent(context: McpExposureContext): boolean {
    try {
      return context.projectTrusted === true && (context.reauthorize?.() ?? true) === true
    } catch {
      return false
    }
  }
}

export function createMcpExposureService(options: McpExposureServiceOptions): McpExposureService {
  return new McpExposureService(options)
}

export function createScopedMcpExposureSettingsStore(
  options: ScopedMcpExposureSettingsStoreOptions,
): McpExposureSettingsStore {
  return new ScopedMcpExposureSettingsStore(options)
}
