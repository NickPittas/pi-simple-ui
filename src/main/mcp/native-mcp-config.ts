import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  NATIVE_MCP_LIFECYCLES,
  NATIVE_MCP_ORIGINS,
  NATIVE_MCP_WRITABLE_ORIGINS,
  isNativeMcpEmptyRequest,
  isNativeMcpEnableRequest,
  isNativeMcpListResult,
  isNativeMcpMutationResult,
  isNativeMcpRemoveRequest,
  isNativeMcpSaveRequest,
  type NativeMcpAuth,
  type NativeMcpConfigInput,
  type NativeMcpFileInfo,
  type NativeMcpKvInput,
  type NativeMcpKvView,
  type NativeMcpLifecycle,
  type NativeMcpListResult,
  type NativeMcpMutationResult,
  type NativeMcpOrigin,
  type NativeMcpServerView,
  type NativeMcpTransport,
} from '../../shared/native-mcp.ts'
import { nativeAgentDir } from '../agents/native-agent-definitions.ts'
import type { CapabilityDefinition } from '../ipc/register.ts'

/**
 * Config-only editing of the pi-mcp-adapter JSON files (adapter: ~/.pi/agent/npm/node_modules/pi-mcp-adapter/config.ts).
 * No connections, processes or OAuth live here; Pi owns those. Writes are confined to the three fixed adapter files below.
 */

const MAX_BYTES = 2 * 1024 * 1024
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

const LABELS: Record<NativeMcpOrigin, string> = {
  'shared-global': 'Shared global (~/.config/mcp/mcp.json, read-only)',
  'agents-global': 'Agents global (~/.agents/mcp.json, read-only)',
  'agents-nested': 'Agents global (~/.agents/mcp/mcp.json, read-only)',
  user: 'Pi user (agent dir mcp.json)',
  'shared-project': 'Project shared (.mcp.json)',
  project: 'Project Pi (.pi/mcp.json)',
}

/** Tolerant parse matching the adapter's strip-json-comments with trailing commas. */
function parseJsonc(text: string): { value: unknown; hadComments: boolean } {
  let out = ''
  let hadComments = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === '/' && text[i + 1] === '/') {
      hadComments = true
      while (i < text.length && text[i] !== '\n') i += 1
    } else if (ch === '/' && text[i + 1] === '*') {
      hadComments = true
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else { out += ch; i += 1 }
  }
  // Trailing commas outside strings.
  let cleaned = ''
  let inString = false
  for (let k = 0; k < out.length; k += 1) {
    const ch = out[k]!
    if (inString) { cleaned += ch; if (ch === '\\') { cleaned += out[k + 1] ?? ''; k += 1 } else if (ch === '"') inString = false; continue }
    if (ch === '"') { inString = true; cleaned += ch; continue }
    if (ch === ',') { let n = k + 1; while (n < out.length && /\s/.test(out[n]!)) n += 1; if (out[n] === '}' || out[n] === ']') continue }
    cleaned += ch
  }
  return { value: JSON.parse(cleaned), hadComments }
}

function redactUrl(raw: string): { url: string; redacted: boolean } {
  try {
    const parsed = new URL(raw)
    const redacted = !!(parsed.username || parsed.password || parsed.search || parsed.hash)
    parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''
    return { url: parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '' : '/'), redacted }
  } catch {
    // Contains interpolation or is otherwise unparseable: cut at the first query/fragment/userinfo marker.
    const cut = raw.split(/[?#]/)[0]!.replace(/\/\/[^/@]*@/, '//')
    return { url: cut, redacted: cut !== raw }
  }
}

const REF = /^(?:\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\})$/
function kvViews(value: unknown): NativeMcpKvView[] {
  if (!isRecord(value)) return []
  return Object.entries(value).map(([key, entry]) => {
    const text = typeof entry === 'string' ? entry : ''
    const match = REF.exec(text)
    if (match) return { key, kind: 'reference' as const, ref: match[1] ?? match[2] ?? match[3]! }
    return { key, kind: text.startsWith('!') && !text.startsWith('!!') ? 'command' as const : 'literal' as const }
  })
}

const HANDLED = new Set(['command', 'args', 'socket', 'env', 'cwd', 'url', 'headers', 'auth', 'lifecycle', 'idleTimeout', 'requestTimeoutMs', 'exposeResources', 'directTools', 'includeTools', 'excludeTools', 'debug', 'httpTransport', 'disabled'])
const HTTP_ONLY = ['url', 'headers', 'httpTransport', 'auth', 'requestHeadersCommand', 'bearerToken', 'bearerTokenEnv', 'bearerTokenStore', 'oauth']
const STDIO_ONLY = ['command', 'args', 'env', 'cwd', 'socket', 'literalEnv', 'pluginDataDir']
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

interface LoadedFile {
  readonly origin: NativeMcpOrigin
  readonly path: string | null
  readonly exists: boolean
  readonly revision: string
  readonly raw: Json
  readonly serversKey: 'mcpServers' | 'mcp-servers'
  readonly servers: Record<string, unknown>
  readonly hadComments: boolean
  readonly error: string | null
}

export class NativeMcpConfig {
  private readonly activeWorkspacePath: () => string | null
  constructor(activeWorkspacePath: () => string | null) { this.activeWorkspacePath = activeWorkspacePath }

  private pathFor(origin: NativeMcpOrigin): string | null {
    const cwd = this.activeWorkspacePath()
    switch (origin) {
      case 'shared-global': return join(homedir(), '.config', 'mcp', 'mcp.json')
      case 'agents-global': return join(homedir(), '.agents', 'mcp.json')
      case 'agents-nested': return join(homedir(), '.agents', 'mcp', 'mcp.json')
      case 'user': return join(nativeAgentDir(), 'mcp.json')
      case 'shared-project': return cwd ? join(cwd, '.mcp.json') : null
      case 'project': return cwd ? join(cwd, '.pi', 'mcp.json') : null
    }
  }

  private load(origin: NativeMcpOrigin): LoadedFile {
    const path = this.pathFor(origin)
    const empty = (error: string | null, exists = false, revision = ''): LoadedFile => ({ origin, path, exists, revision, raw: {}, serversKey: 'mcpServers', servers: {}, hadComments: false, error })
    if (!path) return empty(null)
    let bytes: Buffer
    try {
      const stat = statSync(path)
      if (!stat.isFile()) return empty('Not a regular file.')
      if (stat.size > MAX_BYTES) return empty('File is larger than 2 MiB.', true)
      bytes = readFileSync(path)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? empty(null) : empty('The file could not be read.')
    }
    const revision = sha256(bytes)
    try {
      const { value, hadComments } = parseJsonc(bytes.toString('utf8'))
      if (!isRecord(value)) return { ...empty('The file root is not an object.', true, revision) }
      const serversKey = value.mcpServers !== undefined ? 'mcpServers' : value['mcp-servers'] !== undefined ? 'mcp-servers' : 'mcpServers'
      const servers = value[serversKey] ?? {}
      if (!isRecord(servers)) return { ...empty(`"${serversKey}" is not an object.`, true, revision) }
      return { origin, path, exists: true, revision, raw: value, serversKey, servers, hadComments, error: null }
    } catch {
      return empty('The file is not valid JSON.', true, revision)
    }
  }

  list(): NativeMcpListResult {
    const files = NATIVE_MCP_ORIGINS.map((origin) => this.load(origin))
    // Effective disabled state per name after the adapter's per-field merge, ascending precedence.
    const effective = new Map<string, { disabled: boolean; by: NativeMcpOrigin }>()
    const lastWriter = new Map<string, NativeMcpOrigin>()
    for (const file of files) {
      for (const [name, entry] of Object.entries(file.servers)) {
        if (!isRecord(entry)) continue
        const previous = effective.get(name)
        effective.set(name, { disabled: Object.hasOwn(entry, 'disabled') ? entry.disabled === true : (previous?.disabled ?? false), by: file.origin })
        lastWriter.set(name, file.origin)
      }
    }
    const servers: NativeMcpServerView[] = []
    for (const file of files) {
      for (const [name, entry] of Object.entries(file.servers)) {
        if (!isRecord(entry) || FORBIDDEN_NAMES.has(name)) continue
        servers.push(this.view(file, name, entry, effective.get(name)?.disabled ?? false, lastWriter.get(name) !== file.origin ? lastWriter.get(name) ?? null : null))
      }
    }
    const infos: NativeMcpFileInfo[] = files.map((file) => ({
      origin: file.origin, label: LABELS[file.origin], path: file.path ?? '(no workspace open)', exists: file.exists,
      writable: NATIVE_MCP_WRITABLE_ORIGINS.includes(file.origin) && file.path !== null && file.error === null, revision: file.revision, error: file.error,
    }))
    return { servers, files: infos, hasProject: this.activeWorkspacePath() !== null }
  }

  private view(file: LoadedFile, name: string, entry: Json, effectiveDisabled: boolean, shadowedBy: NativeMcpOrigin | null): NativeMcpServerView {
    const transport: NativeMcpTransport = typeof entry.command === 'string' ? 'stdio'
      : typeof entry.url === 'string' ? (entry.httpTransport === 'sse' ? 'sse' : 'http')
        : typeof entry.socket === 'string' ? 'socket' : 'override'
    const url = typeof entry.url === 'string' ? redactUrl(entry.url) : undefined
    const warnings: string[] = []
    for (const key of ['enabled', 'disable', 'exposure', 'transport']) {
      if (Object.hasOwn(entry, key)) warnings.push(`"${key}" is not a pi-mcp-adapter key and is ignored by Pi${key === 'enabled' || key === 'disable' ? '; the adapter disables a server only with "disabled": true' : ''}.`)
    }
    const auth: NativeMcpAuth = entry.auth === 'oauth' ? 'oauth' : entry.auth === 'bearer' ? 'bearer' : entry.auth === false ? 'none' : 'default'
    const lifecycle = NATIVE_MCP_LIFECYCLES.includes(entry.lifecycle as NativeMcpLifecycle) ? entry.lifecycle as NativeMcpLifecycle : undefined
    const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
    return {
      id: `${file.origin}:${name}`, name, origin: file.origin,
      writable: NATIVE_MCP_WRITABLE_ORIGINS.includes(file.origin) && file.path !== null && file.error === null,
      transport, disabled: entry.disabled === true, effectiveDisabled, shadowedBy,
      ...(typeof entry.command === 'string' ? { command: entry.command } : {}),
      args: strings(entry.args),
      ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
      ...(url ? { url: url.url } : {}), urlRedacted: url?.redacted ?? false,
      ...(typeof entry.socket === 'string' ? { socket: entry.socket } : {}),
      env: kvViews(entry.env), headers: kvViews(entry.headers),
      ...(lifecycle ? { lifecycle } : {}), auth,
      ...(entry.httpTransport === 'sse' || entry.httpTransport === 'streamable-http' ? { httpTransport: entry.httpTransport } : {}),
      ...(typeof entry.directTools === 'boolean' ? { directTools: entry.directTools } : Array.isArray(entry.directTools) ? { directTools: 'list' as const } : {}),
      ...(num(entry.idleTimeout) !== undefined ? { idleTimeout: num(entry.idleTimeout)! } : {}),
      ...(num(entry.requestTimeoutMs) !== undefined ? { requestTimeoutMs: num(entry.requestTimeoutMs)! } : {}),
      ...(typeof entry.exposeResources === 'boolean' ? { exposeResources: entry.exposeResources } : {}),
      ...(typeof entry.debug === 'boolean' ? { debug: entry.debug } : {}),
      includeTools: strings(entry.includeTools), excludeTools: strings(entry.excludeTools),
      extraKeys: Object.keys(entry).filter((key) => !HANDLED.has(key)),
      warnings,
    }
  }

  private result(outcome: NativeMcpMutationResult['outcome'], reason: string | null, revision: string | null = null): NativeMcpMutationResult {
    return { outcome, revision, reason, restartRequired: outcome === 'saved' }
  }

  /** Shared read-check-mutate-write. `mutate` returns a reason string to refuse with 'invalid'. */
  private mutate(origin: NativeMcpOrigin, expectedRevision: string, mutate: (file: LoadedFile) => { servers: Record<string, unknown> } | string): NativeMcpMutationResult {
    if (!NATIVE_MCP_WRITABLE_ORIGINS.includes(origin)) return this.result('rejected', 'That configuration source is read-only here.')
    const file = this.load(origin)
    if (!file.path) return this.result('rejected', 'Open a workspace to edit project MCP configuration.')
    if (file.error) return this.result('rejected', file.error)
    if (file.revision !== expectedRevision) return this.result('conflict', 'The file changed on disk since it was loaded.', file.revision)
    if (file.hadComments) return this.result('rejected', 'This file contains comments, which would be lost on save. Remove them or edit the file directly.')
    const outcome = mutate(file)
    if (typeof outcome === 'string') return this.result('invalid', outcome)
    const next: Json = { ...file.raw }
    delete next['mcp-servers']
    next[file.serversKey] = outcome.servers
    // Keep the original key (mcpServers vs mcp-servers) so the file shape is stable.
    if (file.serversKey === 'mcp-servers') { delete next.mcpServers; next['mcp-servers'] = outcome.servers }
    const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8')
    if (bytes.length > MAX_BYTES) return this.result('rejected', 'Result would be larger than 2 MiB.')
    return this.writeAtomic(file, bytes)
  }

  private writeAtomic(file: LoadedFile, bytes: Buffer): NativeMcpMutationResult {
    let target = file.path!
    let temporary: string | undefined
    let descriptor: number | undefined
    try {
      let mode = file.origin === 'user' ? 0o600 : 0o644
      if (file.exists) {
        // Write through a symlinked dotfile instead of replacing the link.
        if (lstatSync(target).isSymbolicLink()) target = realpathSync(target)
        mode = statSync(target).mode & 0o777
      }
      mkdirSync(dirname(target), { recursive: true })
      temporary = join(dirname(target), `.${randomUUID()}.native-mcp.tmp`)
      descriptor = openSync(temporary, 'wx', mode)
      let offset = 0
      while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
      fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined
      renameSync(temporary, target); temporary = undefined
      try { const dir = openSync(dirname(target), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) } } catch { /* directory fsync unsupported */ }
      return this.result('saved', null, sha256(bytes))
    } catch {
      return this.result('rejected', 'The file could not be written.')
    } finally {
      if (descriptor !== undefined) try { closeSync(descriptor) } catch {}
      if (temporary) try { unlinkSync(temporary) } catch {}
    }
  }

  private applyKv(entry: Json, key: 'env' | 'headers', inputs: readonly NativeMcpKvInput[] | undefined): string | null {
    const existing = isRecord(entry[key]) ? entry[key] as Json : {}
    if (!inputs || inputs.length === 0) { delete entry[key]; return null }
    const keyPattern = key === 'env' ? /^[A-Za-z_][A-Za-z0-9_.-]*$/ : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
    const next: Record<string, string> = {}
    for (const item of inputs) {
      if (FORBIDDEN_NAMES.has(item.key) || !keyPattern.test(item.key)) return `Invalid ${key === 'env' ? 'environment variable' : 'header'} name "${item.key.slice(0, 40)}".`
      if (Object.hasOwn(next, item.key)) return `Duplicate ${key === 'env' ? 'environment variable' : 'header'} "${item.key}".`
      if (item.value !== undefined) next[item.key] = item.value
      else if (typeof existing[item.key] === 'string') next[item.key] = existing[item.key] as string
      else return `A value is required for new ${key === 'env' ? 'environment variable' : 'header'} "${item.key}".`
    }
    entry[key] = next
    return null
  }

  private apply(entry: Json, config: NativeMcpConfigInput): string | null {
    const setOrDelete = (key: string, value: unknown): void => { if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete entry[key]; else entry[key] = value }
    if (config.transport === 'stdio') {
      if (!config.command?.trim()) return 'A command is required for a stdio server.'
      for (const key of HTTP_ONLY) delete entry[key]
      entry.command = config.command.trim()
      setOrDelete('args', config.args?.length ? [...config.args] : undefined)
      setOrDelete('cwd', config.cwd?.trim())
      const problem = this.applyKv(entry, 'env', config.env)
      if (problem) return problem
    } else if (config.transport === 'http' || config.transport === 'sse') {
      const url = config.url?.trim()
      if (!url || !/^(https?:\/\/|\$\{|\$env:|\{env:)/.test(url)) return 'A URL starting with http:// or https:// is required.'
      for (const key of STDIO_ONLY) delete entry[key]
      const stored = typeof entry.url === 'string' ? entry.url : undefined
      entry.url = config.keepUrlExtras && stored !== undefined && redactUrl(stored).url === url ? stored : url
      if (config.transport === 'sse') entry.httpTransport = 'sse'
      else if (entry.httpTransport === 'sse') delete entry.httpTransport
      const problem = this.applyKv(entry, 'headers', config.headers)
      if (problem) return problem
      if (config.auth === 'oauth' || config.auth === 'bearer') entry.auth = config.auth
      else if (config.auth === 'none') entry.auth = false
      else delete entry.auth
    }
    if (config.lifecycle) entry.lifecycle = config.lifecycle; else delete entry.lifecycle
    setOrDelete('idleTimeout', config.idleTimeout)
    setOrDelete('requestTimeoutMs', config.requestTimeoutMs)
    if (config.exposeResources !== undefined) entry.exposeResources = config.exposeResources; else delete entry.exposeResources
    if (config.debug !== undefined) entry.debug = config.debug; else delete entry.debug
    if (config.directTools === 'keep') { /* untouched, may hold a per-tool list */ } else if (config.directTools !== undefined) entry.directTools = config.directTools; else delete entry.directTools
    setOrDelete('includeTools', config.includeTools?.length ? [...config.includeTools] : undefined)
    setOrDelete('excludeTools', config.excludeTools?.length ? [...config.excludeTools] : undefined)
    if (config.disabled === true) entry.disabled = true
    else if (entry.disabled !== false) delete entry.disabled
    return null
  }

  save(request: { origin: NativeMcpOrigin; name: string | null; newName: string; expectedRevision: string; config: NativeMcpConfigInput }): NativeMcpMutationResult {
    const newName = request.newName.trim()
    if (!newName || newName.length > 128 || /[\u0000-\u001f]/.test(newName) || FORBIDDEN_NAMES.has(newName)) return this.result('invalid', 'Enter a valid server name.')
    return this.mutate(request.origin, request.expectedRevision, (file) => {
      const servers = { ...file.servers }
      const previous = request.name === null ? undefined : servers[request.name]
      if (request.name !== null && !isRecord(previous)) return 'That server no longer exists in this file.'
      if (newName !== request.name && Object.hasOwn(servers, newName)) return `A server named "${newName}" already exists in this file.`
      const entry: Json = isRecord(previous) ? { ...previous } : {}
      const problem = this.apply(entry, request.config)
      if (problem) return problem
      if (request.name === null || newName === request.name) { servers[newName] = entry; return { servers } }
      const renamed: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(servers)) renamed[key === request.name ? newName : key] = key === request.name ? entry : value
      return { servers: renamed }
    })
  }

  remove(request: { origin: NativeMcpOrigin; name: string; expectedRevision: string }): NativeMcpMutationResult {
    return this.mutate(request.origin, request.expectedRevision, (file) => {
      if (!Object.hasOwn(file.servers, request.name)) return 'That server no longer exists in this file.'
      const servers = { ...file.servers }
      delete servers[request.name]
      return { servers }
    })
  }

  enable(request: { origin: NativeMcpOrigin; name: string; enabled: boolean; expectedRevision: string }): NativeMcpMutationResult {
    return this.mutate(request.origin, request.expectedRevision, (file) => {
      const previous = file.servers[request.name]
      if (!isRecord(previous)) return 'That server no longer exists in this file.'
      const entry: Json = { ...previous }
      if (!request.enabled) entry.disabled = true
      else {
        delete entry.disabled
        // A lower-precedence source that disables the server needs an explicit `false` here (adapter writeProjectServerDisabledOverride).
        const index = NATIVE_MCP_ORIGINS.indexOf(request.origin)
        const lowerDisabled = NATIVE_MCP_ORIGINS.slice(0, index).some((origin) => { const lower = this.load(origin).servers[request.name]; return isRecord(lower) && lower.disabled === true })
        if (lowerDisabled) entry.disabled = false
      }
      const servers = { ...file.servers }
      if (Object.keys(entry).length === 0) delete servers[request.name]; else servers[request.name] = entry
      return { servers }
    })
  }
}

export function registerNativeMcpCapabilities(service: NativeMcpConfig): CapabilityDefinition<any, any>[] {
  return [
    { id: 'native.mcp.list', scope: 'runtime', validateRequest: isNativeMcpEmptyRequest, validateResponse: isNativeMcpListResult, handle: async () => service.list() },
    { id: 'native.mcp.save', scope: 'runtime', validateRequest: isNativeMcpSaveRequest, validateResponse: isNativeMcpMutationResult, handle: async (_context, request) => service.save(request) },
    { id: 'native.mcp.remove', scope: 'runtime', validateRequest: isNativeMcpRemoveRequest, validateResponse: isNativeMcpMutationResult, handle: async (_context, request) => service.remove(request) },
    { id: 'native.mcp.enable', scope: 'runtime', validateRequest: isNativeMcpEnableRequest, validateResponse: isNativeMcpMutationResult, handle: async (_context, request) => service.enable(request) },
  ]
}
