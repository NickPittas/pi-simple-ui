import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { CapabilityDefinition } from '../ipc/register.ts'
import type { NativeCommandEntry } from '../../shared/native-pi.ts'
import {
  isNativeResourcesOverview,
  isNativeResourcesOverviewRequest,
  type NativeResourcesOverview,
  type OverviewContextFile,
  type OverviewNamedItem,
  type OverviewPackage,
  type OverviewPackageFilter,
  type ResourceTypeName,
} from '../../shared/native-resources-overview.ts'

/**
 * Read-only overview of what Pi loads. Pi owns loading; this only reads settings.json `packages`, package manifests,
 * well-known resource directories and context files, and attributes Pi's own get_commands answer to packages.
 * Never writes, installs or executes anything.
 */
export interface NativeResourcesOverviewDeps {
  readonly activeWorkspacePath: () => string | null
  readonly loadedCommands: () => Promise<readonly NativeCommandEntry[] | null>
  readonly agentDir?: string
}

const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_ITEMS = 300
const TYPES: readonly ResourceTypeName[] = ['extensions', 'skills', 'prompts', 'themes']
const CONTEXT_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'] as const // Pi 1.0.3 resource-loader.js loadContextFileFromDir

const message = (error: unknown): string => redactSource(error instanceof Error ? error.message : String(error)).slice(0, 300)

/** Strips URL userinfo and query strings from a package source so embedded tokens never leave main. */
export function redactSource(source: string): string {
  let out = source.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1')
  out = out.replace(/\?[^#@\s]*/g, '')
  return out.slice(0, 500)
}

function readJson(path: string): unknown {
  if (statSync(path).size > MAX_JSON_BYTES) throw new Error('file too large')
  return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

type Parsed = { kind: OverviewPackage['kind']; pin: string | null; installedPath: (base: string) => string | null }

/** Mirrors Pi 1.0.3 package-manager.js parseSource/getNpmInstallPath/getGitInstallPath for display purposes only. */
function parseSource(raw: string): Parsed {
  const source = raw.trim()
  if (source.startsWith('npm:')) {
    const match = source.slice(4).trim().match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)
    const name = match?.[1] ?? source.slice(4).trim()
    const ok = name.length > 0 && !name.includes('\0') && !name.split('/').includes('..')
    return { kind: 'npm', pin: match?.[2] ?? null, installedPath: (base) => (ok ? join(base, 'npm', 'node_modules', name) : null) }
  }
  const local = !/^(npm|git|github|https?|ssh):/i.test(source) && !/^git@/.test(source)
    && (source.startsWith('/') || source.startsWith('.') || source.startsWith('~') || source.startsWith('file:') || /^[a-zA-Z]:[\\/]/.test(source) || !source.includes('/') || !/^[^/]+\.[^/]+\/./.test(source))
  if (local) {
    const path = expandHome(source.startsWith('file:') ? source.slice(5).replace(/^\/\//, '') : source)
    return { kind: 'local', pin: null, installedPath: (base) => (isAbsolute(path) ? resolve(path) : resolve(base, path)) }
  }
  let url = source.startsWith('git:') ? source.slice(4).trim() : source
  let host = ''
  let path = ''
  let ref: string | null = null
  const scp = url.match(/^git@([^:]+):(.+)$/)
  if (scp) { host = scp[1]!; path = scp[2]! } else if (url.includes('://')) {
    try { const u = new URL(url); host = u.hostname; path = u.pathname.replace(/^\/+/, '') } catch { return { kind: 'other', pin: null, installedPath: () => null } }
  } else {
    url = url.replace(/^github:/, 'github.com/')
    const slash = url.indexOf('/')
    if (slash < 0) return { kind: 'other', pin: null, installedPath: () => null }
    host = url.slice(0, slash); path = url.slice(slash + 1)
  }
  const at = path.indexOf('@')
  if (at >= 0) { ref = path.slice(at + 1) || null; path = path.slice(0, at) }
  path = path.replace(/\.git$/, '').replace(/^\/+/, '')
  const safe = host.length > 0 && path.split('/').length >= 2 && !path.includes('\\') && !path.split('/').includes('..') && !host.includes('/')
  return { kind: 'git', pin: ref, installedPath: (base) => (safe ? join(base, 'git', host, path) : null) }
}

function packageEntries(file: string, scope: 'user' | 'project'): { entries: { source: string; filters: OverviewPackageFilter[]; scope: 'user' | 'project' }[]; error: string | null } {
  if (!existsSync(file)) return { entries: [], error: null }
  try {
    const json = readJson(file)
    const list = isRecord(json) ? json.packages : undefined
    if (list === undefined) return { entries: [], error: null }
    if (!Array.isArray(list)) return { entries: [], error: `${scope} settings: "packages" is not an array` }
    const entries: { source: string; filters: OverviewPackageFilter[]; scope: 'user' | 'project' }[] = []
    for (const item of list) {
      if (typeof item === 'string') entries.push({ source: item, filters: [], scope })
      else if (isRecord(item) && typeof item.source === 'string') {
        const filters = TYPES.flatMap((type) => {
          const v = item[type]
          return Array.isArray(v) && v.every((x) => typeof x === 'string') ? [{ type, patterns: (v as string[]).slice(0, 50).map((x) => x.slice(0, 200)) }] : []
        })
        entries.push({ source: item.source, filters, scope })
      }
    }
    return { entries, error: null }
  } catch (error) {
    return { entries: [], error: `${scope} settings unreadable: ${message(error)}` }
  }
}

function packageInfo(dir: string): { version: string | null; manifestExtensions: number | null } {
  try {
    const pkg = readJson(join(dir, 'package.json'))
    if (!isRecord(pkg)) return { version: null, manifestExtensions: null }
    const pi = pkg.pi
    const ext = isRecord(pi) && Array.isArray(pi.extensions) && pi.extensions.every((x) => typeof x === 'string') ? pi.extensions.length : null
    return { version: typeof pkg.version === 'string' ? pkg.version.slice(0, 80) : null, manifestExtensions: ext }
  } catch { return { version: null, manifestExtensions: null } }
}

function listDir(dir: string, scope: 'user' | 'project', kind: ResourceTypeName): OverviewNamedItem[] {
  let names: string[]
  try { names = readdirSync(dir).sort() } catch { return [] }
  const out: OverviewNamedItem[] = []
  for (const entry of names) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    let isDir = false
    let isFile = false
    try { const s = statSync(join(dir, entry)); isDir = s.isDirectory(); isFile = s.isFile() } catch { continue }
    if (kind === 'skills') { if (isDir) { if (existsSync(join(dir, entry, 'SKILL.md'))) out.push({ name: entry, scope }) } else if (isFile && entry.endsWith('.md')) out.push({ name: entry.replace(/\.md$/, ''), scope }) }
    else if (kind === 'prompts') { if (isFile && entry.endsWith('.md')) out.push({ name: entry.replace(/\.md$/, ''), scope }) }
    else if (kind === 'themes') { if (isFile && entry.endsWith('.json')) out.push({ name: entry.replace(/\.json$/, ''), scope }) }
    else if ((isFile && /\.(ts|js|mjs|cjs)$/.test(entry)) || isDir) out.push({ name: entry, scope })
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

function contextFileIn(dir: string, scope: 'user' | 'project'): OverviewContextFile | null {
  for (const name of CONTEXT_NAMES) {
    const path = join(dir, name)
    try { const s = statSync(path); if (s.isFile()) return { path, scope, bytes: s.size } } catch { /* next candidate */ }
  }
  return null
}

export class NativeResourcesOverviewService {
  private readonly agentDir: string
  constructor(private readonly deps: NativeResourcesOverviewDeps) {
    this.agentDir = resolve(expandHome(deps.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')))
  }

  async overview(): Promise<NativeResourcesOverview> {
    const cwd = this.deps.activeWorkspacePath()
    const errors: NativeResourcesOverview['errors'] = { packages: null, commands: null, topLevel: null, contextFiles: null }
    const result: NativeResourcesOverview = {
      workspacePath: cwd,
      packages: [],
      topLevel: { skills: [], prompts: [], extensions: [], themes: [] },
      contextFiles: [],
      errors,
    }
    let commands: readonly NativeCommandEntry[] | null = null
    try { commands = await this.deps.loadedCommands() } catch (error) { errors.commands = message(error) }
    if (commands === null && errors.commands === null) errors.commands = 'Pi did not report its commands; contribution counts are unavailable.'
    try {
      const projectBase = cwd ? join(cwd, '.pi') : null
      const user = packageEntries(join(this.agentDir, 'settings.json'), 'user')
      const project = projectBase ? packageEntries(join(projectBase, 'settings.json'), 'project') : { entries: [], error: null }
      errors.packages = [user.error, project.error].filter(Boolean).join('; ') || null
      for (const entry of [...project.entries, ...user.entries]) {
        const parsed = parseSource(entry.source)
        const base = entry.scope === 'project' ? projectBase! : this.agentDir
        let installedPath: string | null = null
        try { installedPath = parsed.installedPath(base) } catch { installedPath = null }
        const installed = installedPath !== null && existsSync(installedPath)
        const info = installed && installedPath ? packageInfo(installedPath) : { version: null, manifestExtensions: null }
        result.packages.push({
          source: redactSource(entry.source), kind: parsed.kind, scope: entry.scope, pin: parsed.pin ? redactSource(parsed.pin) : null,
          filters: entry.filters, installedPath: installed ? installedPath : null, installed, packageVersion: info.version,
          contributions: commands ? this.attribute(commands, entry.source, entry.scope, installed ? installedPath : null) : null,
          manifestExtensions: info.manifestExtensions,
        })
      }
    } catch (error) { errors.packages = message(error) }
    try {
      const t = result.topLevel
      for (const kind of TYPES) t[kind].push(...listDir(join(this.agentDir, kind), 'user', kind))
      if (cwd) for (const kind of TYPES) t[kind].push(...listDir(join(cwd, '.pi', kind), 'project', kind))
    } catch (error) { errors.topLevel = message(error) }
    try {
      const global = contextFileIn(this.agentDir, 'user')
      if (global) result.contextFiles.push(global)
      if (cwd) {
        const ancestors: OverviewContextFile[] = []
        let dir = resolve(cwd)
        for (;;) {
          const found = contextFileIn(dir, 'project')
          if (found && !result.contextFiles.some((f) => f.path === found.path)) ancestors.unshift(found)
          const parent = dirname(dir)
          if (parent === dir) break
          dir = parent
        }
        result.contextFiles.push(...ancestors)
      }
    } catch (error) { errors.contextFiles = message(error) }
    return result
  }

  private attribute(commands: readonly NativeCommandEntry[], rawSource: string, scope: 'user' | 'project', installedPath: string | null) {
    const out = { commands: 0, skills: 0, prompts: 0 }
    for (const command of commands) {
      const info = command.sourceInfo
      if (!info || info.origin !== 'package' || info.scope !== scope) continue
      const underPath = installedPath !== null && [info.baseDir, info.path].some((p) => typeof p === 'string' && p.length > 0 && inside(installedPath, resolve(p)))
      if (!underPath && info.source !== rawSource) continue
      if (command.source === 'extension') out.commands++
      else if (command.source === 'skill') out.skills++
      else out.prompts++
    }
    return out
  }
}

export function registerNativeResourcesOverviewCapabilities(service: NativeResourcesOverviewService): CapabilityDefinition<any, any>[] {
  return [{ id: 'native.resources.overview', scope: 'runtime', validateRequest: isNativeResourcesOverviewRequest, validateResponse: isNativeResourcesOverview, handle: () => service.overview() }]
}
