import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent'
import { isPlainRecord } from '../../shared/ipc-contracts.ts'
import { ScopedSettingsService } from '../config/settings-service.ts'
import type {
  McpConfigScope,
  McpExposure,
  McpHttpConfigInput,
  McpProjectOverrideInput,
  McpServerConfigInput,
  McpServerConfigView,
  McpServerMutationResponse,
  McpStdioConfigInput,
} from '../../shared/mcp.ts'

const CONFIG_MAX_BYTES = 1024 * 1024
const SERVER_NAME = /^[A-Za-z0-9_-]{1,128}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/
const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const EXPOSURES = ['codemode', 'deferred', 'direct', 'hidden'] as const
const CONFIG_FIELDS = [
  'type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'oauth', 'auth', 'enabled', 'exposure',
  'description', 'timeout', 'toolExposure',
]
const PROJECT_OVERRIDE_FIELDS = ['enabled', 'exposure', 'toolExposure']

interface NativeConfigFile {
  readonly scope: McpConfigScope
  readonly relativePath: string
  readonly revision: number
  readonly document: Record<string, unknown>
  readonly settings: ScopedSettingsService
}

interface EffectiveEntry {
  readonly name: string
  readonly raw: Record<string, unknown>
  readonly configScope: McpConfigScope
  readonly overriddenByProject: boolean
}

function revisionFor(contents: string | undefined): number {
  return contents === undefined ? 0 : Number.parseInt(createHash('sha256').update(contents).digest('hex').slice(0, 12), 16)
}

function isExposure(value: unknown): value is McpExposure {
  return typeof value === 'string' && EXPOSURES.includes(value as McpExposure)
}

function normalizedExposure(value: unknown): McpExposure | undefined {
  if (isExposure(value)) return value
  return value === 'codemode-deferred' ? 'codemode' : undefined
}

function assertServerName(name: string): void {
  if (!SERVER_NAME.test(name) || UNSAFE_NAMES.has(name)) throw new TypeError('MCP server name is invalid.')
}

function objectEntries(value: unknown, max = 512): [string, unknown][] {
  if (!isPlainRecord(value) || Object.keys(value).length > max) throw new TypeError('MCP server configuration is invalid.')
  return Object.entries(value)
}

function validateStringRecord(value: unknown, keyPattern: RegExp, label: string): Record<string, string> {
  const entries = objectEntries(value)
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, item] of entries) {
    if (UNSAFE_NAMES.has(key) || !keyPattern.test(key) || typeof item !== 'string' || item.length > 8192 || item.includes('\0')) {
      throw new TypeError(`MCP ${label} configuration is invalid.`)
    }
    result[key] = item
  }
  return result
}

function validateToolExposure(value: unknown): Record<string, McpExposure> {
  const entries = objectEntries(value)
  const result: Record<string, McpExposure> = Object.create(null) as Record<string, McpExposure>
  for (const [name, exposure] of entries) {
    if (name.length > 256 || UNSAFE_NAMES.has(name) || !isExposure(exposure)) throw new TypeError('MCP tool exposure configuration is invalid.')
    result[name] = exposure
  }
  return result
}

function validateOAuth(value: unknown): Record<string, unknown> {
  const entries = objectEntries(value, 32)
  const input = Object.fromEntries(entries)
  const allowed = new Set([
    'clientId', 'clientSecret', 'callbackPort', 'callbackUrl', 'scope', 'clientName', 'clientRegistration', 'authServerMetadataUrl',
  ])
  if (entries.some(([key]) => !allowed.has(key))) throw new TypeError('MCP OAuth configuration contains an unknown field.')
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of ['clientId', 'clientSecret', 'callbackUrl', 'scope', 'clientName', 'authServerMetadataUrl'] as const) {
    const item = input[key]
    if (item !== undefined) {
      if (typeof item !== 'string' || item.length > 8192 || item.includes('\0')) throw new TypeError('MCP OAuth configuration is invalid.')
      if (key === 'clientSecret' && item && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(item) && !item.startsWith('!')) {
        throw new TypeError('MCP OAuth client secrets must use a native environment or command reference.')
      }
      result[key] = item
    }
  }
  if (input.callbackPort !== undefined) {
    if (!Number.isInteger(input.callbackPort) || (input.callbackPort as number) < 1 || (input.callbackPort as number) > 65535) {
      throw new TypeError('MCP OAuth callback port is invalid.')
    }
    result.callbackPort = input.callbackPort
  }
  if (input.clientRegistration !== undefined) {
    if (input.clientRegistration !== 'dcr' && input.clientRegistration !== 'cimd') throw new TypeError('MCP OAuth registration mode is invalid.')
    result.clientRegistration = input.clientRegistration
  }
  if (typeof input.clientName === 'string' && input.clientName.trim().length === 0) {
    throw new TypeError('MCP OAuth client name must not be empty.')
  }
  if (typeof input.callbackUrl === 'string') {
    let callback: URL
    try { callback = new URL(input.callbackUrl) } catch { throw new TypeError('MCP OAuth callback URL is invalid.') }
    if (callback.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)
      || callback.search || callback.hash) throw new TypeError('MCP OAuth callback URL must be a loopback HTTP URL.')
    if (callback.port && input.callbackPort !== undefined && Number(callback.port) !== input.callbackPort) {
      throw new TypeError('MCP OAuth callback URL and port do not match.')
    }
    if (input.clientRegistration === 'cimd'
      && (callback.hostname === '[::1]' || callback.pathname !== '/callback')) {
      throw new TypeError('Pi Client ID Metadata Documents require the default loopback callback path.')
    }
  }
  if (input.clientRegistration === 'cimd' && (input.clientId !== undefined || input.clientName !== undefined)) {
    throw new TypeError('Pi Client ID Metadata Documents cannot specify a client ID or client name.')
  }
  if (typeof input.authServerMetadataUrl === 'string') {
    let metadata: URL
    try { metadata = new URL(input.authServerMetadataUrl) } catch { throw new TypeError('MCP OAuth metadata URL is invalid.') }
    if (!(metadata.protocol === 'https:' || metadata.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(metadata.hostname))) {
      throw new TypeError('MCP OAuth metadata URL must use HTTPS or loopback HTTP.')
    }
  }
  return result
}

function validateFullConfig(name: string, value: McpStdioConfigInput | McpHttpConfigInput, scope: McpConfigScope): Record<string, unknown> {
  assertServerName(name)
  if (value.type === 'stdio') {
    if (typeof value.command !== 'string' || value.command.trim().length === 0 || value.command.length > 8192 || value.command.includes('\0')) {
      throw new TypeError('MCP stdio command is invalid.')
    }
    const config: Record<string, unknown> = { type: 'stdio', command: value.command }
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.length > 512 || !value.args.every((arg) => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\0'))) {
        throw new TypeError('MCP stdio arguments are invalid.')
      }
      config.args = [...value.args]
    }
    if (value.env !== undefined) config.env = validateStringRecord(value.env, ENV_NAME, 'environment')
    if (value.cwd !== undefined) {
      if (typeof value.cwd !== 'string' || value.cwd.length > 4096 || value.cwd.includes('\0')) throw new TypeError('MCP stdio working directory is invalid.')
      config.cwd = value.cwd
    }
    addCommonConfig(config, value)
    return config
  }

  if (typeof value.url !== 'string' || value.url.length > 4096 || !URL.canParse(value.url)) throw new TypeError('MCP HTTP URL is invalid.')
  const url = new URL(value.url)
  if (!(url.protocol === 'http:' || url.protocol === 'https:')) throw new TypeError('MCP URL must use HTTP or HTTPS.')
  const config: Record<string, unknown> = { type: 'http', url: value.url }
  if (value.headers !== undefined) config.headers = validateStringRecord(value.headers, HEADER_NAME, 'header')
  if (value.oauth !== undefined) config.oauth = validateOAuth(value.oauth)
  if (value.authProvider !== undefined) {
    if (scope === 'project') throw new TypeError('Pi does not allow auth.provider in project MCP configuration.')
    if (typeof value.authProvider !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.authProvider)) {
      throw new TypeError('MCP auth provider reference is invalid.')
    }
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new TypeError('MCP auth.provider requires HTTPS or a loopback HTTP URL.')
    }
    config.auth = { provider: value.authProvider }
  }
  if (scope === 'project' && value.authProvider) throw new TypeError('Pi does not allow auth.provider in project MCP configuration.')
  addCommonConfig(config, value)
  return config
}

function addCommonConfig(config: Record<string, unknown>, value: McpStdioConfigInput | McpHttpConfigInput): void {
  if (value.enabled !== undefined) config.enabled = value.enabled
  if (value.exposure !== undefined) {
    if (!isExposure(value.exposure)) throw new TypeError('MCP exposure is invalid.')
    config.exposure = value.exposure
  }
  if (value.description !== undefined) {
    if (typeof value.description !== 'string' || value.description.length > 8192) throw new TypeError('MCP description is invalid.')
    config.description = value.description
  }
  if (value.timeout !== undefined) {
    if (typeof value.timeout !== 'number' || !Number.isFinite(value.timeout) || value.timeout <= 0 || value.timeout > 3600) {
      throw new TypeError('MCP timeout is invalid.')
    }
    config.timeout = value.timeout
  }
  if (value.toolExposure !== undefined) config.toolExposure = validateToolExposure(value.toolExposure)
}

function validateOverride(value: McpProjectOverrideInput): Record<string, unknown> {
  const config: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw new TypeError('MCP enabled value is invalid.')
    config.enabled = value.enabled
  }
  if (value.exposure !== undefined) {
    if (!isExposure(value.exposure)) throw new TypeError('MCP exposure is invalid.')
    config.exposure = value.exposure
  }
  if (value.toolExposure !== undefined) config.toolExposure = validateToolExposure(value.toolExposure)
  if (Object.keys(config).length === 0) throw new TypeError('MCP project override must change at least one setting.')
  return config
}

function isSparseOverride(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value)
    && value.command === undefined && value.url === undefined && value.type === undefined
    && Object.keys(value).every((key) => PROJECT_OVERRIDE_FIELDS.includes(key))
}

function isNativeOverride(value: Record<string, unknown>): boolean {
  return value.command === undefined && value.url === undefined && value.type === undefined
}

function sanitizedUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return '[invalid URL]'
  }
}

function safeArgs(args: readonly string[]): string[] {
  const result: string[] = []
  let redactNext = false
  for (const arg of args) {
    if (redactNext) {
      result.push('[redacted]')
      redactNext = false
      continue
    }
    const scrubbed = arg
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      .replace(/((?:authorization|access[-_]?token|refresh[-_]?token|client[-_]?secret|api[-_]?key|password|credential|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    if (scrubbed !== arg) {
      result.push(scrubbed)
      continue
    }
    const assignment = arg.match(/^(-{1,2}[^=]*(?:token|secret|password|credential|api[-_]?key|authorization)[^=]*)=(.*)$/i)
    if (assignment) {
      result.push(`${assignment[1]}=[redacted]`)
      continue
    }
    if (/^-{1,2}[^=]*(?:token|secret|password|credential|api[-_]?key|authorization)[^=]*$/i.test(arg)) {
      result.push(arg)
      redactNext = true
      continue
    }
    result.push(arg)
  }
  return result
}

function safeCommand(command: string): string {
  return command
    .replace(/(-{1,2}[^\s=]*(?:token|secret|password|credential|api[-_]?key|authorization)[^\s=]*=)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]')
    .replace(/(-{1,2}[^\s=]*(?:token|secret|password|credential|api[-_]?key|authorization)[^\s=]*)\s+(?:"[^"]*"|'[^']*'|\S+)/gi, '$1 [redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:authorization|access[-_]?token|refresh[-_]?token|client[-_]?secret|api[-_]?key|password|credential|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
}

function projectView(entry: EffectiveEntry): McpServerConfigView | undefined {
  const config = entry.raw
  if (!SERVER_NAME.test(entry.name) || UNSAFE_NAMES.has(entry.name)) return undefined
  if (!isSupportedEntry(config, entry.configScope)) return undefined
  const transport = typeof config.url === 'string' ? 'http' : typeof config.command === 'string' ? 'stdio' : undefined
  if (!transport) return undefined
  const exposure = normalizedExposure(config.exposure) ?? 'codemode'
  const view: McpServerConfigView = {
    name: entry.name,
    scope: entry.configScope,
    transport,
    enabled: config.enabled !== false,
    exposure,
    ...(typeof config.description === 'string' ? { description: config.description.slice(0, 8192) } : {}),
    ...(typeof config.timeout === 'number' && Number.isFinite(config.timeout) ? { timeout: config.timeout } : {}),
    ...(isPlainRecord(config.toolExposure)
      ? { toolExposure: Object.fromEntries(Object.entries(config.toolExposure).flatMap(([key, value]) => {
          const exposure = normalizedExposure(value)
          return exposure === undefined ? [] : [[key, exposure] as const]
        })) }
      : {}),
    ...(entry.overriddenByProject ? { overriddenByProject: true } : {}),
  }
  if (transport === 'stdio') {
    return {
      ...view,
      command: safeCommand((config.command as string).slice(0, 8192)),
      ...(Array.isArray(config.args) ? { args: safeArgs(config.args.filter((arg): arg is string => typeof arg === 'string').slice(0, 512)) } : {}),
      ...(typeof config.cwd === 'string' ? { cwd: config.cwd.slice(0, 4096) } : {}),
      ...(isPlainRecord(config.env) ? { envKeys: Object.keys(config.env).slice(0, 512).map((key) => key.slice(0, 128)) } : {}),
    }
  }
  const oauth = isPlainRecord(config.oauth) ? config.oauth : undefined
  return {
    ...view,
    url: sanitizedUrl(config.url as string),
    ...(isPlainRecord(config.headers) ? { headerNames: Object.keys(config.headers).slice(0, 512).map((key) => key.slice(0, 256)) } : {}),
    ...(isPlainRecord(config.auth) && typeof config.auth.provider === 'string' ? { authProvider: config.auth.provider.slice(0, 128) } : {}),
    ...(oauth ? {
      oauth: {
        clientSecretConfigured: typeof oauth.clientSecret === 'string' && oauth.clientSecret.length > 0,
        ...(typeof oauth.clientId === 'string' ? { clientId: oauth.clientId.slice(0, 2048) } : {}),
        ...(typeof oauth.callbackPort === 'number' ? { callbackPort: oauth.callbackPort } : {}),
        ...(typeof oauth.callbackUrl === 'string' ? { callbackUrl: sanitizedUrl(oauth.callbackUrl) } : {}),
        ...(typeof oauth.scope === 'string' ? { scope: oauth.scope.slice(0, 2048) } : {}),
        ...(typeof oauth.clientName === 'string' ? { clientName: oauth.clientName.slice(0, 512) } : {}),
        ...(oauth.clientRegistration === 'dcr' || oauth.clientRegistration === 'cimd' ? { clientRegistration: oauth.clientRegistration } : {}),
        ...(typeof oauth.authServerMetadataUrl === 'string' ? { authServerMetadataUrl: sanitizedUrl(oauth.authServerMetadataUrl) } : {}),
      },
    } : {}),
  }
}

function isSupportedEntry(config: Record<string, unknown>, scope: McpConfigScope): boolean {
  const type = config.type
  if (type === 'sse' || (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'streamable-http')) return false
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') return false
  if (config.exposure !== undefined && normalizedExposure(config.exposure) === undefined) return false
  if (config.description !== undefined && typeof config.description !== 'string') return false
  if (config.timeout !== undefined && (typeof config.timeout !== 'number' || config.timeout <= 0)) return false
  if (config.toolExposure !== undefined && (!isPlainRecord(config.toolExposure)
    || Object.values(config.toolExposure).some((value) => normalizedExposure(value) === undefined))) return false
  if (typeof config.url === 'string' && typeof config.command !== 'string') {
    if (type !== undefined && type !== 'http' && type !== 'streamable-http') return false
    if (!URL.canParse(config.url) || !['http:', 'https:'].includes(new URL(config.url).protocol)) return false
    if (config.headers !== undefined && !isPlainRecord(config.headers)) return false
    if (config.headers !== undefined && Object.values(config.headers).some((value) => typeof value !== 'string')) return false
    if (config.auth !== undefined) {
      if (scope === 'project' || !isPlainRecord(config.auth) || typeof config.auth.provider !== 'string' || !config.auth.provider) return false
      const url = new URL(config.url)
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false
    }
    return true
  }
  if (typeof config.command === 'string' && config.url === undefined) {
    if (type !== undefined && type !== 'stdio') return false
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string'))) return false
    if (config.env !== undefined && (!isPlainRecord(config.env) || Object.values(config.env).some((value) => typeof value !== 'string'))) return false
    if (config.cwd !== undefined && typeof config.cwd !== 'string') return false
    return true
  }
  return false
}

function mergeProjectOverride(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged = cloneRecord(base)
  for (const field of PROJECT_OVERRIDE_FIELDS) {
    if (Object.hasOwn(override, field)) merged[field] = override[field]
  }
  return merged
}

function serverMap(document: Record<string, unknown>): Record<string, unknown> {
  if (document.mcpServers === undefined) return Object.create(null) as Record<string, unknown>
  if (!isPlainRecord(document.mcpServers) || Object.keys(document.mcpServers).length > 512) {
    throw new TypeError('Pi MCP config must contain an mcpServers object with at most 512 entries.')
  }
  return document.mcpServers
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function mergePlainRecords(left: unknown, right: unknown): Record<string, unknown> {
  const leftRecord = isPlainRecord(left) ? left : undefined
  const rightRecord = isPlainRecord(right) ? right : undefined
  const result = Object.create(null) as Record<string, unknown>
  if (leftRecord) {
    for (const [key, value] of Object.entries(leftRecord)) result[key] = value
  }
  if (rightRecord) {
    for (const [key, value] of Object.entries(rightRecord)) result[key] = value
  }
  return result
}

function mergeConfigEntry(current: Record<string, unknown> | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = current ? cloneRecord(current) : Object.create(null) as Record<string, unknown>
  if (current && typeof current.type === 'string' && current.type !== patch.type) {
    const oldTransportFields = current.type === 'stdio'
      ? ['command', 'args', 'env', 'cwd']
      : current.type === 'http' ? ['url', 'headers', 'oauth', 'auth'] : []
    for (const field of oldTransportFields) delete merged[field]
  }
  for (const [key, value] of Object.entries(patch)) {
    const previous = merged[key]
    if (['env', 'headers', 'toolExposure', 'oauth', 'auth'].includes(key)) {
      const previousRecord = isPlainRecord(previous) ? previous : undefined
      const valueRecord = isPlainRecord(value) ? value : undefined
      if (previousRecord && valueRecord) {
        merged[key] = mergePlainRecords(previousRecord, valueRecord)
        continue
      }
    }
    merged[key] = value
  }
  return merged
}

function removeKnownConfigFields(value: Record<string, unknown>): void {
  for (const field of CONFIG_FIELDS) delete value[field]
}

export class McpConfigService {
  readonly agentDir: string

  constructor(agentDir = getAgentDir()) {
    if (agentDir.includes('\0')) throw new TypeError('Pi agent directory is invalid.')
    this.agentDir = resolve(agentDir)
  }

  list(cwd: string, projectTrusted: boolean): {
    readonly servers: readonly McpServerConfigView[]
    readonly userRevision: number
    readonly projectRevision?: number
  } {
    const user = this.readFile('user', cwd)
    const effective = new Map<string, EffectiveEntry>()
    for (const [name, value] of Object.entries(serverMap(user.document))) {
      if (isPlainRecord(value)) effective.set(name, { name, raw: cloneRecord(value), configScope: 'user', overriddenByProject: false })
    }
    if (!projectTrusted) return {
      servers: [...effective.values()].flatMap((entry) => {
        const view = projectView(entry)
        return view ? [view] : []
      }).sort((left, right) => left.name.localeCompare(right.name)),
      userRevision: user.revision,
    }

    const project = this.readFile('project', cwd)
    for (const [name, value] of Object.entries(serverMap(project.document))) {
      if (!isPlainRecord(value)) continue
      if (isNativeOverride(value)) {
        if (!isSparseOverride(value)) continue
        const base = effective.get(name)
        if (!base) continue
        const merged = mergeProjectOverride(base.raw, value)
        effective.set(name, { name, raw: merged, configScope: base.configScope, overriddenByProject: true })
      } else {
        effective.set(name, { name, raw: cloneRecord(value), configScope: 'project', overriddenByProject: false })
      }
    }
    if (effective.size > 512) throw new TypeError('Effective MCP server list exceeds the response limit.')
    return {
      servers: [...effective.values()].flatMap((entry) => {
        const view = projectView(entry)
        return view ? [view] : []
      }).sort((left, right) => left.name.localeCompare(right.name)),
      userRevision: user.revision,
      projectRevision: project.revision,
    }
  }

  read(name: string, cwd: string, projectTrusted: boolean): {
    readonly server: McpServerConfigView | null
    readonly userRevision: number
    readonly projectRevision?: number
  } {
    assertServerName(name)
    const result = this.list(cwd, projectTrusted)
    return {
      server: result.servers.find((server) => server.name === name) ?? null,
      userRevision: result.userRevision,
      ...(result.projectRevision === undefined ? {} : { projectRevision: result.projectRevision }),
    }
  }

  create(
    scope: McpConfigScope,
    expectedRevision: number,
    name: string,
    input: McpServerConfigInput,
    cwd: string,
    projectTrusted: boolean,
  ): McpServerMutationResponse {
    assertServerName(name)
    this.assertScope(scope, projectTrusted, cwd)
    const file = this.readFile(scope, cwd)
    if (file.revision !== expectedRevision) return this.mutationConflict(scope, name, cwd, projectTrusted)
    const servers = serverMap(file.document)
    if (Object.hasOwn(servers, name)) throw new TypeError('MCP server already exists at this scope.')
    const effective = this.list(cwd, projectTrusted).servers
    const namespace = `mcp__${name.replace(/-/g, '_')}`
    if (effective.some((server) => server.name !== name && `mcp__${server.name.replace(/-/g, '_')}` === namespace)) {
      throw new TypeError('MCP server name conflicts with an existing namespace.')
    }
    const value = this.normalizeConfig(input, scope, name)
    if (isSparseOverride(value)) {
      if (scope !== 'project' || !this.userHasServer(name, cwd)) {
        throw new TypeError('A sparse project override requires an existing server.')
      }
    }
    const patch = { mcpServers: { [name]: value } }
    const updated = file.settings.updateJson(scope, file.relativePath, expectedRevision, patch)
    if (updated.outcome === 'conflict') return this.mutationConflict(scope, name, cwd, projectTrusted)
    return this.mutationSaved(name, updated.snapshot.revision, cwd, projectTrusted)
  }

  update(
    scope: McpConfigScope,
    expectedRevision: number,
    name: string,
    input: McpServerConfigInput,
    cwd: string,
    projectTrusted: boolean,
  ): McpServerMutationResponse {
    assertServerName(name)
    this.assertScope(scope, projectTrusted, cwd)
    const file = this.readFile(scope, cwd)
    if (file.revision !== expectedRevision) return this.mutationConflict(scope, name, cwd, projectTrusted)
    const servers = serverMap(file.document)
    const current = servers[name]
    if (current === undefined && !(scope === 'project' && isProjectOverrideInput(input) && this.userHasServer(name, cwd))) {
      throw new TypeError('MCP server does not exist at this scope.')
    }
    const value = this.normalizeConfig(input, scope, name)
    if (isSparseOverride(value)) {
      if (scope !== 'project' || !this.userHasServer(name, cwd)) {
        throw new TypeError('A sparse project override requires an existing server.')
      }
      const merged = isPlainRecord(current) ? cloneRecord(current) : Object.create(null) as Record<string, unknown>
      if (!isSparseOverride(current)) removeKnownConfigFields(merged)
      if (Object.keys(merged).some((key) => !PROJECT_OVERRIDE_FIELDS.includes(key))) {
        throw new TypeError('A project entry with unknown fields cannot be converted to a sparse override.')
      }
      for (const [key, fieldValue] of Object.entries(value)) {
        const previousTools = isPlainRecord(merged.toolExposure) ? merged.toolExposure : undefined
        const nextTools = isPlainRecord(fieldValue) ? fieldValue : undefined
        if (key === 'toolExposure' && previousTools && nextTools) {
          merged.toolExposure = mergePlainRecords(previousTools, nextTools)
          continue
        }
        merged[key] = fieldValue
      }
      const updated = file.settings.updateJson(scope, file.relativePath, expectedRevision, { mcpServers: { [name]: merged } })
      if (updated.outcome === 'conflict') return this.mutationConflict(scope, name, cwd, projectTrusted)
      return this.mutationSaved(name, updated.snapshot.revision, cwd, projectTrusted)
    }

    const complete = mergeConfigEntry(isPlainRecord(current) ? current : undefined, value)
    for (const field of CONFIG_FIELDS) {
      if (!Object.hasOwn(value, field)) delete complete[field]
    }
    const revision = this.replaceServerEntry(file, expectedRevision, name, complete, cwd)
    if (revision === undefined) return this.mutationConflict(scope, name, cwd, projectTrusted)
    return this.mutationSaved(name, revision, cwd, projectTrusted)
  }

  delete(
    scope: McpConfigScope,
    expectedRevision: number,
    name: string,
    cwd: string,
    projectTrusted: boolean,
  ): McpServerMutationResponse {
    assertServerName(name)
    this.assertScope(scope, projectTrusted, cwd)
    const file = this.readFile(scope, cwd)
    if (file.revision !== expectedRevision) return this.mutationConflict(scope, name, cwd, projectTrusted)
    if (!Object.hasOwn(serverMap(file.document), name)) throw new TypeError('MCP server does not exist at this scope.')
    const updated = file.settings.updateJson(scope, file.relativePath, expectedRevision, {}, [`mcpServers.${name}`])
    if (updated.outcome === 'conflict') return this.mutationConflict(scope, name, cwd, projectTrusted)
    return {
      outcome: 'session-reload-required',
      revision: updated.snapshot.revision,
      server: this.read(name, cwd, projectTrusted).server,
    }
  }

  setEnabled(
    scope: McpConfigScope,
    expectedRevision: number,
    name: string,
    enabled: boolean,
    cwd: string,
    projectTrusted: boolean,
  ): McpServerMutationResponse {
    assertServerName(name)
    this.assertScope(scope, projectTrusted, cwd)
    const file = this.readFile(scope, cwd)
    if (file.revision !== expectedRevision) return this.mutationConflict(scope, name, cwd, projectTrusted)
    const servers = serverMap(file.document)
    let existing = servers[name]
    if (scope === 'project' && existing === undefined) {
      const userServers = serverMap(this.readFile('user', cwd).document)
      if (Object.hasOwn(userServers, name)) existing = { enabled }
    }
    if (!isPlainRecord(existing)) throw new TypeError('MCP server does not exist at this scope.')
    const serverPatch = isSparseOverride(existing) ? { enabled } : enabled ? {} : { enabled: false }
    const removePaths = enabled && !isSparseOverride(existing) ? [`mcpServers.${name}.enabled`] : []
    const patch = Object.keys(serverPatch).length > 0 ? { mcpServers: { [name]: serverPatch } } : {}
    const updated = file.settings.updateJson(scope, file.relativePath, expectedRevision, patch, removePaths)
    if (updated.outcome === 'conflict') return this.mutationConflict(scope, name, cwd, projectTrusted)
    return this.mutationSaved(name, updated.snapshot.revision, cwd, projectTrusted)
  }

  private normalizeConfig(input: McpServerConfigInput, scope: McpConfigScope, name: string): Record<string, unknown> {
    if (input.type === 'override') {
      if (scope !== 'project') throw new TypeError('Sparse MCP overrides are only valid at project scope.')
      return validateOverride(input)
    }
    if (scope === 'project') throw new TypeError('Project MCP configuration only supports sparse overrides.')
    return validateFullConfig(name, input, scope)
  }

  private userHasServer(name: string, cwd: string): boolean {
    return Object.hasOwn(serverMap(this.readFile('user', cwd).document), name)
  }

  private replaceServerEntry(
    file: NativeConfigFile,
    expectedRevision: number,
    name: string,
    entry: Record<string, unknown>,
    cwd: string,
  ): number | undefined {
    const removePaths = CONFIG_FIELDS
      .filter((field) => !Object.hasOwn(entry, field))
      .map((field) => `mcpServers.${name}.${field}`)
    const updated = file.settings.updateJson(
      file.scope,
      file.relativePath,
      expectedRevision,
      { mcpServers: { [name]: entry } },
      removePaths,
    )
    return updated.outcome === 'saved' ? updated.snapshot.revision : undefined
  }

  private mutationConflict(scope: McpConfigScope, name: string, cwd: string, projectTrusted: boolean): McpServerMutationResponse {
    const file = this.readFile(scope, cwd)
    return {
      outcome: 'conflict',
      revision: file.revision,
      server: this.read(name, cwd, projectTrusted).server,
    }
  }

  private mutationSaved(name: string, revision: number, cwd: string, projectTrusted: boolean): McpServerMutationResponse {
    return {
      outcome: 'session-reload-required',
      revision,
      server: this.read(name, cwd, projectTrusted).server,
    }
  }

  private assertScope(scope: McpConfigScope, projectTrusted: boolean, cwd: string): void {
    if (scope === 'project') {
      if (!projectTrusted) throw new TypeError('Project MCP configuration is unavailable for an untrusted workspace.')
      if (!cwd || cwd.includes('\0')) throw new TypeError('Project MCP configuration path is invalid.')
    }
  }

  private readFile(scope: McpConfigScope, cwd: string): NativeConfigFile {
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) throw new TypeError('MCP workspace path is invalid.')
    const projectRoot = resolve(cwd)
    const settings = new ScopedSettingsService({ user: this.agentDir, project: projectRoot })
    const relativePath = scope === 'user' ? 'mcp.json' : `${CONFIG_DIR_NAME}/mcp.json`
    const absolutePath = scope === 'user' ? join(this.agentDir, 'mcp.json') : join(projectRoot, CONFIG_DIR_NAME, 'mcp.json')
    const snapshot = settings.readJson(scope, relativePath)
    let descriptor: number | undefined
    let contents: string | undefined
    try {
      descriptor = openSync(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const details = fstatSync(descriptor)
      if (!details.isFile() || details.size > CONFIG_MAX_BYTES) throw new TypeError('Pi MCP config is not a regular file or exceeds its size limit.')
      contents = readFileSync(descriptor, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
    if (revisionFor(contents) !== snapshot.revision) throw new TypeError('Pi MCP config changed while it was being read.')
    let document: unknown = contents === undefined ? {} : JSON.parse(contents)
    if (!isPlainRecord(document) || (document.mcpServers !== undefined && !isPlainRecord(document.mcpServers))) {
      throw new TypeError('Pi MCP config must contain an mcpServers object.')
    }
    return { scope, relativePath, revision: snapshot.revision, document, settings }
  }
}

function isProjectOverrideInput(value: McpServerConfigInput): value is McpProjectOverrideInput {
  return value.type === 'override'
}
