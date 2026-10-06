import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AgentDefinition,
  AgentDefinitionCreateRequest,
  AgentDefinitionEnableRequest,
  AgentDefinitionFields,
  AgentDefinitionListRequest,
  AgentDefinitionListResponse,
  AgentDefinitionMutationResponse,
  AgentDefinitionReadResponse,
  AgentDefinitionScope,
  AgentDefinitionUpdateRequest,
  AgentDefinitionValidationIssue,
  AgentDefinitionWriteScope,
} from '../../shared/agent-definitions.ts'
import {
  AGENT_DEFINITION_MAX_BYTES,
  AGENT_DEFINITION_FIELDS,
  parseAgentDefinitionFile,
  patchAgentDefinitionFile,
  serializeAgentDefinitionFile,
  validateAgentDefinitionName,
} from './definition-files.ts'
import { ScopedSettingsService } from '../config/settings-service.ts'

export interface TintinwebDefinitionsOptions {
  readonly agentDir: string
  /** Active workspace root; omit when no workspace is active (project scopes are then unavailable). */
  readonly cwd?: string
  readonly isProjectTrusted: () => boolean
}

interface RawDefinition {
  readonly scope: AgentDefinitionScope
  readonly fileName: string
  readonly content: string
  readonly revision: number
}

type NativeDefinitionScope = Extract<AgentDefinitionScope, 'user' | 'project' | 'workspace'>

interface DecodedId {
  readonly scope: NativeDefinitionScope
  readonly fileName: string
}

const MAX_FILES_PER_ROOT = 1000
const SCOPE_ORDER: Readonly<Record<AgentDefinitionScope, number>> = { user: 0, workspace: 1, project: 2, bundled: 3 }
const BASE64URL = /^[A-Za-z0-9_-]{1,392}$/
const FILE_NAME = /^[^/\\\0]{1,255}\.md$/
const UNSAFE_COMPONENT = /^(?:\.|\.\.|constructor|prototype|__proto__)$/
const SETTINGS_SCOPE = { user: 'user', project: 'project' } as const

function revisionFor(content: string | undefined): number {
  if (content === undefined) return 0
  return Number.parseInt(createHash('sha256').update(content).digest('hex').slice(0, 12), 16)
}

function isSafeFileName(fileName: string): boolean {
  return FILE_NAME.test(fileName)
    && fileName !== '.md'
    && Buffer.byteLength(fileName, 'utf8') <= 255
    && !fileName.includes('\0')
    && !fileName.split(/[\\/]/).some((part) => UNSAFE_COMPONENT.test(part))
}

function idFor(scope: AgentDefinitionScope, fileName: string): string {
  return `${scope}~${Buffer.from(fileName, 'utf8').toString('base64url')}`
}

function decodeId(id: string): DecodedId | null {
  const separator = id.indexOf('~')
  if (separator < 1 || !BASE64URL.test(id.slice(separator + 1))) return null
  const scope = id.slice(0, separator)
  if (scope !== 'user' && scope !== 'project' && scope !== 'workspace') return null
  try {
    const fileName = Buffer.from(id.slice(separator + 1), 'base64url').toString('utf8')
    if (!isSafeFileName(fileName) || idFor(scope, fileName) !== id) return null
    return { scope, fileName }
  } catch {
    return null
  }
}

function issue(
  code: AgentDefinitionValidationIssue['code'],
  message: string,
  field?: string,
): AgentDefinitionValidationIssue {
  return { code, message, ...(field ? { field } : {}) }
}

function orderedNewFrontmatter(fields: AgentDefinitionFields): Record<string, unknown> {
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const values = fields as unknown as Readonly<Record<string, unknown>>
  for (const key of AGENT_DEFINITION_FIELDS) {
    if (!Object.hasOwn(fields, key)) continue
    Object.defineProperty(output, key, {
      value: values[key], enumerable: true, writable: true, configurable: true,
    })
  }
  if (!Object.hasOwn(output, 'prompt_mode')) output.prompt_mode = 'replace'
  return output
}

function safeDirectory(root: string, pathParts: readonly string[], create: boolean): string {
  const absoluteRoot = resolve(root)
  if (create && !existsSync(absoluteRoot)) mkdirSync(absoluteRoot, { recursive: true, mode: 0o700 })
  let current = absoluteRoot
  for (const part of pathParts) {
    if (!part || UNSAFE_COMPONENT.test(part) || part.includes('\0') || part.includes('/') || part.includes('\\')) {
      throw new TypeError('Agent definition path contains an unsafe component.')
    }
    current = join(current, part)
    try {
      const details = lstatSync(current)
      if (details.isSymbolicLink()) throw new TypeError('Agent definition paths may not follow symbolic links.')
      if (!details.isDirectory()) throw new TypeError('An agent definition parent is not a directory.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error
      mkdirSync(current, { mode: 0o700 })
    }
  }
  const rel = relative(absoluteRoot, current)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError('Agent definition path escapes its configured root.')
  }
  return current
}

function atomicWrite(path: string, content: string, createOnly = false): void {
  if (Buffer.byteLength(content, 'utf8') > AGENT_DEFINITION_MAX_BYTES) {
    throw new TypeError('Agent definition exceeds the size limit.')
  }
  const directory = dirname(path)
  const temporary = join(directory, `.${randomUUID()}.agent-definition.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    if (createOnly) {
      linkSync(temporary, path)
      unlinkSync(temporary)
    } else {
      renameSync(temporary, path)
    }
    try {
      const directoryDescriptor = openSync(directory, 'r')
      try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
    } catch {
      // Directory fsync is not available on every platform.
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

export class TintinwebDefinitions {
  private readonly agentDir: string
  private readonly cwd: string | undefined
  private readonly persistence: ScopedSettingsService

  constructor(private readonly options: TintinwebDefinitionsOptions) {
    if (!isAbsolute(options.agentDir) || (options.cwd !== undefined && !isAbsolute(options.cwd))) {
      throw new TypeError('Agent definition roots must be absolute paths.')
    }
    this.agentDir = resolve(options.agentDir)
    this.cwd = options.cwd === undefined ? undefined : resolve(options.cwd)
    this.persistence = new ScopedSettingsService({ user: this.agentDir, ...(this.cwd ? { project: this.cwd } : {}) })
  }

  list(request: AgentDefinitionListRequest = {}): AgentDefinitionListResponse {
    const projectAvailable = this.projectIsTrusted()
    const scopes: readonly AgentDefinitionScope[] = request.scope === 'user'
      ? ['user']
      : request.scope === 'project'
        ? ['project']
      : request.scope === 'workspace'
        ? ['workspace']
        : request.scope === 'bundled'
          ? []
          : projectAvailable ? ['user', 'workspace', 'project'] : ['user']
    if (!projectAvailable && scopes.some((scope) => scope !== 'user')) return { definitions: [], projectAvailable: false }

    const all = this.readNativeOrder()
    const winnerIndex = new Map<string, number>()
    all.forEach((raw, index) => {
      const parsed = parseAgentDefinitionFile(raw.content, raw.fileName)
      if (parsed.validationIssues.length === 0) winnerIndex.set(parsed.name, index)
    })

    const definitions = all
      .map((raw, index) => {
        const parsed = parseAgentDefinitionFile(raw.content, raw.fileName)
        return this.makeDefinition(raw, parsed.validationIssues.length === 0 && winnerIndex.get(parsed.name) !== index)
      })
      .filter((definition) => scopes.includes(definition.scope))
      .sort((left, right) => SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope]
        || left.name.localeCompare(right.name)
        || left.fileName.localeCompare(right.fileName))
      .slice(0, 500)
    return { definitions, projectAvailable }
  }

  read(id: string): AgentDefinitionReadResponse {
    const decoded = decodeId(id)
    if (!decoded) return { definition: null, projectAvailable: this.projectIsTrusted(), validationIssues: [] }
    const projectAvailable = this.projectIsTrusted()
    if (decoded.scope !== 'user' && !projectAvailable) return { definition: null, projectAvailable: false, validationIssues: [] }
    const definition = this.list({ scope: decoded.scope }).definitions.find((candidate) => candidate.id === id) ?? null
    return { definition, projectAvailable, validationIssues: definition?.validationIssues ?? [] }
  }

  create(request: AgentDefinitionCreateRequest): AgentDefinitionMutationResponse {
    if (request.scope === 'project' && !this.projectIsTrusted()) return this.unavailable()
    if (request.expectedRevision !== 0) return this.invalid([issue('invalid-fields', 'A new definition must use revision 0.', 'expectedRevision')])
    const name = request.fields.name
    const issues = [
      ...(!name.trim() ? [issue('invalid-name', 'A non-empty name is required to create an agent definition.', 'name')] : []),
      ...validateAgentDefinitionName(name),
    ]
    if (issues.length) return this.invalid(issues)
    if (this.hasNameInScope(request.scope, name)) return this.invalid([issue('duplicate-name', 'An agent with this name already exists in the selected scope.', 'name')])

    const fileName = this.uniqueFileName(request.scope, name)
    const target = this.targetPath(request.scope, fileName, true)
    if (existsSync(target)) {
      const current = this.readRaw(request.scope, fileName)
      return this.conflict(current ? this.makeDefinition(current, false) : null, current?.revision ?? null)
    }
    const frontmatter = orderedNewFrontmatter(request.fields)
    let content: string
    try {
      content = serializeAgentDefinitionFile(frontmatter, request.prompt)
    } catch {
      return this.invalid([issue('invalid-fields', 'Definition fields could not be safely serialized as native YAML.')])
    }
    try {
      atomicWrite(target, content, true)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const current = this.readRaw(request.scope, fileName)
        return this.conflict(current ? this.makeDefinition(current, false) : null, current?.revision ?? null)
      }
      throw error
    }
    const definition = this.read(idFor(request.scope, fileName)).definition
    return { status: 'saved', definition, currentRevision: definition?.revision ?? revisionFor(content), validationIssues: [] }
  }

  update(request: AgentDefinitionUpdateRequest): AgentDefinitionMutationResponse {
    const target = this.resolveMutationTarget(request.id)
    if (!target) return this.notFound()
    if (target.scope !== 'user' && !this.projectIsTrusted()) return this.unavailable()
    if (target.scope === 'workspace') return this.readOnly(request.id)
    const current = this.readRaw(target.scope, target.fileName)
    if (!current) return this.notFound()
    if (current.revision !== request.expectedRevision) return this.conflict(this.read(request.id).definition, current.revision)

    const parsed = parseAgentDefinitionFile(current.content, current.fileName)
    if (parsed.validationIssues.length) return this.invalid(parsed.validationIssues, this.makeDefinition(current, false))
    const proposedName = Object.hasOwn(request.fields, 'name')
      ? (request.fields.name?.trim() ? request.fields.name : current.fileName.replace(/\.md$/i, ''))
      : (request.clearFields?.includes('name') ? current.fileName.replace(/\.md$/i, '') : undefined)
    const issues = proposedName === undefined ? [] : [...validateAgentDefinitionName(proposedName)]
    if (issues.length) return this.invalid(issues, this.makeDefinition(current, false))
    if (proposedName && this.hasNameInScope(target.scope, proposedName, request.id)) {
      return this.invalid([issue('duplicate-name', 'An agent with this name already exists in the selected scope.', 'name')], this.makeDefinition(current, false))
    }

    let serialized: string
    try {
      // Line-wise edit: untouched keys, comments, ordering, line endings and (unless edited) the body stay byte-identical.
      serialized = patchAgentDefinitionFile(
        current.content,
        request.fields as unknown as Readonly<Record<string, unknown>>,
        request.clearFields ?? [],
        request.prompt,
      )
    } catch {
      return this.invalid([issue('invalid-fields', 'Updated frontmatter contains a value that cannot be written as native YAML.')], this.makeDefinition(current, false))
    }
    if (current.revision !== revisionFor(this.readText(target.scope, target.fileName))) {
      const changed = this.readRaw(target.scope, target.fileName)
      return this.conflict(changed ? this.read(request.id).definition : null, changed?.revision ?? null)
    }
    atomicWrite(this.targetPath(target.scope, target.fileName, false), serialized)
    const definition = this.read(request.id).definition
    return { status: 'saved', definition, currentRevision: definition?.revision ?? revisionFor(serialized), validationIssues: [] }
  }

  delete(id: string, expectedRevision: number): AgentDefinitionMutationResponse {
    const target = this.resolveMutationTarget(id)
    if (!target) return this.notFound()
    if (target.scope !== 'user' && !this.projectIsTrusted()) return this.unavailable()
    if (target.scope === 'workspace') return this.readOnly(id)
    const current = this.readRaw(target.scope, target.fileName)
    if (!current) return this.notFound()
    if (current.revision !== expectedRevision) return this.conflict(this.read(id).definition, current.revision)
    const path = this.targetPath(target.scope, target.fileName, false)
    const latest = this.readText(target.scope, target.fileName)
    if (revisionFor(latest) !== expectedRevision) {
      const changed = this.readRaw(target.scope, target.fileName)
      return this.conflict(changed ? this.read(id).definition : null, changed?.revision ?? null)
    }
    unlinkSync(path)
    return { status: 'saved', definition: null, currentRevision: null, validationIssues: [] }
  }

  setEnabled(request: AgentDefinitionEnableRequest): AgentDefinitionMutationResponse {
    const target = this.resolveMutationTarget(request.id)
    if (!target) return this.notFound()
    if (target.scope !== 'user' && !this.projectIsTrusted()) return this.unavailable()
    if (target.scope === 'workspace') return this.readOnly(request.id)
    const current = this.readRaw(target.scope, target.fileName)
    if (!current) return this.notFound()
    if (current.revision !== request.expectedRevision) return this.conflict(this.read(request.id).definition, current.revision)
    const parsed = parseAgentDefinitionFile(current.content, current.fileName)
    if (parsed.validationIssues.length) return this.invalid(parsed.validationIssues, this.makeDefinition(current, false))
    if (!parsed.hasFrontmatter) {
      return this.invalid([issue('missing-frontmatter', 'Native pi-subagents cannot toggle an existing definition without frontmatter.')], this.makeDefinition(current, false))
    }
    if (parsed.enabled === request.enabled) {
      const definition = this.read(request.id).definition
      return { status: 'saved', definition, currentRevision: current.revision, validationIssues: [] }
    }

    // Native disable is the `enabled: false` frontmatter flag (agent-file-toggle.ts); enabling removes the key.
    try {
      const updated = request.enabled
        ? patchAgentDefinitionFile(current.content, {}, ['enabled'])
        : patchAgentDefinitionFile(current.content, { enabled: false })
      if (this.readRaw(target.scope, target.fileName)?.revision !== request.expectedRevision) {
        const changed = this.readRaw(target.scope, target.fileName)
        return this.conflict(changed ? this.read(request.id).definition : null, changed?.revision ?? null)
      }
      atomicWrite(this.targetPath(target.scope, target.fileName, false), updated)
    } catch {
      return this.invalid([issue('invalid-frontmatter', 'The definition could not be safely updated.')], this.makeDefinition(current, false))
    }
    const definition = this.read(request.id).definition
    return { status: 'saved', definition, currentRevision: definition?.revision ?? null, validationIssues: [] }
  }

  private projectIsTrusted(): boolean {
    if (!this.cwd) return false
    try { return this.options.isProjectTrusted() === true } catch { return false }
  }

  private readNativeOrder(): RawDefinition[] {
    const records: RawDefinition[] = []
    const locations: readonly AgentDefinitionScope[] = ['user', 'workspace', 'project']
    for (const scope of locations) {
      if (scope !== 'user' && !this.projectIsTrusted()) continue
      let snapshots
      try {
        snapshots = this.persistence.listMarkdown(
          scope === 'user' ? 'user' : 'project',
          scope === 'user' ? 'agents' : scope === 'project' ? '.pi/agents' : '.agents/agents',
        )
      } catch {
        continue
      }
      for (const snapshot of snapshots.slice(0, MAX_FILES_PER_ROOT)) {
        const fileName = snapshot.path.split('/').at(-1) ?? ''
        if (!isSafeFileName(fileName)) continue
        const raw = this.readRaw(scope, fileName)
        if (raw) records.push(raw)
      }
    }
    return records
  }

  private readRaw(scope: AgentDefinitionScope, fileName: string): RawDefinition | null {
    if (!isSafeFileName(fileName) || (scope !== 'user' && !this.projectIsTrusted())) return null
    let content: string
    try {
      const path = this.targetPath(scope, fileName, false)
      const settingsScope = scope === 'user' ? SETTINGS_SCOPE.user : SETTINGS_SCOPE.project
      const relativeFilePath = this.relativePath(scope, fileName)
      const metadata = this.persistence.readFrontmatter(settingsScope, relativeFilePath)
      if (!metadata.exists) return null
      const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const details = fstatSync(descriptor)
        if (!details.isFile() || details.size > AGENT_DEFINITION_MAX_BYTES) return null
        content = readFileSync(descriptor, 'utf8')
      } finally {
        closeSync(descriptor)
      }
      const revision = revisionFor(content)
      if (revision !== metadata.revision) return null
      return { scope, fileName, content, revision }
    } catch {
      return null
    }
  }

  private readText(scope: AgentDefinitionScope, fileName: string): string | undefined {
    const raw = this.readRaw(scope, fileName)
    return raw?.content
  }

  private relativePath(scope: AgentDefinitionScope, fileName: string): string {
    return scope === 'user' ? `agents/${fileName}` : scope === 'project' ? `.pi/agents/${fileName}` : `.agents/agents/${fileName}`
  }

  private targetPath(scope: AgentDefinitionScope, fileName: string, createParents: boolean): string {
    if (!isSafeFileName(fileName)) throw new TypeError('Agent definition filename is invalid.')
    const root = scope === 'user' ? this.agentDir : this.cwd
    if (!root) throw new TypeError('Project definitions need an active workspace.')
    const parts = scope === 'user' ? ['agents'] : scope === 'project' ? ['.pi', 'agents'] : ['.agents', 'agents']
    const directory = safeDirectory(root, parts, createParents)
    const target = join(directory, fileName)
    const rel = relative(resolve(root), target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError('Agent definition path escapes its root.')
    try {
      const details = lstatSync(target)
      if (details.isSymbolicLink() || !details.isFile()) throw new TypeError('Agent definition target is not a regular file.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return target
  }

  private makeDefinition(raw: RawDefinition, shadowed: boolean): AgentDefinition {
    const parsed = parseAgentDefinitionFile(raw.content, raw.fileName)
    return {
      id: idFor(raw.scope, raw.fileName),
      name: parsed.name.slice(0, 256) || raw.fileName.replace(/\.md$/i, ''),
      fileName: raw.fileName,
      scope: raw.scope,
      provenance: raw.scope,
      shadowed,
      revision: raw.revision,
      fields: parsed.fields,
      prompt: parsed.prompt.slice(0, 512_000),
      enabled: parsed.enabled,
      valid: parsed.validationIssues.length === 0,
      validationIssues: parsed.validationIssues,
    }
  }

  private resolveMutationTarget(id: string): DecodedId | null {
    return decodeId(id)
  }

  private readOnly(id: string): AgentDefinitionMutationResponse {
    const definition = this.read(id).definition
    return this.mutation('read-only', definition, definition?.revision ?? null)
  }

  private hasNameInScope(scope: AgentDefinitionWriteScope, name: string, excludeId?: string): boolean {
    const definitions = this.readNativeOrder()
    return definitions.some((raw) => {
      if (raw.scope !== scope || idFor(raw.scope, raw.fileName) === excludeId) return false
      const parsed = parseAgentDefinitionFile(raw.content, raw.fileName)
      return parsed.validationIssues.length === 0 && parsed.name.toLowerCase() === name.trim().toLowerCase()
    })
  }

  private uniqueFileName(scope: AgentDefinitionWriteScope, name: string): string {
    const base = name.trim().toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 100) || 'agent'
    let candidate = `${base}.md`
    let suffix = 2
    while (this.readRaw(scope, candidate)) {
      candidate = `${base.slice(0, 94)}-${suffix}.md`
      suffix += 1
    }
    return candidate
  }

  private mutation(
    status: AgentDefinitionMutationResponse['status'],
    definition: AgentDefinition | null = null,
    currentRevision: number | null = definition?.revision ?? null,
    validationIssues: readonly AgentDefinitionValidationIssue[] = [],
  ): AgentDefinitionMutationResponse {
    return { status, definition, currentRevision, validationIssues }
  }

  private invalid(issues: readonly AgentDefinitionValidationIssue[], definition: AgentDefinition | null = null): AgentDefinitionMutationResponse {
    return this.mutation('invalid', definition, definition?.revision ?? null, issues)
  }

  private conflict(definition: AgentDefinition | null, currentRevision?: number | null): AgentDefinitionMutationResponse {
    return this.mutation('conflict', definition, currentRevision === undefined ? definition?.revision ?? null : currentRevision)
  }

  private notFound(): AgentDefinitionMutationResponse {
    return this.mutation('not-found')
  }

  private unavailable(): AgentDefinitionMutationResponse {
    return this.mutation('unavailable', null, null, [issue('invalid-fields', 'Project definitions are unavailable until the project is trusted.', 'scope')])
  }
}
