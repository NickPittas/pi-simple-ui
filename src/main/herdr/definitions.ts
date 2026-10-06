import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { validateHerdrDefinition } from './settings.ts'
import type { HerdrSettingsScope, HerdrSettingsValidationIssue } from '../../shared/herdr-settings.ts'
import type {
  AgentDefinition,
  AgentDefinitionCreateRequest,
  AgentDefinitionDeleteRequest,
  AgentDefinitionEnableRequest,
  AgentDefinitionFields,
  AgentDefinitionListRequest,
  AgentDefinitionListResponse,
  AgentDefinitionMutationResponse,
  AgentDefinitionReadResponse,
  AgentDefinitionUpdateRequest,
  AgentDefinitionValidationIssue,
} from '../../shared/agent-definitions.ts'
import type { AgentDefinitionProviderService } from '../ipc/agent-definitions.ts'

export const HERDR_DEFINITION_KINDS = ['agent', 'task', 'role'] as const
export type HerdrDefinitionKind = (typeof HERDR_DEFINITION_KINDS)[number]
export type HerdrDefinitionScope = HerdrSettingsScope | 'bundled'

/** Keys consumed by pi-herdr-agents 2.0.5's role parser. Unknown keys are retained verbatim. */
export const HERDR_NATIVE_AGENT_FIELDS = Object.freeze([
  'name', 'description', 'model', 'tools', 'system-prompt', 'skills', 'skill', 'thinking',
  'deny-tools', 'spawning', 'persistent', 'auto-exit', 'interactive', 'session-mode', 'cwd',
  'disable-model-invocation',
] as const)

export interface HerdrDefinition {
  readonly id: string
  readonly name: string
  readonly fileName: string
  readonly kind: HerdrDefinitionKind
  readonly scope: HerdrDefinitionScope
  readonly provenance: HerdrDefinitionScope
  readonly path: string
  readonly revision: number
  readonly fields: Readonly<Record<string, string>>
  /** Empty for task markdown: pi-herdr-agents 2.0.5 has no native task-file parser. */
  readonly nativeFields: readonly string[]
  readonly prompt: string
  /** Exact file text, including unknown frontmatter fields/comments, for faithful round-trip editing. */
  readonly content: string
  readonly hasFrontmatter: boolean
  readonly enabled: boolean
  /** Herdr-native model invocation for agents/roles; tasks have app-dispatch-only semantics. */
  readonly disableSemantics: 'native-model-invocation' | 'app-dispatch-only'
  readonly shadowed: boolean
  readonly valid: boolean
  readonly validationIssues: readonly HerdrSettingsValidationIssue[]
  readonly editable: boolean
}

export interface HerdrDefinitionStoreOptions {
  /** `$PI_CODING_AGENT_DIR` (normally `~/.pi/agent`). */
  readonly userRoot: string
  /** The active project root, supplied only for a trusted project. */
  readonly projectRoot?: string
  /** Must be explicit; project files are never exposed or mutated for untrusted workspaces. */
  readonly projectTrusted?: boolean
  /** Package root; package definitions are discoverable but never mutated. */
  readonly bundledRoot?: string
  /** Additional installed role-pack package roots, each containing a `roles/` markdown directory. */
  readonly rolePackRoots?: readonly string[]
}

export interface HerdrDefinitionListRequest {
  readonly kind?: HerdrDefinitionKind
  readonly scope?: HerdrDefinitionScope | 'all'
}

export interface HerdrDefinitionReadRequest { readonly id: string }
export interface HerdrDefinitionCreateRequest {
  readonly kind: HerdrDefinitionKind
  readonly scope: HerdrSettingsScope
  readonly name: string
  readonly expectedRevision: number
  readonly fields: Readonly<Record<string, string>>
  readonly prompt: string
}
export interface HerdrDefinitionUpdateRequest {
  readonly id: string
  readonly expectedRevision: number
  readonly fields?: Readonly<Record<string, string>>
  readonly clearFields?: readonly string[]
  readonly prompt?: string
}
export interface HerdrDefinitionDeleteRequest { readonly id: string; readonly expectedRevision: number }
export interface HerdrDefinitionEnableRequest { readonly id: string; readonly expectedRevision: number; readonly enabled: boolean }

export interface HerdrDefinitionMutationResult {
  readonly outcome: 'saved' | 'conflict' | 'not-found' | 'read-only' | 'unavailable' | 'invalid'
  readonly definition: HerdrDefinition | null
  readonly currentRevision: number | null
  readonly validationIssues: readonly HerdrSettingsValidationIssue[]
}

const MAX_BYTES = 1024 * 1024
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FRONTMATTER_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const UNSAFE_PART = /^(?:\.|\.\.|constructor|prototype|__proto__)$/
const SENSITIVE_KEY = /(?:secret|token|credential|password|api.?key|authorization|private.?key|access.?key)/i
const PRECEDENCE: Readonly<Record<HerdrDefinitionScope, number>> = { bundled: 0, user: 1, project: 2 }
const DEFAULT_DIR: Readonly<Record<HerdrDefinitionKind, string>> = { agent: 'agents', task: 'tasks', role: 'agents' }
const NATIVE_FIELDS_BY_KIND: Readonly<Record<HerdrDefinitionKind, readonly string[]>> = {
  agent: HERDR_NATIVE_AGENT_FIELDS,
  task: [],
  role: HERDR_NATIVE_AGENT_FIELDS,
}

function revision(contents: string | undefined): number {
  if (contents === undefined) return 0
  return Number.parseInt(createHash('sha256').update(contents).digest('hex').slice(0, 12), 16)
}

function issue(path: string, message: string, severity: 'warning' | 'error' = 'error'): HerdrSettingsValidationIssue {
  return { path, message, severity }
}

function hasErrors(issues: readonly HerdrSettingsValidationIssue[]): boolean {
  return issues.some((entry) => entry.severity === 'error')
}

function parseContent(content: string, fileName: string, kind: HerdrDefinitionKind): {
  hasFrontmatter: boolean
  fields: Record<string, string>
  prompt: string
  name: string
  issues: HerdrSettingsValidationIssue[]
} {
  // Match Herdr's native parser: a frontmatter opener at byte zero, LF delimiters,
  // exact unindented `key:` declarations, and first declaration wins.
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) {
    return {
      hasFrontmatter: false,
      fields: Object.create(null) as Record<string, string>,
      prompt: content.trim(),
      name: fileName.replace(/\.md$/i, ''),
      issues: [issue('$', 'Definition must start with Herdr-compatible frontmatter.')],
    }
  }
  const fields: Record<string, string> = Object.create(null) as Record<string, string>
  for (const line of match[1].split('\n')) {
    const declaration = line.match(/^([A-Za-z0-9_-]+):(?:[ \t]*)(.*)$/)
    if (declaration && !Object.hasOwn(fields, declaration[1])) fields[declaration[1]] = declaration[2]
  }
  const name = fields.name?.trim() || fileName.replace(/\.md$/i, '')
  const issues: HerdrSettingsValidationIssue[] = kind === 'task'
    ? [issue('$', 'Task markdown is app-managed; pi-herdr-agents 2.0.5 has no native tasks/*.md parser.', 'warning')]
    : [...validateHerdrDefinition(fields)]
  if (kind !== 'task') {
    const cli = fields.cli?.trim()
    if (cli) issues.push(issue('cli', 'External CLI definitions are unsupported by pi-herdr-agents 2.0.5; native roles run through Pi.'))

    for (const field of ['tools', 'deny-tools', 'spawning', 'persistent'] as const) {
      const declarationLines = match[1].split('\n').filter((line) => {
        const key = line.trimStart().split(':', 1)[0]?.trim()
        return key === field || key === `'${field}'` || key === `"${field}"`
      })
      const canonical = declarationLines.filter((line) => line.startsWith(`${field}:`))
      if (declarationLines.length !== canonical.length) issues.push(issue(field, `Must use the native unquoted, unindented ${field}: key.`))
      if (canonical.length > 1) issues.push(issue(field, 'May be declared only once by the Herdr parser.'))
      if (field === 'tools' || field === 'deny-tools') {
        const value = fields[field]?.trim()
        if (value !== undefined && (!value || /^[\[{|>]/.test(value) || /[#"']/.test(value) || value.split(',').some((part) => !part.trim()))) {
          issues.push(issue(field, 'Must be a non-empty comma-separated scalar; YAML containers, comments and quotes are unsupported.'))
        }
      }
    }
  }
  if (!NAME.test(name)) issues.push(issue('name', 'Name must be 1–64 safe filename characters: letters, numbers, dot, underscore or hyphen.'))
  if (kind !== 'task') {
    // Installed pi-herdr-agents (index.ts discoverAgentCatalog) skips roles whose declared name differs from the
    // filename, and roles without a description.
    const fallback = fileName.replace(/\.md$/i, '')
    if (name !== fallback) issues.push(issue('name', `Herdr skips this role: declared name "${name}" must match the filename "${fallback}".`))
    if (!fields.description?.trim()) issues.push(issue('description', 'Herdr skips roles that do not declare a description.'))
  }
  return { hasFrontmatter: true, fields, prompt: content.slice(match[0].length).trim(), name, issues }
}

function safeRelativePath(root: string, path: string): string {
  const parts = path.split(/[\\/]+/)
  if (!path || isAbsolute(path) || path.includes('\0') || parts.some((part) => !part || UNSAFE_PART.test(part))) {
    throw new TypeError('Herdr definition path is invalid.')
  }
  const absoluteRoot = resolve(root)
  let cursor = absoluteRoot
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index])
    try {
      const stat = lstatSync(cursor)
      if (stat.isSymbolicLink()) throw new TypeError('Herdr definition paths may not follow symbolic links.')
      if (index < parts.length - 1 && !stat.isDirectory()) throw new TypeError('A Herdr definition parent is not a directory.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      break
    }
  }
  const target = resolve(absoluteRoot, ...parts)
  const rel = relative(absoluteRoot, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError('Herdr definition path escapes its scope root.')
  return target
}

function readSafeFile(path: string): string | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new TypeError('Herdr definition is not a regular file or exceeds the size limit.')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function atomicWrite(path: string, content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new TypeError('Herdr definition exceeds the size limit.')
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = join(dir, `.${randomUUID()}.definition.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    try {
      const dirFd = openSync(dir, 'r')
      try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
    } catch { /* Directory fsync is unavailable on some filesystems. */ }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

function renderScalar(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new TypeError('Herdr frontmatter values must be single-line scalars.')
  return value
}

function serializeNew(fields: Readonly<Record<string, string>>, prompt: string): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (!FRONTMATTER_KEY.test(key) || UNSAFE_PART.test(key)) throw new TypeError('Herdr frontmatter contains an unsafe key.')
    lines.push(`${key}: ${renderScalar(value)}`)
  }
  if (/[\0]/.test(prompt) || Buffer.byteLength(prompt, 'utf8') > MAX_BYTES) throw new TypeError('Herdr prompt is invalid or too large.')
  return `---\n${lines.join('\n')}\n---\n\n${prompt.trim()}\n`
}

function patchContent(oldContent: string, fields: Readonly<Record<string, string>>, clearFields: readonly string[], prompt?: string): string {
  for (const key of [...Object.keys(fields), ...clearFields]) {
    if (!FRONTMATTER_KEY.test(key) || UNSAFE_PART.test(key)) throw new TypeError('Herdr frontmatter contains an unsafe key.')
  }
  let content = oldContent
  const match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!match) content = `---\n---\n\n${content}`
  const current = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!current) throw new TypeError('Could not serialize Herdr frontmatter.')
  const lines = current[1].split('\n')
  const updates = new Map(Object.entries(fields).map(([key, value]) => [key, renderScalar(value)]))
  const removals = new Set(clearFields)
  const seen = new Set<string>()
  const next: string[] = []
  for (const line of lines) {
    const key = line.match(/^([A-Za-z0-9_-]+):/)?.[1]
    if (!key || (!updates.has(key) && !removals.has(key))) {
      next.push(line)
      continue
    }
    if (removals.has(key) || seen.has(key)) continue
    // Leave a line byte-identical when its value is unchanged (keeps spacing and trailing comments).
    next.push(line.slice(key.length + 1).trim() === updates.get(key)!.trim() ? line : `${key}: ${updates.get(key)}`)
    seen.add(key)
  }
  for (const [key, value] of updates) if (!seen.has(key)) next.push(`${key}: ${value}`)
  const rest = content.slice(current[0].length)
  const body = prompt === undefined || prompt.trim() === rest.trim() ? rest : `\n\n${prompt.trim()}\n`
  if (prompt !== undefined && (prompt.includes('\0') || Buffer.byteLength(prompt, 'utf8') > MAX_BYTES)) throw new TypeError('Herdr prompt is invalid or too large.')
  return `---\n${next.join('\n')}\n---${body}`
}

function idFor(kind: HerdrDefinitionKind, scope: HerdrDefinitionScope, fileName: string, pack = ''): string {
  return `${scope}~${kind}~${pack ? `${pack}~` : ''}${fileName}`
}

function parseId(id: string): { kind: HerdrDefinitionKind; scope: HerdrDefinitionScope; fileName: string; pack?: string } | undefined {
  const parts = id.split('~')
  if (parts.length < 3) return undefined
  const [scope, kind, ...tail] = parts
  const validScopes: readonly string[] = ['user', 'project', 'bundled']
  if (typeof scope !== 'string' || !validScopes.includes(scope)
    || typeof kind !== 'string' || !HERDR_DEFINITION_KINDS.includes(kind as HerdrDefinitionKind)) return undefined
  const fileName = tail.pop()
  if (!fileName) return undefined
  const pack = tail.join('~') || undefined
  if (!fileName.endsWith('.md') || !NAME.test(fileName.slice(0, -3))) return undefined
  if (pack !== undefined && (!/^role-pack-[1-9][0-9]*$/.test(pack) || scope !== 'bundled' || kind !== 'role')) return undefined
  return { scope: scope as HerdrDefinitionScope, kind: kind as HerdrDefinitionKind, fileName, ...(pack ? { pack } : {}) }
}

/** CRUD for the markdown files read by Herdr's role catalog; installed sources are never written. */
export class HerdrDefinitionStore {
  private readonly userRoot: string
  private readonly projectRoot?: string
  private readonly bundledRoot?: string
  private readonly rolePackRoots: readonly string[]

  constructor(options: HerdrDefinitionStoreOptions) {
    if (!isAbsolute(options.userRoot) || options.userRoot.includes('\0')) throw new TypeError('Herdr user root must be absolute.')
    if (options.projectRoot !== undefined && (!isAbsolute(options.projectRoot) || options.projectRoot.includes('\0'))) {
      throw new TypeError('Herdr project root must be absolute.')
    }
    this.userRoot = resolve(options.userRoot)
    this.projectRoot = options.projectTrusted === true && options.projectRoot ? resolve(options.projectRoot) : undefined
    this.bundledRoot = options.bundledRoot ? resolve(options.bundledRoot) : undefined
    this.rolePackRoots = (options.rolePackRoots ?? []).map((root) => {
      if (!isAbsolute(root) || root.includes('\0')) throw new TypeError('Herdr role-pack roots must be absolute.')
      return resolve(root)
    })
  }

  get projectAvailable(): boolean { return this.projectRoot !== undefined }

  list(request: HerdrDefinitionListRequest = {}): readonly HerdrDefinition[] {
    const records: HerdrDefinition[] = []
    const kinds = request.kind ? [request.kind] : HERDR_DEFINITION_KINDS
    for (const kind of kinds) {
      const scopes: HerdrDefinitionScope[] = request.scope === 'all' || request.scope === undefined
        ? ['bundled', 'user', 'project']
        : [request.scope]
      for (const scope of scopes) {
        if (scope === 'bundled') {
          if (this.bundledRoot && !((kind === 'agent' || kind === 'role') && !this.bundledRolesEnabled())) {
            records.push(...this.listRoot(kind, scope, this.bundledRoot, true))
          }
          if (kind === 'role') {
            this.rolePackRoots.forEach((root, index) => records.push(...this.listRoot(kind, scope, root, true, `role-pack-${index + 1}`)))
          }
        } else {
          const root = scope === 'user' ? this.userRoot : this.projectRoot
          if (root) records.push(...this.listRoot(kind, scope, root, false))
        }
      }
    }
    const bundledRoleNames = new Set(records
      .filter((item) => item.kind === 'role' && item.scope === 'bundled' && !parseId(item.id)?.pack)
      .map((item) => item.name))
    const rolePackCounts = new Map<string, number>()
    for (const item of records) {
      if (item.kind !== 'role' || item.scope !== 'bundled' || !parseId(item.id)?.pack) continue
      rolePackCounts.set(item.name, (rolePackCounts.get(item.name) ?? 0) + 1)
    }
    const winners = new Map<string, number>()
    for (const [index, item] of records.entries()) {
      const key = `${item.kind}:${item.name}`
      const isRolePack = item.kind === 'role' && item.scope === 'bundled' && !!parseId(item.id)?.pack
      if (isRolePack && (bundledRoleNames.has(item.name) || rolePackCounts.get(item.name) !== 1)) continue
      const previous = winners.get(key)
      const previousDefinition = previous === undefined ? undefined : records[previous]
      if (!previousDefinition || PRECEDENCE[item.scope] >= PRECEDENCE[previousDefinition.scope]) winners.set(key, index)
    }
    return records.map((item, index) => ({ ...item, shadowed: winners.get(`${item.kind}:${item.name}`) !== index }))
  }

  read(request: HerdrDefinitionReadRequest): HerdrDefinition | null {
    const parts = parseId(request.id)
    if (!parts) throw new TypeError('Herdr definition identifier is invalid.')
    if (parts.scope === 'project' && !this.projectRoot) return null
    const root = this.rootFor(parts.scope, parts.pack)
    if (!root) return null
    const path = this.relativeFilePath(parts.kind, parts.scope, parts.fileName, !!parts.pack)
    const absolute = safeRelativePath(root, path)
    const contents = readSafeFile(absolute)
    if (contents === undefined) return null
    const definition = this.makeDefinition(parts.kind, parts.scope, parts.fileName, path, contents, parts.pack)
    const listed = this.list({ kind: parts.kind, scope: 'all' }).find((candidate) => candidate.id === definition.id)
    if (listed) return listed
    if (parts.scope === 'bundled' && !parts.pack && (parts.kind === 'agent' || parts.kind === 'role') && !this.bundledRolesEnabled()) {
      return { ...definition, enabled: false }
    }
    return definition
  }

  create(request: HerdrDefinitionCreateRequest): HerdrDefinitionMutationResult {
    if (!NAME.test(request.name)) return this.result('invalid', null, null, [issue('name', 'Name must be a safe 1–64 character filename.')])
    const root = this.rootFor(request.scope)
    if (!root) return this.result('unavailable', null, null, [])
    const fields = { ...request.fields, name: request.name }
    const content = serializeNew(fields, request.prompt)
    const checked = parseContent(content, `${request.name}.md`, request.kind)
    if (hasErrors(checked.issues)) return this.result('invalid', null, 0, checked.issues)
    const path = this.relativeFilePath(request.kind, request.scope, `${request.name}.md`)
    const absolute = safeRelativePath(root, path)
    const existing = readSafeFile(absolute)
    if (revision(existing) !== request.expectedRevision || existing !== undefined) {
      const current = existing === undefined ? null : this.makeDefinition(request.kind, request.scope, `${request.name}.md`, path, existing)
      return this.result('conflict', current ? this.read({ id: current.id }) ?? current : null, revision(existing), [])
    }
    atomicWrite(absolute, content)
    const saved = this.makeDefinition(request.kind, request.scope, `${request.name}.md`, path, content)
    return this.result('saved', this.read({ id: saved.id }) ?? saved, revision(content), [])
  }

  update(request: HerdrDefinitionUpdateRequest): HerdrDefinitionMutationResult {
    const parts = parseId(request.id)
    if (!parts) throw new TypeError('Herdr definition identifier is invalid.')
    if (parts.scope === 'bundled') {
      const bundled = this.read(request)
      if (!bundled) return this.result('not-found', null, null, [])
      return this.writeBundledOverride(bundled, request)
    }
    if (parts.scope === 'project' && !this.projectRoot) return this.result('unavailable', null, null, [])
    const root = this.rootFor(parts.scope)
    if (!root) return this.result('unavailable', null, null, [])
    const path = this.relativeFilePath(parts.kind, parts.scope, parts.fileName)
    const absolute = safeRelativePath(root, path)
    const old = readSafeFile(absolute)
    if (old === undefined) return this.result('not-found', null, null, [])
    const oldRevision = revision(old)
    if (oldRevision !== request.expectedRevision) {
      const current = this.makeDefinition(parts.kind, parts.scope, parts.fileName, path, old)
      return this.result('conflict', this.read({ id: current.id }) ?? current, oldRevision, [])
    }
    const candidate = patchContent(old, request.fields ?? {}, request.clearFields ?? [], request.prompt)
    const checked = parseContent(candidate, parts.fileName, parts.kind)
    if (hasErrors(checked.issues)) {
      const current = this.makeDefinition(parts.kind, parts.scope, parts.fileName, path, old)
      return this.result('invalid', this.read({ id: current.id }) ?? current, oldRevision, checked.issues)
    }
    atomicWrite(absolute, candidate)
    const saved = this.makeDefinition(parts.kind, parts.scope, parts.fileName, path, candidate)
    return this.result('saved', this.read({ id: saved.id }) ?? saved, revision(candidate), [])
  }

  delete(request: HerdrDefinitionDeleteRequest): HerdrDefinitionMutationResult {
    const parts = parseId(request.id)
    if (!parts) throw new TypeError('Herdr definition identifier is invalid.')
    if (parts.scope === 'bundled') return this.result('read-only', this.read(request), this.read(request)?.revision ?? null, [])
    if (parts.scope === 'project' && !this.projectRoot) return this.result('unavailable', null, null, [])
    const root = this.rootFor(parts.scope)
    if (!root) return this.result('unavailable', null, null, [])
    const path = this.relativeFilePath(parts.kind, parts.scope, parts.fileName)
    const absolute = safeRelativePath(root, path)
    const old = readSafeFile(absolute)
    if (old === undefined) return this.result('not-found', null, null, [])
    const oldRevision = revision(old)
    const current = this.makeDefinition(parts.kind, parts.scope, parts.fileName, path, old)
    if (oldRevision !== request.expectedRevision) return this.result('conflict', current, oldRevision, [])
    const stat = lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError('Only regular scoped definition files may be deleted.')
    unlinkSync(absolute)
    return this.result('saved', null, 0, [])
  }

  enable(request: HerdrDefinitionEnableRequest): HerdrDefinitionMutationResult {
    const item = this.read({ id: request.id })
    if (!item) return this.result('not-found', null, null, [])
    const enabledField: Record<string, string> = {}
    if (item.kind === 'task') enabledField.enabled = request.enabled ? 'true' : 'false'
    else enabledField['disable-model-invocation'] = request.enabled ? 'false' : 'true'
    if (item.scope === 'bundled') return this.update({
      id: request.id,
      expectedRevision: request.expectedRevision,
      fields: enabledField,
    })
    return this.update({
      id: request.id,
      expectedRevision: request.expectedRevision,
      fields: enabledField,
    })
  }

  private writeBundledOverride(item: HerdrDefinition, request: HerdrDefinitionUpdateRequest): HerdrDefinitionMutationResult {
    const path = this.relativeFilePath(item.kind, 'user', item.fileName)
    const root = this.userRoot
    const absolute = safeRelativePath(root, path)
    const existing = readSafeFile(absolute)
    // The request revision is the bundled file's revision; a pre-existing override
    // is not silently overwritten and gets its own conflict revision instead.
    if (existing !== undefined) {
      const existingDefinition = this.makeDefinition(item.kind, 'user', item.fileName, path, existing)
      if (request.expectedRevision !== existingDefinition.revision) {
        return this.result('conflict', this.read({ id: existingDefinition.id }) ?? existingDefinition, existingDefinition.revision, [])
      }
      const candidate = patchContent(existing, request.fields ?? {}, request.clearFields ?? [], request.prompt)
      const checked = parseContent(candidate, item.fileName, item.kind)
      if (hasErrors(checked.issues)) return this.result('invalid', this.read({ id: existingDefinition.id }) ?? existingDefinition, existingDefinition.revision, checked.issues)
      atomicWrite(absolute, candidate)
      const saved = this.makeDefinition(item.kind, 'user', item.fileName, path, candidate)
      return this.result('saved', this.read({ id: saved.id }) ?? saved, revision(candidate), [])
    }
    const source = patchContent(item.content, request.fields ?? {}, request.clearFields ?? [], request.prompt)
    const checked = parseContent(source, item.fileName, item.kind)
    if (hasErrors(checked.issues)) return this.result('invalid', item, item.revision, checked.issues)
    if (request.expectedRevision !== item.revision) return this.result('conflict', item, item.revision, [])
    atomicWrite(absolute, source)
    const saved = this.makeDefinition(item.kind, 'user', item.fileName, path, source)
    return this.result('saved', this.read({ id: saved.id }) ?? saved, revision(source), [])
  }

  private listRoot(kind: HerdrDefinitionKind, scope: HerdrDefinitionScope, root: string, packageFiles: boolean, pack?: string): HerdrDefinition[] {
    const directory = this.directoryFor(kind, packageFiles, !!pack)
    const absoluteDirectory = safeRelativePath(root, directory)
    let entries: string[]
    try { entries = readdirSync(absoluteDirectory).filter((name) => name.endsWith('.md')).sort((a, b) => a.localeCompare(b)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const items: HerdrDefinition[] = []
    for (const fileName of entries) {
      if (!NAME.test(fileName.slice(0, -3))) continue
      const path = `${directory}/${fileName}`
      try {
        const content = readSafeFile(safeRelativePath(root, path))
        if (content !== undefined) items.push(this.makeDefinition(kind, scope, fileName, path, content, pack))
      } catch {
        // One unsafe or unreadable installed definition must not block other entries.
      }
    }
    return items
  }

  private makeDefinition(kind: HerdrDefinitionKind, scope: HerdrDefinitionScope, fileName: string, path: string, content: string, pack?: string): HerdrDefinition {
    const parsed = parseContent(content, fileName, kind)
    const metadata: Record<string, string> = Object.create(null) as Record<string, string>
    for (const [key, value] of Object.entries(parsed.fields)) {
      if (Object.keys(metadata).length < 256 && !SENSITIVE_KEY.test(key) && value.length <= 16_384) metadata[key] = value
    }
    const issues = parsed.issues.map((entry) => SENSITIVE_KEY.test(entry.path) ? issue('$', 'A sensitive frontmatter field is present and has been omitted.') : entry)
    if (pack && parsed.name !== fileName.replace(/\.md$/i, '')) issues.push(issue('name', 'A native role-pack definition name must match its filename.'))
    if (pack && !parsed.fields.description?.trim()) issues.push(issue('description', 'A native role-pack definition requires a description.'))
    return {
      id: idFor(kind, scope, fileName, pack),
      name: parsed.name,
      fileName,
      kind,
      scope,
      provenance: scope,
      path,
      revision: revision(content),
      fields: metadata,
      nativeFields: NATIVE_FIELDS_BY_KIND[kind],
      prompt: parsed.prompt,
      content,
      hasFrontmatter: parsed.hasFrontmatter,
      enabled: kind === 'task'
        ? parsed.fields.enabled?.toLowerCase() !== 'false'
        : parsed.fields['disable-model-invocation']?.toLowerCase() !== 'true',
      disableSemantics: kind === 'task' ? 'app-dispatch-only' : 'native-model-invocation',
      shadowed: false,
      valid: !hasErrors(issues),
      validationIssues: issues,
      // A bundled source is read-only but can be overridden in the user agent dir.
      editable: true,
    }
  }

  private directoryFor(kind: HerdrDefinitionKind, packageFiles: boolean, rolePack = false): string {
    if (kind === 'task') return 'tasks'
    // Herdr reads user/project roles from the same `agents` catalog. Bundled roles
    // also live in the package's `agents`, while installed role packs use `roles`.
    return packageFiles && rolePack && kind === 'role' ? 'roles' : DEFAULT_DIR[kind]
  }

  private relativeFilePath(kind: HerdrDefinitionKind, scope: HerdrDefinitionScope, fileName: string, packageFiles = false): string {
    if (!NAME.test(fileName.replace(/\.md$/i, '')) || !fileName.endsWith('.md')) throw new TypeError('Herdr definition filename is invalid.')
    const directory = scope === 'project' ? `.pi/${kind === 'task' ? 'tasks' : 'agents'}`
      : scope === 'user' ? (kind === 'task' ? 'tasks' : 'agents')
        : this.directoryFor(kind, packageFiles, packageFiles && kind === 'role')
    return `${directory}/${fileName}`
  }

  private rootFor(scope: HerdrDefinitionScope, pack?: string): string | undefined {
    if (scope === 'user') return this.userRoot
    if (scope === 'project') return this.projectRoot
    if (pack) {
      const index = Number(pack.replace('role-pack-', '')) - 1
      return Number.isInteger(index) && index >= 0 ? this.rolePackRoots[index] : undefined
    }
    return this.bundledRoot
  }

  /** Mirrors role-config.ts: durable user config wins, then config.json.example, default bundled=true. */
  private bundledRolesEnabled(): boolean {
    const userPath = safeRelativePath(this.userRoot, 'herdr-agents/config.json')
    let source = readSafeFile(userPath)
    if (source === undefined && this.bundledRoot) {
      source = readSafeFile(safeRelativePath(this.bundledRoot, 'config.json.example'))
    }
    if (source === undefined) return true
    let parsed: unknown
    try { parsed = JSON.parse(source) } catch { throw new TypeError('Native Herdr role configuration contains invalid JSON.') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Native Herdr role configuration root must be an object.')
    const config = parsed as Record<string, unknown>
    if (!Object.hasOwn(config, 'roles')) return true
    if (!config.roles || typeof config.roles !== 'object' || Array.isArray(config.roles)) throw new TypeError('Native Herdr roles configuration must be an object.')
    const roles = config.roles as Record<string, unknown>
    const unsupported = Object.keys(roles).filter((key) => key !== 'bundled')
    if (unsupported.length > 0) throw new TypeError(`Native Herdr roles configuration has unsupported key(s): ${unsupported.join(', ')}.`)
    if (!Object.hasOwn(roles, 'bundled')) return true
    if (typeof roles.bundled !== 'boolean') throw new TypeError('Native Herdr roles.bundled must be a boolean.')
    return roles.bundled
  }

  private result(outcome: HerdrDefinitionMutationResult['outcome'], definition: HerdrDefinition | null, currentRevision: number | null, validationIssues: readonly HerdrSettingsValidationIssue[]): HerdrDefinitionMutationResult {
    return { outcome, definition, currentRevision, validationIssues }
  }
}

const BOOLEAN_HERDR_FIELDS = new Set(['spawning', 'persistent', 'auto-exit', 'interactive', 'disable-model-invocation', 'enabled'])

function frontmatterFromFields(fields: AgentDefinitionFields, kind: HerdrDefinitionKind): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(fields)) {
    if (!HERDR_NATIVE_AGENT_FIELDS.includes(key as (typeof HERDR_NATIVE_AGENT_FIELDS)[number]) && !(kind === 'task' && key === 'enabled')) {
      throw new TypeError(`The Herdr provider does not support the ${key} field for ${kind} definitions.`)
    }
    if (typeof value === 'string') result[key] = value
    else if (typeof value === 'boolean') result[key] = String(value)
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) result[key] = value.join(', ')
    else throw new TypeError(`The Herdr ${key} field must be a scalar or string list.`)
  }
  return result
}

function commonFields(definition: HerdrDefinition): AgentDefinitionFields {
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(definition.fields)) {
    if (!HERDR_NATIVE_AGENT_FIELDS.includes(key as (typeof HERDR_NATIVE_AGENT_FIELDS)[number]) && !(definition.kind === 'task' && key === 'enabled')) continue
    if (value.length > (key === 'description' ? 4096 : 8192)) continue
    if (BOOLEAN_HERDR_FIELDS.has(key)) {
      if (value === 'true' || value === 'false') fields[key] = value === 'true'
      continue
    }
    fields[key] = value
  }
  return fields as AgentDefinitionFields
}

function commonIssues(issues: readonly HerdrSettingsValidationIssue[]): AgentDefinitionValidationIssue[] {
  return issues
    .filter((entry) => entry.severity === 'error')
    .map((entry) => ({
      code: entry.path === '$' && entry.message.includes('frontmatter') ? 'missing-frontmatter' : 'invalid-fields',
      message: entry.message,
      ...(entry.path !== '$' ? { field: entry.path } : {}),
    }))
}

function commonDefinition(definition: HerdrDefinition | null): AgentDefinition | null {
  if (!definition) return null
  return {
    id: definition.id,
    provider: 'herdr',
    kind: definition.kind,
    name: definition.name,
    fileName: definition.fileName,
    scope: definition.scope,
    provenance: definition.provenance,
    shadowed: definition.shadowed,
    revision: definition.revision,
    fields: commonFields(definition),
    prompt: definition.prompt,
    enabled: definition.enabled,
    valid: definition.valid,
    validationIssues: commonIssues(definition.validationIssues),
    path: definition.path,
    nativeFields: definition.nativeFields,
    disableSemantics: definition.disableSemantics,
    editable: definition.editable,
  }
}

function commonMutation(result: HerdrDefinitionMutationResult): AgentDefinitionMutationResponse {
  return {
    status: result.outcome,
    definition: commonDefinition(result.definition),
    currentRevision: result.currentRevision,
    validationIssues: commonIssues(result.validationIssues),
  }
}

function invalidMutation(error: unknown): AgentDefinitionMutationResponse {
  const message = error instanceof Error ? error.message : 'Herdr definition values are invalid.'
  return {
    status: 'invalid',
    definition: null,
    currentRevision: null,
    validationIssues: [{ code: 'invalid-fields', message: message.slice(0, 1024) }],
  }
}

/** Adapter used by the shared `agents.definitions.*` IPC router for provider `herdr`. */
export class HerdrAgentDefinitionProvider implements AgentDefinitionProviderService {
  constructor(private readonly store: HerdrDefinitionStore) {}

  list(request: AgentDefinitionListRequest): AgentDefinitionListResponse {
    if (request.scope === 'workspace') return { definitions: [], projectAvailable: this.store.projectAvailable }
    const definitions = this.store.list({
      ...(request.kind ? { kind: request.kind } : {}),
      ...(request.scope ? { scope: request.scope } : {}),
    }).map(commonDefinition).filter((item): item is AgentDefinition => item !== null)
    return { definitions, projectAvailable: this.store.projectAvailable }
  }

  read(id: string): AgentDefinitionReadResponse {
    try {
      const definition = commonDefinition(this.store.read({ id }))
      return {
        definition,
        projectAvailable: this.store.projectAvailable,
        validationIssues: definition?.validationIssues ?? [],
      }
    } catch {
      return { definition: null, projectAvailable: this.store.projectAvailable, validationIssues: [] }
    }
  }

  create(request: AgentDefinitionCreateRequest): AgentDefinitionMutationResponse {
    try {
      const kind = request.kind ?? 'agent'
      const fields = frontmatterFromFields(request.fields, kind)
      return commonMutation(this.store.create({
        kind,
        scope: request.scope,
        name: request.fields.name,
        expectedRevision: request.expectedRevision,
        fields,
        prompt: request.prompt,
      }))
    } catch (error) { return invalidMutation(error) }
  }

  update(request: AgentDefinitionUpdateRequest): AgentDefinitionMutationResponse {
    try {
      const parts = parseId(request.id)
      if (!parts) return invalidMutation(new TypeError('Herdr definition identifier is invalid.'))
      const fields = frontmatterFromFields(request.fields, parts.kind)
      return commonMutation(this.store.update({
        id: request.id,
        expectedRevision: request.expectedRevision,
        fields,
        clearFields: request.clearFields?.map(String),
        ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
      }))
    } catch (error) { return invalidMutation(error) }
  }

  delete(id: string, expectedRevision: number): AgentDefinitionMutationResponse {
    try { return commonMutation(this.store.delete({ id, expectedRevision })) }
    catch (error) { return invalidMutation(error) }
  }

  setEnabled(request: AgentDefinitionEnableRequest): AgentDefinitionMutationResponse {
    try { return commonMutation(this.store.enable(request)) }
    catch (error) { return invalidMutation(error) }
  }
}
