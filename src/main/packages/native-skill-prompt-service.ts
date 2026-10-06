import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { NativeCommandEntry } from '../../shared/native-pi.ts'
import type {
  PackageScope,
  PromptTemplateResourceView,
  ResourceListResponse,
  ResourceSource,
  SkillCreateRequest,
  SkillDeleteRequest,
  SkillDocumentView,
  SkillEnableRequest,
  SkillEnableResponse,
  SkillMutationResponse,
  SkillReadRequest,
  SkillResourceView,
  SkillUpdateRequest,
  TemplateCreateRequest,
  TemplateDeleteRequest,
  TemplateDocumentView,
  TemplateEnableRequest,
  TemplateEnableResponse,
  TemplateMutationResponse,
  TemplateReadRequest,
  TemplateUpdateRequest,
} from '../../shared/packages.ts'

/**
 * File-based skills and prompt-template management for the native (Pi RPC) composition.
 *
 * - No SDK value imports, no in-process session. Pi stays authoritative: "loaded" comes from the running Pi's
 *   `get_commands` (sourceInfo.path), everything else is discovered from the same directories Pi scans.
 * - Writes are confined to the Pi-managed user/project skill and prompt directories, never follow symlinks, and are atomic.
 * - Enable/disable edits the exact native mechanism: the `skills` / `prompts` arrays of settings.json (`-path` / `+path`).
 * - There is no RPC reload in Pi; mutations report `restartRequired: true`.
 */

const MAX_FILE_BYTES = 1024 * 1024
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024
const MAX_DEPTH = 12
const MAX_ENTRIES = 2000
const FM_KEY = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TEMPLATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type Kind = 'skill' | 'template'
type Mode = 'pi' | 'agents'

interface Root {
  readonly kind: Kind
  readonly scope: PackageScope
  readonly dir: string
  /** Pi's baseDir for settings patterns (relative(baseDir, file)). */
  readonly baseDir: string
  readonly mode: Mode
  /** Pi-managed directory this app may write into. */
  readonly managed: boolean
}

interface Item {
  readonly kind: Kind
  readonly scope: PackageScope | 'temporary'
  readonly path: string
  readonly source: ResourceSource
  readonly sourceDetail?: string
  readonly name: string
  readonly description: string
  readonly disableModelInvocation: boolean
  readonly argumentHint?: string
  readonly root?: Root
  readonly writable: boolean
  readonly readOnlyReason?: string
  readonly loaded: boolean
  readonly enabled: boolean
  readonly shadowedBy?: string
}

interface LoadedEntry { readonly name: string; readonly description: string | null; readonly path: string; readonly scope: 'user' | 'project' | 'temporary'; readonly origin: 'package' | 'top-level'; readonly source: string }

export interface NativeSkillPromptServiceOptions {
  readonly agentDir?: string
  readonly homeDir?: string
  /** Active workspace cwd, or null when no runtime is active. */
  readonly activeWorkspacePath: () => string | null
  /** The running Pi's get_commands (with sourceInfo), or null when unavailable. */
  readonly loadedCommands: () => Promise<readonly NativeCommandEntry[] | null>
}

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const posix = (value: string): string => value.split(sep).join('/')

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null
    throw error
  }
}

function canonical(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

// ---------------------------------------------------------------- frontmatter (text-preserving, no YAML dependency)

interface SplitDocument {
  readonly bom: string
  readonly crlf: boolean
  /** LF-normalised text without BOM. */
  readonly text: string
  /** Raw YAML between the fences, or null when there is no frontmatter (same rule as Pi's extractFrontmatter). */
  readonly fmRaw: string | null
  /** Text through the closing `---` (empty when no frontmatter). */
  readonly head: string
  /** Text after the closing `---` (the whole text when no frontmatter). */
  readonly rest: string
}

function splitDocument(raw: string): SplitDocument {
  const bom = raw.startsWith('﻿') ? '﻿' : ''
  const body = bom ? raw.slice(1) : raw
  const crlf = body.includes('\r\n') && !/(^|[^\r])\n/.test(body)
  const text = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!text.startsWith('---')) return { bom, crlf, text, fmRaw: null, head: '', rest: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { bom, crlf, text, fmRaw: null, head: '', rest: text }
  return { bom, crlf, text, fmRaw: text.slice(4, end), head: text.slice(0, end + 4), rest: text.slice(end + 4) }
}

function joinDocument(parts: { bom: string; crlf: boolean }, text: string): string {
  return parts.bom + (parts.crlf ? text.replace(/\n/g, '\r\n') : text)
}

type Segment = { key: string | null; lines: string[] }

function segmentFrontmatter(fmRaw: string): Segment[] {
  const segments: Segment[] = []
  for (const line of fmRaw.split('\n')) {
    const match = FM_KEY.exec(line)
    if (match) segments.push({ key: match[1]!, lines: [line] })
    else if (segments.length === 0) segments.push({ key: null, lines: [line] })
    else segments[segments.length - 1]!.lines.push(line)
  }
  return segments
}

function stripComment(value: string): string {
  const match = /(^|\s)#/.exec(value)
  return (match ? value.slice(0, match.index) : value).trimEnd()
}

/** Best-effort decode of one frontmatter block. Returns undefined when the shape is not understood (never guesses). */
function decodeBlock(segment: Segment): unknown {
  const first = FM_KEY.exec(segment.lines[0]!)
  const inline = (first?.[2] ?? '').trim()
  const continuation = segment.lines.slice(1)
  const indentedContinuation = continuation.filter((line) => line.trim() !== '' && !/^\s*#/.test(line))
  if (inline === '' || inline.startsWith('#')) return indentedContinuation.length === 0 ? null : undefined
  const blockMatch = /^([|>])([+-]?)(\d?)([+-]?)\s*(#.*)?$/.exec(inline)
  if (blockMatch) {
    const lines = continuation.slice()
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
    const indents = lines.filter((line) => line.trim() !== '').map((line) => /^ */.exec(line)![0].length)
    const indent = indents.length > 0 ? Math.min(...indents) : 0
    const stripped = lines.map((line) => line.slice(Math.min(indent, /^ */.exec(line)![0].length)))
    let textValue: string
    if (blockMatch[1] === '|') textValue = stripped.join('\n')
    else {
      textValue = ''
      for (let index = 0; index < stripped.length; index += 1) {
        const line = stripped[index]!
        if (index > 0) textValue += stripped[index - 1] === '' || line === '' ? '\n' : ' '
        textValue += line
      }
      textValue = textValue.replace(/\n\n/g, '\n')
    }
    const chomp = `${blockMatch[2]}${blockMatch[4]}`
    return chomp.includes('-') ? textValue : `${textValue}\n`
  }
  if (inline.startsWith('"')) {
    if (indentedContinuation.length > 0) return undefined
    const match = /^("(?:[^"\\]|\\.)*")\s*(#.*)?$/.exec(inline)
    if (!match) return undefined
    try { return JSON.parse(match[1]!) as unknown } catch { return undefined }
  }
  if (inline.startsWith("'")) {
    if (indentedContinuation.length > 0) return undefined
    const match = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(inline)
    return match ? match[1]!.replace(/''/g, "'") : undefined
  }
  if (inline.startsWith('[') || inline.startsWith('{')) {
    if (indentedContinuation.length > 0) return undefined
    try { return JSON.parse(stripComment(inline)) as unknown } catch { return undefined }
  }
  if (inline.startsWith('&') || inline.startsWith('*') || inline.startsWith('!')) return undefined
  const plain = [stripComment(inline), ...indentedContinuation.map((line) => line.trim())].join(' ').trim()
  if (/^(true|True|TRUE)$/.test(plain)) return true
  if (/^(false|False|FALSE)$/.test(plain)) return false
  if (/^(null|Null|NULL|~)$/.test(plain)) return null
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(plain)) return Number(plain)
  return plain
}

function frontmatterValues(fmRaw: string | null): Map<string, unknown> {
  const values = new Map<string, unknown>()
  if (fmRaw === null) return values
  for (const segment of segmentFrontmatter(fmRaw)) {
    if (segment.key === null || values.has(segment.key)) continue
    values.set(segment.key, decodeBlock(segment))
  }
  return values
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function encodeValue(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('A frontmatter value could not be serialized.')
  return encoded
}

function assertSafeKey(key: string): void {
  if (UNSAFE_KEYS.has(key) || !/^[A-Za-z0-9_.-]{1,128}$/.test(key)) throw new Error(`Frontmatter key "${key.slice(0, 64)}" is not supported.`)
}

/** Replace/remove/add only the patched top-level keys; every other line (unknown keys, comments, formatting) is kept verbatim. */
function patchFrontmatter(fmRaw: string | null, patch: Readonly<Record<string, unknown>>): string | null {
  const entries = Object.entries(patch)
  for (const [key] of entries) assertSafeKey(key)
  const segments = fmRaw === null ? [] : segmentFrontmatter(fmRaw)
  const additions: string[] = []
  for (const [key, value] of entries) {
    const index = segments.findIndex((segment) => segment.key === key)
    if (value === null || value === undefined) {
      if (index !== -1) segments.splice(index, 1)
      continue
    }
    if (index === -1) { additions.push(`${key}: ${encodeValue(value)}`); continue }
    const current = decodeBlock(segments[index]!)
    if (current !== undefined && deepEqual(current, value)) continue
    segments[index] = { key, lines: [`${key}: ${encodeValue(value)}`] }
  }
  let lines = segments.flatMap((segment) => segment.lines)
  if (additions.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
    lines = [...lines, ...additions]
  }
  const result = lines.join('\n')
  if (fmRaw === null && lines.length === 0) return null
  // Self-check: every patched key must decode back to the requested value, otherwise refuse rather than corrupt the file.
  const check = frontmatterValues(result)
  for (const [key, value] of entries) {
    if (value === null || value === undefined) { if (check.has(key) && check.get(key) !== null) throw new Error('Frontmatter could not be updated safely.'); continue }
    if (!deepEqual(check.get(key), value)) throw new Error('Frontmatter could not be updated safely.')
  }
  return result
}

function buildDocument(frontmatter: Readonly<Record<string, unknown>>, body: string): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined) continue
    assertSafeKey(key)
    lines.push(`${key}: ${encodeValue(value)}`)
  }
  const normalized = body.replace(/\r\n?/g, '\n').replace(/^\n+/, '')
  const bodyText = normalized === '' ? '' : `${normalized}${normalized.endsWith('\n') ? '' : '\n'}`
  return lines.length === 0 ? bodyText : `---\n${lines.join('\n')}\n---\n\n${bodyText}`
}

function rewriteDocument(split: SplitDocument, patch: Readonly<Record<string, unknown>>, body: string): string {
  const newFm = patchFrontmatter(split.fmRaw, patch)
  const newBody = body.replace(/\r\n?/g, '\n')
  const hadFrontmatter = split.fmRaw !== null
  const originalBody = hadFrontmatter ? split.rest : split.text
  const bodyChanged = originalBody.trim() !== newBody.trim()
  let text: string
  if (!hadFrontmatter) {
    const prefix = newFm === null ? '' : `---\n${newFm}\n---\n\n`
    const bodyText = bodyChanged ? `${newBody}${newBody.endsWith('\n') || newBody === '' ? '' : '\n'}` : originalBody
    text = prefix + bodyText
  } else {
    const head = newFm === split.fmRaw ? split.head : `---\n${newFm ?? ''}\n---`
    const leading = /^\s*/.exec(originalBody)![0] || '\n'
    const trailing = /\s*$/.exec(originalBody)![0]
    text = head + (bodyChanged ? `${leading}${newBody.trim()}${trailing.includes('\n') ? trailing : '\n'}` : originalBody)
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error('The resource file would be too large.')
  return text
}

// ---------------------------------------------------------------- glob (approximation of minimatch for `!pattern` entries only)

function globToRegExp(glob: string): RegExp {
  let source = ''
  let braces = 0
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1
        if (glob[index + 1] === '/') { index += 1; source += '(?:.*/)?' } else source += '.*'
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else if (char === '{') { braces += 1; source += '(?:' }
    else if (char === '}' && braces > 0) { braces -= 1; source += ')' }
    else if (char === ',' && braces > 0) source += '|'
    else if (char === '[') {
      const close = glob.indexOf(']', index + 1)
      if (close === -1) source += '\\['
      else { source += glob.slice(index, close + 1).replace(/^\[!/, '[^'); index = close }
    } else source += char.replace(/[.+^$()|\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

// ---------------------------------------------------------------- Pi's native filter semantics (core/package-manager.js:473-546)

function patternTargets(filePath: string, baseDir: string): { exact: string[]; loose: string[] } {
  const rel = posix(relative(baseDir, filePath))
  const name = basename(filePath)
  const abs = posix(filePath)
  const isSkillFile = name === 'SKILL.md'
  const exact = [rel, abs]
  const loose = [rel, name, abs]
  if (isSkillFile) {
    const parent = dirname(filePath)
    exact.push(posix(relative(baseDir, parent)), posix(parent))
    loose.push(posix(relative(baseDir, parent)), basename(parent), posix(parent))
  }
  return { exact, loose }
}

const normalizeExact = (pattern: string): string => posix(pattern.startsWith('./') || pattern.startsWith('.\\') ? pattern.slice(2) : pattern)

/** Mirror of Pi's isEnabledByOverrides: `!glob` excludes, `+path` force-includes (exact), `-path` force-excludes (exact, wins). */
function isEnabledByOverrides(filePath: string, entries: readonly string[], baseDir: string): boolean {
  const { exact, loose } = patternTargets(filePath, baseDir)
  const excludes = entries.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1))
  const forceIncludes = entries.filter((entry) => entry.startsWith('+')).map((entry) => normalizeExact(entry.slice(1)))
  const forceExcludes = entries.filter((entry) => entry.startsWith('-')).map((entry) => normalizeExact(entry.slice(1)))
  let enabled = true
  if (excludes.some((pattern) => { const regex = globToRegExp(posix(pattern)); return loose.some((target) => regex.test(target)) })) enabled = false
  if (forceIncludes.some((pattern) => exact.includes(pattern))) enabled = true
  if (forceExcludes.some((pattern) => exact.includes(pattern))) enabled = false
  return enabled
}

// ---------------------------------------------------------------- service

export class NativeSkillPromptService {
  private readonly agentDir: string
  private readonly homeDir: string
  private readonly activeWorkspacePath: () => string | null
  private readonly loadedCommands: () => Promise<readonly NativeCommandEntry[] | null>
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(options: NativeSkillPromptServiceOptions) {
    this.agentDir = resolve(options.agentDir ?? join(homedir(), '.pi', 'agent'))
    this.homeDir = resolve(options.homeDir ?? homedir())
    this.activeWorkspacePath = options.activeWorkspacePath
    this.loadedCommands = options.loadedCommands
  }

  // ---- listing

  async list(): Promise<ResourceListResponse> {
    const { items } = await this.collect()
    const skills: SkillResourceView[] = []
    const promptTemplates: PromptTemplateResourceView[] = []
    for (const item of items) {
      const view = {
        path: item.path,
        source: item.source,
        scope: item.scope,
        ...(item.sourceDetail ? { sourceDetail: item.sourceDetail } : {}),
        name: (item.name || basename(item.path)).slice(0, 1024),
        description: item.description.slice(0, 8192),
        loaded: item.loaded,
        enabled: item.enabled,
        writable: item.writable,
        ...(item.readOnlyReason ? { readOnlyReason: item.readOnlyReason } : {}),
        ...(item.shadowedBy ? { shadowedBy: item.shadowedBy } : {}),
      }
      if (item.kind === 'skill') skills.push(view)
      else promptTemplates.push(view)
    }
    // Native composition does not enumerate extensions/themes/context files here; the app reads them from Pi or native config.
    return { generation: 0, loading: false, extensions: [], skills, promptTemplates, themes: [], contextFiles: [] }
  }

  // ---- reads

  async readSkill(request: SkillReadRequest): Promise<SkillDocumentView> {
    const { item, raw } = await this.readItem('skill', request.scope, request.path)
    return this.skillView(item, raw)
  }

  async readTemplate(request: TemplateReadRequest): Promise<TemplateDocumentView> {
    const { item, raw } = await this.readItem('template', request.scope, request.path)
    return this.templateView(item, raw)
  }

  // ---- skill mutations

  createSkill(request: SkillCreateRequest): Promise<SkillMutationResponse> {
    return this.enqueue(async () => {
      if (!SKILL_NAME.test(request.name) || request.name.length > 64) throw new Error('The skill name is invalid.')
      if (request.description.trim() === '' || request.description.length > 1024) throw new Error('Skill description must be non-empty and at most 1024 characters.')
      const root = this.managedRoot('skill', request.scope)
      const path = join(root.dir, request.name, 'SKILL.md')
      const content = buildDocument({
        name: request.name,
        description: request.description,
        ...(request.disableModelInvocation === undefined ? {} : { 'disable-model-invocation': request.disableModelInvocation }),
      }, request.body)
      const created = this.createExclusive(root, path, content)
      const item = await this.findWritable('skill', request.scope, path).catch(() => null)
      const view = item ? this.skillView(item.item, item.raw) : null
      return created ? { outcome: 'saved', item: view, restartRequired: true } : { outcome: 'conflict', item: view }
    })
  }

  updateSkill(request: SkillUpdateRequest): Promise<SkillMutationResponse> {
    return this.enqueue(async () => {
      const found = await this.findWritable('skill', request.scope, request.path)
      if (!found) return { outcome: 'not-found', item: null }
      if (found.revision !== request.expectedRevision) return { outcome: 'conflict', item: this.skillView(found.item, found.raw) }
      this.validateSkillPatch(request.frontmatter, found)
      const text = rewriteDocument(splitDocument(found.raw), request.frontmatter, request.body)
      this.replaceExisting(found, joinDocument(splitDocument(found.raw), text))
      const after = await this.findWritable('skill', request.scope, request.path)
      return { outcome: 'saved', item: after ? this.skillView(after.item, after.raw) : null, restartRequired: true }
    })
  }

  deleteSkill(request: SkillDeleteRequest): Promise<SkillMutationResponse> {
    return this.enqueue(async () => {
      const found = await this.findWritable('skill', request.scope, request.path)
      if (!found) return { outcome: 'not-found', item: null }
      if (found.revision !== request.expectedRevision) return { outcome: 'conflict', item: this.skillView(found.item, found.raw) }
      this.removeExisting(found, true)
      return { outcome: 'saved', item: null, restartRequired: true }
    })
  }

  setSkillEnabled(request: SkillEnableRequest): Promise<SkillEnableResponse> {
    return this.enqueue(async () => {
      const result = await this.setEnabled('skill', request.scope, request.path, request.enabled)
      return {
        outcome: result.outcome, scope: request.scope, path: result.path, enabled: request.enabled,
        semantics: 'native-skill-filter', globalSkillCommandsEnabled: this.enableSkillCommands(),
        ...(result.outcome === 'saved' ? { restartRequired: true } : {}),
      }
    })
  }

  // ---- template mutations

  createTemplate(request: TemplateCreateRequest): Promise<TemplateMutationResponse> {
    return this.enqueue(async () => {
      if (!TEMPLATE_NAME.test(request.name)) throw new Error('The prompt template name is invalid.')
      this.validateTemplateFrontmatter(request.frontmatter)
      const root = this.managedRoot('template', request.scope)
      const path = join(root.dir, `${request.name}.md`)
      const created = this.createExclusive(root, path, buildDocument(request.frontmatter, request.body))
      const item = await this.findWritable('template', request.scope, path).catch(() => null)
      const view = item ? this.templateView(item.item, item.raw) : null
      return created ? { outcome: 'saved', item: view, restartRequired: true } : { outcome: 'conflict', item: view }
    })
  }

  updateTemplate(request: TemplateUpdateRequest): Promise<TemplateMutationResponse> {
    return this.enqueue(async () => {
      const found = await this.findWritable('template', request.scope, request.path)
      if (!found) return { outcome: 'not-found', item: null }
      if (found.revision !== request.expectedRevision) return { outcome: 'conflict', item: this.templateView(found.item, found.raw) }
      this.validateTemplateFrontmatter(request.frontmatter)
      const split = splitDocument(found.raw)
      this.replaceExisting(found, joinDocument(split, rewriteDocument(split, request.frontmatter, request.body)))
      const after = await this.findWritable('template', request.scope, request.path)
      return { outcome: 'saved', item: after ? this.templateView(after.item, after.raw) : null, restartRequired: true }
    })
  }

  deleteTemplate(request: TemplateDeleteRequest): Promise<TemplateMutationResponse> {
    return this.enqueue(async () => {
      const found = await this.findWritable('template', request.scope, request.path)
      if (!found) return { outcome: 'not-found', item: null }
      if (found.revision !== request.expectedRevision) return { outcome: 'conflict', item: this.templateView(found.item, found.raw) }
      this.removeExisting(found, false)
      return { outcome: 'saved', item: null, restartRequired: true }
    })
  }

  setTemplateEnabled(request: TemplateEnableRequest): Promise<TemplateEnableResponse> {
    return this.enqueue(async () => {
      const result = await this.setEnabled('template', request.scope, request.path, request.enabled)
      return {
        outcome: result.outcome, scope: request.scope, path: result.path, enabled: request.enabled,
        semantics: 'native-prompt-filter',
        ...(result.outcome === 'saved' ? { restartRequired: true } : {}),
      }
    })
  }

  // ---------------------------------------------------------------- roots, trust, settings

  private cwd(): string | null {
    const cwd = this.activeWorkspacePath()
    return cwd ? resolve(cwd) : null
  }

  /** Mirrors Pi's decision inputs: trust.json nearest entry, else settings.defaultProjectTrust === 'always'. Session-only trust is not observable. */
  private projectTrusted(cwd: string, loadedProject: boolean): boolean {
    if (loadedProject) return true
    try {
      const trustPath = join(this.agentDir, 'trust.json')
      if (existsSync(trustPath)) {
        const data = JSON.parse(readFileSync(trustPath, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>
        let dir = canonical(cwd)
        for (;;) {
          const value = Object.hasOwn(data, dir) ? data[dir] : undefined
          if (value === true) return true
          if (value === false) return false
          const parent = dirname(dir)
          if (parent === dir) break
          dir = parent
        }
      }
      const settings = this.readSettingsObject(join(this.agentDir, 'settings.json'))
      return settings.object.defaultProjectTrust === 'always'
    } catch {
      return false
    }
  }

  private findGitRoot(start: string): string | null {
    let dir = resolve(start)
    for (;;) {
      if (existsSync(join(dir, '.git'))) return dir
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }

  private roots(cwd: string | null, projectTrusted: boolean): Root[] {
    const roots: Root[] = [
      { kind: 'skill', scope: 'user', dir: join(this.agentDir, 'skills'), baseDir: this.agentDir, mode: 'pi', managed: true },
      { kind: 'skill', scope: 'user', dir: join(this.homeDir, '.agents', 'skills'), baseDir: join(this.homeDir, '.agents'), mode: 'agents', managed: false },
      { kind: 'template', scope: 'user', dir: join(this.agentDir, 'prompts'), baseDir: this.agentDir, mode: 'pi', managed: true },
    ]
    if (cwd && projectTrusted) {
      const piDir = join(cwd, '.pi')
      roots.push({ kind: 'skill', scope: 'project', dir: join(piDir, 'skills'), baseDir: piDir, mode: 'pi', managed: true })
      roots.push({ kind: 'template', scope: 'project', dir: join(piDir, 'prompts'), baseDir: piDir, mode: 'pi', managed: true })
      const gitRoot = this.findGitRoot(cwd)
      const userAgents = join(this.homeDir, '.agents', 'skills')
      let dir = cwd
      for (;;) {
        const skillsDir = join(dir, '.agents', 'skills')
        if (resolve(skillsDir) !== resolve(userAgents)) {
          roots.push({ kind: 'skill', scope: 'project', dir: skillsDir, baseDir: join(dir, '.agents'), mode: 'agents', managed: false })
        }
        if (gitRoot && dir === gitRoot) break
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
    return roots
  }

  private managedRoot(kind: Kind, scope: PackageScope): Root {
    const cwd = this.cwd()
    if (scope === 'project') {
      if (!cwd) throw new Error('Project resources need an active workspace.')
      if (!this.projectTrusted(cwd, false)) throw new Error('Project resource operations require the workspace to be trusted in Pi.')
    }
    const root = this.roots(cwd, scope === 'project').find((candidate) => candidate.kind === kind && candidate.scope === scope && candidate.managed)
    if (!root) throw new Error('The resource directory is not available.')
    return root
  }

  // ---- discovery (port of Pi's collectSkillEntries / collectAutoPromptEntries, minus .gitignore handling)

  private discoverSkillFiles(dir: string, mode: Mode, root: string, depth: number, seen: Set<string>, out: string[]): void {
    if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return
    let real: string
    try { real = realpathSync(dir) } catch { return }
    if (seen.has(real)) return
    seen.add(real)
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name !== 'SKILL.md') continue
      const full = join(dir, entry.name)
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) { try { isFile = statSync(full).isFile() } catch { continue } }
      if (isFile) { out.push(full); return }
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try { const stat = statSync(full); isDir = stat.isDirectory(); isFile = stat.isFile() } catch { continue }
      }
      if (isFile && entry.name.endsWith('.md') && ((mode === 'pi' && dir === root) || (mode === 'agents' && dir !== root))) { out.push(full); continue }
      if (isDir) this.discoverSkillFiles(full, mode, root, depth + 1, seen, out)
    }
  }

  private discoverPromptFiles(dir: string): string[] {
    const out: string[] = []
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || !entry.name.endsWith('.md')) continue
      const full = join(dir, entry.name)
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) { try { isFile = statSync(full).isFile() } catch { continue } }
      if (isFile) out.push(full)
    }
    return out
  }

  /** True when any path component from the root directory (inclusive) down to the file is a symlink. */
  private hasSymlinkBelow(root: Root, file: string): boolean {
    try {
      let current = resolve(root.dir)
      if (lstatSync(current).isSymbolicLink()) return true
      for (const part of relative(current, file).split(sep)) {
        current = join(current, part)
        if (lstatSync(current).isSymbolicLink()) return true
      }
      return false
    } catch { return true }
  }

  private readSmall(path: string): { raw: string; bytes: Buffer } | null {
    try {
      const stat = statSync(path)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
      const bytes = readFileSync(path)
      return { raw: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), bytes }
    } catch { return null }
  }

  private async loadedEntries(): Promise<{ known: boolean; skills: LoadedEntry[]; prompts: LoadedEntry[] }> {
    let commands: readonly NativeCommandEntry[] | null = null
    try { commands = await this.loadedCommands() } catch { commands = null }
    if (!commands) return { known: false, skills: [], prompts: [] }
    const skills: LoadedEntry[] = []
    const prompts: LoadedEntry[] = []
    for (const command of commands) {
      const info = command.sourceInfo
      if (!info) continue
      if (command.source === 'skill') skills.push({ name: command.name.replace(/^skill:/, ''), description: command.description, path: info.path, scope: info.scope, origin: info.origin, source: info.source })
      else if (command.source === 'prompt') prompts.push({ name: command.name, description: command.description, path: info.path, scope: info.scope, origin: info.origin, source: info.source })
    }
    return { known: true, skills, prompts }
  }

  private async collect(): Promise<{ items: Item[]; cwd: string | null; roots: Root[]; trusted: boolean }> {
    const cwd = this.cwd()
    const loaded = await this.loadedEntries()
    const loadedProject = [...loaded.skills, ...loaded.prompts].some((entry) => entry.scope === 'project')
    const trusted = cwd ? this.projectTrusted(cwd, loadedProject) : false
    const roots = this.roots(cwd, trusted)
    const settings = {
      user: this.settingsArrays(join(this.agentDir, 'settings.json')),
      project: cwd && trusted ? this.settingsArrays(join(cwd, '.pi', 'settings.json')) : { skills: [] as string[], prompts: [] as string[] },
    }
    const loadedByPath = {
      skill: new Map(loaded.skills.map((entry) => [canonical(entry.path), entry])),
      template: new Map(loaded.prompts.map((entry) => [canonical(entry.path), entry])),
    }
    const items: Item[] = []
    const seenPaths = new Set<string>()
    for (const root of roots) {
      const files: string[] = []
      if (root.kind === 'skill') this.discoverSkillFiles(root.dir, root.mode, root.dir, 0, new Set(), files)
      else files.push(...this.discoverPromptFiles(root.dir))
      for (const file of files) {
        const real = canonical(file)
        if (seenPaths.has(real)) continue // Pi de-duplicates by canonical path; first (highest-precedence) root wins.
        const data = this.readSmall(file)
        if (!data) continue
        const split = splitDocument(data.raw)
        const values = frontmatterValues(split.fmRaw)
        const string = (key: string): string | undefined => { const value = values.get(key); return typeof value === 'string' ? value : undefined }
        if (root.kind === 'skill' && basename(file) !== 'SKILL.md' && !(string('description') ?? '').trim()) continue // Pi ignores loose .md files without a description.
        seenPaths.add(real)
        const loadedEntry = loadedByPath[root.kind].get(real)
        const setting = settings[root.scope][root.kind === 'skill' ? 'skills' : 'prompts']
        const computedEnabled = isEnabledByOverrides(file, setting, root.baseDir)
        const symlinked = this.hasSymlinkBelow(root, file)
        const writable = root.managed && !symlinked
        const parsedName = root.kind === 'skill' ? (string('name') || basename(dirname(file))) : basename(file).replace(/\.md$/, '')
        let description = string('description') ?? ''
        if (root.kind === 'template' && !description) {
          const firstLine = split.rest.split('\n').find((line) => line.trim())
          description = firstLine ? `${firstLine.slice(0, 60)}${firstLine.length > 60 ? '...' : ''}` : ''
        }
        items.push({
          kind: root.kind, scope: root.scope, path: file, source: root.scope, sourceDetail: 'auto',
          name: loadedEntry?.name ?? parsedName,
          description: loadedEntry?.description ?? description,
          disableModelInvocation: values.get('disable-model-invocation') === true,
          ...(string('argument-hint') ? { argumentHint: string('argument-hint')!.slice(0, 2048) } : {}),
          root, writable,
          ...(writable ? {} : { readOnlyReason: !root.managed ? 'Outside the Pi directories this app edits (.agents skills are read-only here).' : 'Symlinked or system-provided; not edited through links.' }),
          loaded: loadedEntry !== undefined,
          enabled: computedEnabled,
        })
      }
    }
    // Loaded by Pi but not found in our discovery: packages, settings-listed paths, temporary sources. Read-only.
    for (const kind of ['skill', 'template'] as const) {
      for (const [real, entry] of loadedByPath[kind]) {
        if (seenPaths.has(real)) continue
        seenPaths.add(real)
        items.push({
          kind, scope: entry.scope, path: entry.path,
          source: entry.origin === 'package' ? 'package' : entry.scope, ...(entry.source ? { sourceDetail: entry.source } : {}),
          name: entry.name, description: entry.description ?? '', disableModelInvocation: false,
          writable: false,
          readOnlyReason: entry.origin === 'package' ? 'Provided by a Pi package; manage it with the package.' : 'Loaded from a path outside the Pi directories this app edits.',
          loaded: true, enabled: true,
        })
      }
    }
    // Name collisions: report which loaded resource wins when ours is not loaded.
    if (loaded.known) {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!
        if (item.loaded || !item.enabled) continue
        const winner = items.find((other) => other !== item && other.kind === item.kind && other.loaded && other.name === item.name)
        if (winner) items[index] = { ...item, shadowedBy: winner.path }
      }
    }
    return { items, cwd, roots, trusted }
  }

  // ---- item access

  private async readItem(kind: Kind, scope: PackageScope, path: string): Promise<{ item: Item; raw: string; revision: string }> {
    if (!isAbsolute(path)) throw new Error('A native resource path must be absolute.')
    const { items } = await this.collect()
    const item = items.find((candidate) => candidate.kind === kind && candidate.path === resolve(path) && candidate.scope === scope)
    if (!item) throw new Error('The requested resource is not a skill or prompt template Pi knows at this scope.')
    const data = this.readSmall(item.path)
    if (!data) throw new Error('The native resource file is invalid, not UTF-8, or too large.')
    return { item, raw: data.raw, revision: sha256(data.bytes) }
  }

  /** A writable item re-validated against the live filesystem: managed root, no symlinks, regular file. */
  private async findWritable(kind: Kind, scope: PackageScope, path: string): Promise<{ item: Item; raw: string; revision: string } | null> {
    if (!isAbsolute(path)) throw new Error('A native resource path must be absolute.')
    const target = resolve(path)
    const cwd = this.cwd()
    if (scope === 'project') {
      if (!cwd) throw new Error('Project resources need an active workspace.')
      if (!this.projectTrusted(cwd, false)) throw new Error('Project resource operations require the workspace to be trusted in Pi.')
    }
    const { items } = await this.collect()
    const item = items.find((candidate) => candidate.kind === kind && candidate.scope === scope && candidate.path === target)
    if (!item) {
      if (lstatOrNull(target) === null) return null
      throw new Error('Writes are limited to Pi-discoverable skill and prompt files in the user or project directories.')
    }
    if (!item.writable || !item.root) throw new Error(item.readOnlyReason ?? 'This resource is read-only.')
    const stat = lstatOrNull(target)
    if (!stat) return null
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The native resource must be a regular file.')
    const data = this.readNoFollow(target)
    return { item, raw: data.raw, revision: sha256(data.bytes) }
  }

  private readNoFollow(path: string): { raw: string; bytes: Buffer } {
    let descriptor: number | undefined
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = fstatSync(descriptor)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('The native resource file is invalid or too large.')
      const bytes = readFileSync(descriptor)
      return { raw: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), bytes }
    } finally { if (descriptor !== undefined) closeSync(descriptor) }
  }

  // ---- views

  private skillView(item: Item, raw: string): SkillDocumentView {
    const split = splitDocument(raw)
    return {
      path: item.path, source: item.source, scope: item.scope as ResourceListScope,
      ...(item.sourceDetail ? { sourceDetail: item.sourceDetail } : {}),
      kind: 'skill', name: (item.name || basename(dirname(item.path))).slice(0, 1024), description: item.description.slice(0, 8192),
      disableModelInvocation: item.disableModelInvocation,
      content: raw, body: split.fmRaw === null ? split.text : split.rest.trim(), revision: sha256(Buffer.from(raw, 'utf8')),
      loaded: item.loaded, enabled: item.enabled, writable: item.writable,
      ...(item.readOnlyReason ? { readOnlyReason: item.readOnlyReason } : {}),
      ...(item.shadowedBy ? { shadowedBy: item.shadowedBy } : {}),
      ...(split.fmRaw !== null ? { frontmatterRaw: split.fmRaw } : {}),
    }
  }

  private templateView(item: Item, raw: string): TemplateDocumentView {
    const split = splitDocument(raw)
    return {
      path: item.path, source: item.source, scope: item.scope as ResourceListScope,
      ...(item.sourceDetail ? { sourceDetail: item.sourceDetail } : {}),
      kind: 'template', name: (item.name || basename(item.path).replace(/\.md$/, '')).slice(0, 1024), description: item.description.slice(0, 8192),
      ...(item.argumentHint ? { argumentHint: item.argumentHint } : {}),
      content: raw, body: split.fmRaw === null ? split.text : split.rest.trim(), revision: sha256(Buffer.from(raw, 'utf8')),
      loaded: item.loaded, enabled: item.enabled, writable: item.writable,
      ...(item.readOnlyReason ? { readOnlyReason: item.readOnlyReason } : {}),
      ...(item.shadowedBy ? { shadowedBy: item.shadowedBy } : {}),
      ...(split.fmRaw !== null ? { frontmatterRaw: split.fmRaw } : {}),
    }
  }

  // ---- validation

  private validateSkillPatch(patch: Readonly<Record<string, unknown>>, found: { raw: string }): void {
    const current = frontmatterValues(splitDocument(found.raw).fmRaw)
    const next = new Map(current)
    for (const [key, value] of Object.entries(patch)) { if (value === null) next.delete(key); else next.set(key, value) }
    const description = next.get('description')
    // Pi does not load a skill whose description is missing/empty (core/skills.js:231-253) and warns above 1024 characters.
    if (typeof description !== 'string' || description.trim() === '' || description.length > 1024) throw new Error('Skill description must be non-empty and at most 1024 characters.')
    if (Object.hasOwn(patch, 'name') && patch.name !== null) {
      const name = patch.name
      if (typeof name !== 'string' || name.length > 64 || !SKILL_NAME.test(name)) throw new Error('Skill names must be lowercase letters, digits, and single hyphens, up to 64 characters.')
    }
    if (Object.hasOwn(patch, 'disable-model-invocation') && patch['disable-model-invocation'] !== null && typeof patch['disable-model-invocation'] !== 'boolean') {
      throw new Error('Skill disable-model-invocation must be a boolean.')
    }
  }

  private validateTemplateFrontmatter(frontmatter: Readonly<Record<string, unknown>>): void {
    for (const key of ['description', 'argument-hint']) {
      if (Object.hasOwn(frontmatter, key) && frontmatter[key] !== null && typeof frontmatter[key] !== 'string') throw new Error(`Prompt template ${key} must be a string.`)
    }
    const hint = frontmatter['argument-hint']
    if (typeof hint === 'string' && hint.length > 2048) throw new Error('Prompt template argument-hint is too long.')
    const description = frontmatter.description
    if (typeof description === 'string' && description.length > 8192) throw new Error('Prompt template description is too long.')
  }

  // ---- filesystem writes

  private assertRootChain(root: Root, ensure: boolean): void {
    // Every directory from the root's parent chain inside its base (e.g. ~/.pi/agent or <cwd>/.pi) up to the root must be a real directory.
    const base = resolve(root.baseDir)
    const chain = [base, resolve(root.dir)]
    for (const dir of chain) {
      const stat = lstatOrNull(dir)
      if (!stat) {
        if (!ensure) throw new Error('The resource directory does not exist.')
        mkdirSync(dir)
        continue
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Native resource directories must be real directories (no symlinks).')
    }
  }

  private ensureSubdirectory(root: Root, directory: string): void {
    if (!isWithin(root.dir, directory)) throw new Error('The resource path is outside its managed directory.')
    this.assertRootChain(root, true)
    let current = resolve(root.dir)
    for (const part of relative(current, directory).split(sep).filter(Boolean)) {
      current = join(current, part)
      const stat = lstatOrNull(current)
      if (!stat) { mkdirSync(current); continue }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Native resource directories must be real directories (no symlinks).')
    }
    const realRoot = realpathSync(root.dir)
    const realDir = realpathSync(directory)
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) throw new Error('The resource path escapes its managed directory.')
  }

  private writeTemp(path: string, content: string, mode: number): string {
    const temporary = join(dirname(path), `.${randomUUID()}.native-resource.tmp`)
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > MAX_FILE_BYTES) throw new Error('The resource file would be too large.')
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode)
      let offset = 0
      while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      return temporary
    } catch (error) {
      if (descriptor !== undefined) try { closeSync(descriptor) } catch { /* ignore */ }
      try { unlinkSync(temporary) } catch { /* ignore */ }
      throw error
    }
  }

  /** Returns false when the file already exists. */
  private createExclusive(root: Root, path: string, content: string): boolean {
    const target = resolve(path)
    if (!isWithin(root.dir, target) || target === resolve(root.dir)) throw new Error('The resource path is outside its managed directory.')
    this.ensureSubdirectory(root, dirname(target))
    if (lstatOrNull(target)) return false
    const temporary = this.writeTemp(target, content, 0o644)
    try {
      linkSync(temporary, target) // fails with EEXIST instead of replacing a concurrent file
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    } finally {
      try { unlinkSync(temporary) } catch { /* ignore */ }
    }
  }

  private replaceExisting(found: { item: Item; revision: string }, content: string): void {
    const target = found.item.path
    const root = found.item.root!
    this.assertRootChain(root, false)
    if (this.hasSymlinkBelow(root, target)) throw new Error('The native resource path contains a symlink.')
    const stat = lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The native resource must be a regular file.')
    const latest = this.readNoFollow(target)
    if (sha256(latest.bytes) !== found.revision) throw new Error('The native resource changed during the update.')
    const temporary = this.writeTemp(target, content, stat.mode & 0o777)
    try {
      renameSync(temporary, target)
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* ignore */ }
      throw error
    }
  }

  private removeExisting(found: { item: Item; revision: string }, removeEmptySkillDirectory: boolean): void {
    const target = found.item.path
    const root = found.item.root!
    this.assertRootChain(root, false)
    if (this.hasSymlinkBelow(root, target)) throw new Error('The native resource path contains a symlink.')
    const latest = this.readNoFollow(target)
    if (sha256(latest.bytes) !== found.revision) throw new Error('The native resource changed before it was deleted.')
    unlinkSync(target)
    if (removeEmptySkillDirectory && basename(target) === 'SKILL.md') {
      const directory = dirname(target)
      if (resolve(directory) !== resolve(root.dir)) {
        try { rmdirSync(directory) } catch { /* not empty or in use: leave it */ }
      }
    }
  }

  // ---- settings.json (native enable/disable)

  private readSettingsObject(path: string): { object: Record<string, unknown>; text: string | null; bytes: Buffer | null } {
    const stat = lstatOrNull(path)
    if (!stat) return { object: {}, text: null, bytes: null }
    if (stat.isSymbolicLink()) throw new Error('settings.json is a symlink; it is not edited through links.')
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error('settings.json is invalid or too large.')
    const bytes = readFileSync(path)
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('settings.json is not a JSON object.')
    return { object: parsed as Record<string, unknown>, text, bytes }
  }

  private settingsArrays(path: string): { skills: string[]; prompts: string[] } {
    try {
      const { object } = this.readSettingsObject(path)
      const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
      return { skills: strings(object.skills), prompts: strings(object.prompts) }
    } catch {
      return { skills: [], prompts: [] }
    }
  }

  private enableSkillCommands(): boolean {
    try {
      const user = this.readSettingsObject(join(this.agentDir, 'settings.json')).object.enableSkillCommands
      const cwd = this.cwd()
      const project = cwd && this.projectTrusted(cwd, false) ? this.readSettingsObject(join(cwd, '.pi', 'settings.json')).object.enableSkillCommands : undefined
      if (typeof project === 'boolean') return project
      return typeof user === 'boolean' ? user : true
    } catch { return true }
  }

  /**
   * Exactly Pi's own toggle (modes/interactive/components/config-selector.js:410-465 toggleTopLevelResource):
   * pattern = relative(baseDir, file); drop existing entries whose target (minus one leading ! + -) equals it; push `+pattern` or `-pattern`.
   */
  private async setEnabled(kind: Kind, scope: PackageScope, path: string, enabled: boolean): Promise<{ outcome: 'saved' | 'unchanged' | 'not-found'; path: string }> {
    if (!isAbsolute(path)) throw new Error('A native resource path must be absolute.')
    const target = resolve(path)
    const cwd = this.cwd()
    if (scope === 'project') {
      if (!cwd) throw new Error('Project resources need an active workspace.')
      if (!this.projectTrusted(cwd, false)) throw new Error('Project settings changes require the workspace to be trusted in Pi.')
    }
    const { items } = await this.collect()
    const item = items.find((candidate) => candidate.kind === kind && candidate.scope === scope && candidate.path === target)
    if (!item) return { outcome: 'not-found', path: target }
    if (!item.root) throw new Error(item.readOnlyReason ?? 'Package and externally loaded resources are filtered by their package entry, not here.')
    const key = kind === 'skill' ? 'skills' : 'prompts'
    const settingsPath = scope === 'user' ? join(this.agentDir, 'settings.json') : join(cwd!, '.pi', 'settings.json')
    const baseDir = item.root.baseDir
    const pattern = relative(baseDir, target)
    const state = this.settingsArrays(settingsPath)[key]
    if (isEnabledByOverrides(target, state, baseDir) === enabled) return { outcome: 'unchanged', path: target }
    const outcome = this.updateSettingsArray(settingsPath, key, scope === 'project' ? join(cwd!, '.pi') : this.agentDir, (current) => {
      const filtered = current.filter((entry) => {
        const stripped = entry.startsWith('!') || entry.startsWith('+') || entry.startsWith('-') ? entry.slice(1) : entry
        return stripped !== pattern
      })
      filtered.push(`${enabled ? '+' : '-'}${pattern}`)
      return filtered
    })
    return { outcome, path: target }
  }

  private updateSettingsArray(path: string, key: 'skills' | 'prompts', directory: string, mutate: (current: string[]) => string[]): 'saved' | 'unchanged' {
    const dirStat = lstatOrNull(directory)
    if (!dirStat) mkdirSync(directory)
    else if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('The settings directory must be a real directory.')
    const { object, text, bytes } = this.readSettingsObject(path)
    const existing = object[key]
    if (existing !== undefined && (!Array.isArray(existing) || !existing.every((entry) => typeof entry === 'string'))) {
      throw new Error(`settings.json "${key}" is not an array of strings; refusing to rewrite it.`)
    }
    const current = (existing as string[] | undefined) ?? []
    const next = mutate([...current])
    if (existing !== undefined && next.length === current.length && next.every((value, index) => value === current[index])) return 'unchanged'
    const updated: Record<string, unknown> = { ...object, [key]: next }
    const indent = text ? (/^[ \t]*\n?([ \t]+)"/m.exec(text)?.[1] ?? '  ') : '  '
    const output = `${JSON.stringify(updated, null, indent)}${text !== null && text.endsWith('\n') ? '\n' : ''}`
    if (Buffer.byteLength(output, 'utf8') > MAX_SETTINGS_BYTES) throw new Error('settings.json would be too large.')
    const mode = bytes ? lstatSync(path).mode & 0o777 : 0o644
    const temporary = this.writeTemp(path, output, mode)
    try {
      // Optimistic concurrency: refuse if settings.json changed since it was read (Pi may be saving concurrently).
      const latest = lstatOrNull(path) ? readFileSync(path) : null
      if ((bytes === null) !== (latest === null) || (bytes !== null && latest !== null && !bytes.equals(latest))) {
        throw new Error('settings.json changed on disk during the update; nothing was written. Try again.')
      }
      renameSync(temporary, path)
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* ignore */ }
      throw error
    }
    return 'saved'
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}

type ResourceListScope = 'user' | 'project' | 'temporary' | 'unknown'
