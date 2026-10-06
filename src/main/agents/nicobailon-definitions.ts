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
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isPlainRecord } from '../../shared/ipc-contracts.ts'
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
import { AGENT_DEFINITION_MAX_BYTES, parseAgentDefinitionFile } from './definition-files.ts'

export interface NicobailonDefinitionsOptions {
  readonly agentDir: string
  readonly cwd: string
  readonly isProjectTrusted: () => boolean
}

type SourceRoot = 'user' | 'legacy' | 'project'

interface RawDefinition {
  readonly scope: AgentDefinitionWriteScope
  readonly sourceRoot: SourceRoot
  readonly relativePath: string
  readonly content: string
  readonly revision: number
}

interface DecodedId {
  readonly scope: AgentDefinitionWriteScope
  readonly sourceRoot: SourceRoot
  readonly relativePath: string
}

interface ParsedDefinition {
  readonly name: string
  readonly runtimeName: string
  readonly fields: AgentDefinitionFields
  readonly frontmatter: Readonly<Record<string, unknown>>
  readonly prompt: string
  readonly hasFrontmatter: boolean
  readonly validationIssues: readonly AgentDefinitionValidationIssue[]
}

interface SettingsSnapshot {
  readonly path: string
  readonly content: string | undefined
  readonly revision: number
  readonly document: Record<string, unknown>
}

const MAX_FILES_PER_ROOT = 1000
const MAX_DEFINITIONS = 500
const MAX_NAME = 256
const MAX_PROMPT = 512_000
const MAX_DEPTH = 24
const SENSITIVE_KEY = /(?:secret|token|credential|password|api.?key|authorization|private.?key|access.?key)/i
const UNSAFE_COMPONENT = /^(?:\.|\.\.|constructor|prototype|__proto__)$/
const FRONTMATTER_KEY = /^[A-Za-z0-9_-]{1,128}$/
const NICOBAILON_FIELDS = new Set([
  'name', 'package', 'description', 'advertise', 'alias', 'aliases', 'tools', 'excludeTools',
  'allowNestedSubagents', 'allowedAgents', 'model', 'fast', 'thinking', 'systemPromptMode',
  'inheritProjectContext', 'inheritGlobalContext', 'inheritSkills', 'defaultContext', 'async',
  'timeoutMs', 'toolTimeoutMs', 'acceptance', 'acceptanceRole', 'skill', 'skills', 'skillPath',
  'extensions', 'subagentOnlyExtensions', 'mutationTools', 'machine', 'output', 'outputMode',
  'outputSchema', 'defaultReads', 'defaultProgress', 'interactive', 'maxSubagentDepth', 'toolBudget',
  'permission', 'permissions', 'memory', 'runner',
])
const LIST_FIELDS = new Set([
  'alias', 'aliases', 'tools', 'excludeTools', 'allowedAgents', 'skill', 'skills', 'skillPath', 'extensions',
  'subagentOnlyExtensions', 'mutationTools', 'defaultReads',
])
const BOOLEAN_FIELDS = new Set([
  'advertise', 'allowNestedSubagents', 'fast', 'inheritProjectContext', 'inheritGlobalContext',
  'inheritSkills', 'async', 'defaultProgress', 'interactive',
])
const OBJECT_FIELDS = new Set(['acceptance', 'memory', 'outputSchema', 'toolBudget', 'permission', 'permissions', 'runner'])
const SCOPE_ORDER: Readonly<Record<AgentDefinitionScope, number>> = { user: 0, workspace: 1, project: 2, bundled: 3 }

function revisionFor(content: string | undefined): number {
  if (content === undefined) return 0
  return Number.parseInt(createHash('sha256').update(content).digest('hex').slice(0, 12), 16)
}

function issue(
  code: AgentDefinitionValidationIssue['code'],
  message: string,
  field?: string,
): AgentDefinitionValidationIssue {
  return { code, message, ...(field ? { field } : {}) }
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return !value.includes('\0')
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 1024 && value.every((child) => isJsonValue(child, depth + 1))
  if (!isPlainRecord(value)) return false
  return Object.entries(value).length <= 1024
    && Object.entries(value).every(([key, child]) => !UNSAFE_COMPONENT.test(key) && isJsonValue(child, depth + 1))
}

function cloneFrontmatter(source: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(source)) {
    Object.defineProperty(copy, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return copy
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 256 && value.every((item) => typeof item === 'string')
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validNativeField(key: string, value: unknown): boolean {
  if (key === 'package') return value === false || (typeof value === 'string' && value.length <= 256)
  if (key === 'thinking') return value === false || (typeof value === 'string' && value.length <= 8192)
  if (key === 'outputSchema' || key === 'toolBudget') {
    if (isPlainRecord(value)) return isJsonValue(value)
    if (typeof value !== 'string') return false
    if (!value.trim()) return true
    try {
      const parsed: unknown = JSON.parse(value)
      return isPlainRecord(parsed) && isJsonValue(parsed)
    } catch {
      return false
    }
  }
  if (key === 'runner') {
    return typeof value === 'string' ? value.length <= 8192 : isPlainRecord(value) && isJsonValue(value)
  }
  if (key === 'acceptance') {
    return typeof value === 'string' ? value.length <= 8192 : isPlainRecord(value) && isJsonValue(value)
  }
  if (key === 'permission' || key === 'permissions') {
    return typeof value === 'string' ? value.length <= 8192
      : (isPlainRecord(value) || Array.isArray(value)) && isJsonValue(value)
  }
  if (key === 'memory') {
    if (typeof value === 'string') return value.length <= 8192
    return isPlainRecord(value)
      && Object.keys(value).every((field) => field === 'scope' || field === 'path')
      && (value.scope === 'user' || value.scope === 'project')
      && typeof value.path === 'string'
      && value.path.length > 0
      && value.path.length <= 1024
      && !value.path.includes('\\')
      && !value.path.includes('"')
      && !/[\x00-\x1f]/u.test(value.path)
  }
  if (LIST_FIELDS.has(key)) {
    if (typeof value === 'string') return value.length <= 8192
    return isStringList(value) && value.every((item) => item.length > 0
      && item.trim() === item
      && !item.includes(',')
      && !/[\r\n]/.test(item))
  }
  if (BOOLEAN_FIELDS.has(key)) return typeof value === 'boolean'
  if (OBJECT_FIELDS.has(key)) return typeof value === 'string' || (isPlainRecord(value) && isJsonValue(value))
  if (key === 'timeoutMs') return isPositiveSafeInteger(value)
  if (key === 'toolTimeoutMs') return isPositiveSafeInteger(value) && value <= 2_147_483_647
  if (key === 'maxSubagentDepth') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (key === 'systemPromptMode') return value === 'replace' || value === 'append'
  if (key === 'defaultContext') return value === 'fresh' || value === 'fork'
  if (key === 'outputMode') return value === 'inline' || value === 'file-only'
  if (key === 'acceptanceRole') return value === 'read-only' || value === 'writer'
  return typeof value === 'string' && value.length <= 8192
}

function normalizePackageName(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (value === false) return 'false'
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/-+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/(?:^[-.]+|[-.]+$)/g, '')
  return /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/.test(normalized) ? normalized : undefined
}

function normalizedNativeField(key: string, parsedValue: unknown): unknown {
  if (LIST_FIELDS.has(key)) {
    if (Array.isArray(parsedValue)) return parsedValue
    if (typeof parsedValue === 'string') return parseNativeList(parsedValue)
  }
  if (typeof parsedValue !== 'string') return parsedValue
  if (BOOLEAN_FIELDS.has(key) && (parsedValue === 'true' || parsedValue === 'false')) return parsedValue === 'true'
  if (key === 'thinking' && parsedValue === 'false') return false
  if (['timeoutMs', 'toolTimeoutMs', 'maxSubagentDepth'].includes(key) && /^\s*\d+\s*$/.test(parsedValue)) return Number(parsedValue)
  return parsedValue
}

function parseNativeList(value: string): string[] {
  return value.split('\n')
    .flatMap((line) => {
      const trimmed = line.trim()
      const item = trimmed.match(/^-\s+(.+)$/)?.[1] ?? trimmed
      return item.split(',')
    })
    .map((item) => item.trim())
    .filter(Boolean)
}

function fieldsFrom(frontmatter: Readonly<Record<string, unknown>>): AgentDefinitionFields {
  const fields: AgentDefinitionFields = Object.create(null)
  for (const key of NICOBAILON_FIELDS) {
    if (!Object.hasOwn(frontmatter, key) || SENSITIVE_KEY.test(key)) continue
    const value = normalizedNativeField(key, frontmatter[key])
    if (!validNativeField(key, value)) continue
    Object.defineProperty(fields, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return fields
}

function parseDefinition(content: string, fileName: string): ParsedDefinition {
  const fallbackName = fileName.replace(/\.md$/i, '')
  const parsed = parseAgentDefinitionFile(content, fileName)
  const frontmatter = isPlainRecord(parsed.rawFrontmatter) ? parsed.rawFrontmatter : {}
  const nameValue = frontmatter.name
  const descriptionValue = frontmatter.description
  const name = typeof nameValue === 'string' && nameValue.trim() ? nameValue.trim() : fallbackName
  const packageName = normalizePackageName(frontmatter.package)
  const runtimeName = packageName ? `${packageName}.${name}` : name
  const issues: AgentDefinitionValidationIssue[] = [...parsed.validationIssues]
  const hasFrontmatter = parsed.hasFrontmatter
  if (!hasFrontmatter) {
    issues.push(issue('missing-frontmatter', 'Native pi-subagents requires YAML frontmatter with name and description.'))
  } else {
    if (typeof nameValue !== 'string' || !nameValue.trim()) {
      issues.push(issue('missing-frontmatter', 'Native pi-subagents skips definitions without a non-empty name.', 'name'))
    }
    if (typeof descriptionValue !== 'string' || !descriptionValue.trim()) {
      issues.push(issue('missing-frontmatter', 'Native pi-subagents skips definitions without a non-empty description.', 'description'))
    }
    if (frontmatter.package !== undefined && frontmatter.package !== false && frontmatter.package !== '' && !packageName) {
      issues.push(issue('invalid-fields', 'Native package names must resolve to lowercase identifiers separated by dots.', 'package'))
    }
    if (frontmatter.permission !== undefined && frontmatter.permissions !== undefined) {
      issues.push(issue('invalid-fields', 'Native definitions cannot declare both permission and permissions.', 'permissions'))
    }
    if (runtimeName.length > MAX_NAME) {
      issues.push(issue('invalid-name', 'The fully qualified runtime agent name may not exceed 256 characters.', 'name'))
    }
    for (const [key, value] of Object.entries(frontmatter)) {
      if (NICOBAILON_FIELDS.has(key) && !validNativeField(key, normalizedNativeField(key, value))) {
        issues.push(issue('invalid-fields', `Native field '${key}' has a value pi-subagents does not support.`, key))
      }
    }
  }

  return {
    name: name.slice(0, MAX_NAME) || 'invalid-agent',
    runtimeName: runtimeName.slice(0, MAX_NAME) || 'invalid-agent',
    fields: fieldsFrom(frontmatter),
    frontmatter,
    prompt: parsed.prompt,
    hasFrontmatter,
    validationIssues: issues,
  }
}

function encodeId(scope: AgentDefinitionWriteScope, sourceRoot: SourceRoot, relativePath: string): string {
  return `${scope}~${Buffer.from(`${sourceRoot}/${relativePath}`, 'utf8').toString('base64url')}`
}

function decodeId(id: string): DecodedId | null {
  const separator = id.indexOf('~')
  if (separator < 1 || !/^[A-Za-z0-9_-]{1,392}$/.test(id.slice(separator + 1))) return null
  const scope = id.slice(0, separator)
  if (scope !== 'user' && scope !== 'project') return null
  let decoded: string
  try {
    decoded = Buffer.from(id.slice(separator + 1), 'base64url').toString('utf8')
  } catch {
    return null
  }
  const firstSlash = decoded.indexOf('/')
  if (firstSlash < 1) return null
  const sourceRoot = decoded.slice(0, firstSlash)
  const relativePath = decoded.slice(firstSlash + 1)
  if (sourceRoot !== 'user' && sourceRoot !== 'legacy' && sourceRoot !== 'project') return null
  if ((scope === 'user') !== (sourceRoot === 'user')) return null
  if (!isSafeRelativePath(relativePath) || !relativePath.endsWith('.md') || relativePath.endsWith('.chain.md')) return null
  if (encodeId(scope, sourceRoot, relativePath) !== id) return null
  return { scope, sourceRoot, relativePath }
}

function isSafeRelativePath(value: string): boolean {
  if (!value || Buffer.byteLength(value, 'utf8') > 280 || value.includes('\0') || value.includes('\\') || isAbsolute(value)) return false
  const parts = value.split(/[\\/]+/)
  return parts.every((part) => part.length > 0 && Buffer.byteLength(part, 'utf8') <= 255 && !UNSAFE_COMPONENT.test(part))
}

function safeDirectory(root: string, pathParts: readonly string[], create: boolean): string {
  const absoluteRoot = resolve(root)
  if (create && !existsSync(absoluteRoot)) mkdirSync(absoluteRoot, { recursive: true, mode: 0o700 })
  try {
    const rootDetails = lstatSync(absoluteRoot)
    if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
      throw new TypeError('Agent definition root must be a non-symbolic directory.')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error
    mkdirSync(absoluteRoot, { recursive: true, mode: 0o700 })
  }
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

function readRegularFile(filePath: string): string | undefined {
  let descriptor: number
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const details = fstatSync(descriptor)
    if (!details.isFile() || details.size > AGENT_DEFINITION_MAX_BYTES) return undefined
    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

function atomicWrite(filePath: string, content: string, createOnly = false): void {
  if (Buffer.byteLength(content, 'utf8') > AGENT_DEFINITION_MAX_BYTES) {
    throw new TypeError('Agent definition exceeds the size limit.')
  }
  const directory = dirname(filePath)
  const temporary = join(directory, `.${randomUUID()}.agent-definition.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    if (createOnly) {
      linkSync(temporary, filePath)
      unlinkSync(temporary)
    } else {
      renameSync(temporary, filePath)
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

function sourceParts(sourceRoot: SourceRoot): { readonly root: string; readonly directoryParts: readonly string[] } {
  if (sourceRoot === 'user') return { root: 'user', directoryParts: ['agents'] }
  if (sourceRoot === 'legacy') return { root: 'project', directoryParts: ['.agents'] }
  return { root: 'project', directoryParts: ['.pi', 'agents'] }
}

function cloneJsonObject(source: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(source)) as Record<string, unknown>
}

function settingsOverride(document: Readonly<Record<string, unknown>>, runtimeName: string): boolean | undefined {
  const subagents = document.subagents
  if (!isPlainRecord(subagents) || !isPlainRecord(subagents.agentOverrides)) return undefined
  if (!Object.hasOwn(subagents.agentOverrides, runtimeName)) return undefined
  const override = subagents.agentOverrides[runtimeName]
  if (!isPlainRecord(override) || !Object.hasOwn(override, 'disabled') || typeof override.disabled !== 'boolean') return undefined
  return override.disabled
}

function settingsOverridesAreReadable(document: Readonly<Record<string, unknown>>): boolean {
  const subagents = document.subagents
  if (subagents === undefined) return true
  if (!isPlainRecord(subagents)) return false
  const overrides = subagents.agentOverrides
  if (overrides === undefined) return true
  if (!isPlainRecord(overrides)) return false
  return Object.entries(overrides).every(([, value]) => isPlainRecord(value)
    && (!Object.hasOwn(value, 'disabled') || typeof value.disabled === 'boolean'))
}

function serializeDefinition(frontmatter: Readonly<Record<string, unknown>>, prompt: string): string {
  const lines: string[] = ['---']
  for (const [key, originalValue] of Object.entries(frontmatter)) {
    if (!FRONTMATTER_KEY.test(key) || UNSAFE_COMPONENT.test(key) || !isJsonValue(originalValue)) {
      throw new TypeError('Agent frontmatter contains a value that cannot be safely represented as native YAML.')
    }
    if (key === 'memory' && isPlainRecord(originalValue)) {
      lines.push(`${key}:`)
      for (const nestedKey of ['scope', 'path']) {
        const value = originalValue[nestedKey]
        if (value !== undefined) lines.push(`  ${nestedKey}: ${JSON.stringify(value)}`)
      }
      continue
    }
    if ((key === 'outputSchema' || key === 'toolBudget' || OBJECT_FIELDS.has(key)) && isPlainRecord(originalValue)) {
      // Native parsing consumes these as YAML/JSON text from a scalar or block value.
      lines.push(`${key}: ${JSON.stringify(originalValue)}`)
      continue
    }
    const value = originalValue
    if (Array.isArray(value) && LIST_FIELDS.has(key)) {
      lines.push(`${key}:`)
      for (const item of value) {
        if (typeof item !== 'string' || item.includes(',') || /[\r\n]/.test(item)) throw new TypeError('Native agent lists cannot encode comma or newline list items.')
        lines.push(`  - ${item}`)
      }
      continue
    }
    if (Array.isArray(originalValue)) {
      lines.push(`${key}: ${JSON.stringify(originalValue)}`)
      continue
    }
    if (typeof value === 'string' && /[\x00-\x1f\\"]/u.test(value)) {
      lines.push(`${key}: |-`)
      for (const line of value.replace(/\r\n/g, '\n').split('\n')) lines.push(`  ${line}`)
      continue
    }
    // JSON scalar quoting is accepted by both Pi's YAML parser and native frontmatter parser.
    const scalar = JSON.stringify(value)
    lines.push(`${key}: ${scalar}`)
  }
  return `${lines.join('\n')}\n---\n\n${prompt}\n`
}

function rawPromptBody(content: string): string {
  const normalized = content.startsWith('\uFEFF') ? content.slice(1) : content
  const lf = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!lf.startsWith('---')) return normalized
  const end = lf.indexOf('\n---', 3)
  return end < 0 ? normalized : lf.slice(end + 4)
}

export class NicobailonDefinitions {
  private readonly agentDir: string
  private readonly cwd: string

  constructor(private readonly options: NicobailonDefinitionsOptions) {
    if (!isAbsolute(options.agentDir) || !isAbsolute(options.cwd)) {
      throw new TypeError('Agent definition roots must be absolute paths.')
    }
    this.agentDir = resolve(options.agentDir)
    this.cwd = resolve(options.cwd)
  }

  list(request: AgentDefinitionListRequest = {}): AgentDefinitionListResponse {
    const projectAvailable = this.projectIsTrusted()
    const scopes: readonly AgentDefinitionScope[] = request.scope === 'user'
      ? ['user']
      : request.scope === 'workspace'
        || request.scope === 'bundled'
        ? []
        : request.scope === 'project'
          ? ['project']
          : projectAvailable ? ['user', 'project'] : ['user']
    if (!projectAvailable && scopes.includes('project')) return { definitions: [], projectAvailable: false }

    const all = this.readNativeOrder()
    const winners = new Map<string, number>()
    all.forEach((raw, index) => {
      const parsed = parseDefinition(raw.content, basename(raw.relativePath))
      if (parsed.validationIssues.length === 0) winners.set(parsed.runtimeName, index)
    })
    const disabled = this.disabledOverridesByName()
    const settingsAvailable = this.settingsAreReadable()
    const definitions = all
      .map((raw, index) => this.makeDefinition(
        raw,
        winners.get(parseDefinition(raw.content, basename(raw.relativePath)).runtimeName) !== index,
        disabled,
        settingsAvailable,
      ))
      .filter((definition) => scopes.includes(definition.scope))
      .sort((left, right) => SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope]
        || left.name.localeCompare(right.name)
        || left.fileName.localeCompare(right.fileName))
      .slice(0, MAX_DEFINITIONS)
    return { definitions, projectAvailable }
  }

  read(id: string): AgentDefinitionReadResponse {
    const decoded = decodeId(id)
    const projectAvailable = this.projectIsTrusted()
    if (!decoded || (decoded.scope !== 'user' && !projectAvailable)) {
      return { definition: null, projectAvailable, validationIssues: [] }
    }
    const definition = this.list({ scope: decoded.scope }).definitions.find((candidate) => candidate.id === id) ?? null
    return { definition, projectAvailable, validationIssues: definition?.validationIssues ?? [] }
  }

  create(request: AgentDefinitionCreateRequest): AgentDefinitionMutationResponse {
    if (request.scope === 'project' && !this.projectIsTrusted()) return this.unavailable()
    if (request.expectedRevision !== 0) {
      return this.invalid([issue('invalid-fields', 'A new definition must use revision 0.', 'expectedRevision')])
    }
    const invalidFields = this.validateRequestedFields(request.fields)
    if (invalidFields.length) return this.invalid(invalidFields)
    const frontmatter = cloneFrontmatter(Object.fromEntries(Object.entries(request.fields)))
    const issues = this.validateFrontmatter(frontmatter)
    if (issues.length) return this.invalid(issues)

    const sourceRoot: SourceRoot = request.scope === 'user' ? 'user' : 'project'
    if (this.uniqueTargetName(sourceRoot, this.runtimeName(frontmatter))) {
      return this.invalid([issue('duplicate-name', 'An agent with this runtime name already exists in the selected native location.', 'name')])
    }
    const fileName = this.uniqueFileName(sourceRoot, this.runtimeName(frontmatter))
    const target = this.targetPath(sourceRoot, fileName, true)
    if (readRegularFile(target) !== undefined) return this.conflict(this.read(encodeId(request.scope, sourceRoot, fileName)).definition)
    let content: string
    try {
      content = serializeDefinition(frontmatter, request.prompt)
    } catch {
      return this.invalid([issue('invalid-fields', 'Definition fields could not be safely serialized as native YAML.')])
    }
    if (Buffer.byteLength(content, 'utf8') > AGENT_DEFINITION_MAX_BYTES) {
      return this.invalid([issue('invalid-fields', 'The serialized definition exceeds the 1 MiB file-size limit.', 'prompt')])
    }
    try {
      atomicWrite(target, content, true)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const current = this.readRaw(sourceRoot, fileName)
        return this.conflict(current ? this.makeDefinition(current, false, this.disabledOverridesByName()) : null, current?.revision ?? null)
      }
      throw error
    }
    const definition = this.read(encodeId(request.scope, sourceRoot, fileName)).definition
    return { status: 'saved', definition, currentRevision: definition?.revision ?? revisionFor(content), validationIssues: [] }
  }

  update(request: AgentDefinitionUpdateRequest): AgentDefinitionMutationResponse {
    const target = this.resolveMutationTarget(request.id)
    if (!target) return this.notFound()
    if (target.scope === 'project' && !this.projectIsTrusted()) return this.unavailable()
    const current = this.readRaw(target.sourceRoot, target.relativePath)
    if (!current) return this.notFound()
    if (current.revision !== request.expectedRevision) return this.conflict(this.read(request.id).definition, current.revision)
    const parsed = parseDefinition(current.content, basename(current.relativePath))
    if (parsed.validationIssues.length) return this.invalid(parsed.validationIssues, this.makeDefinition(current, false, this.disabledOverridesByName()))
    const invalidFields = this.validateRequestedFields(request.fields)
    if (invalidFields.length) return this.invalid(invalidFields, this.makeDefinition(current, false, this.disabledOverridesByName()))
    if ((request.clearFields ?? []).some((key) => !NICOBAILON_FIELDS.has(key))) {
      return this.invalid([issue('invalid-fields', 'A requested field is not part of nicobailon native frontmatter.', 'clearFields')], this.makeDefinition(current, false, this.disabledOverridesByName()))
    }

    const frontmatter = cloneFrontmatter(parsed.frontmatter)
    for (const key of request.clearFields ?? []) delete frontmatter[key]
    for (const [key, value] of Object.entries(request.fields)) {
      Object.defineProperty(frontmatter, key, { value, enumerable: true, writable: true, configurable: true })
    }
    const issues = this.validateFrontmatter(frontmatter)
    if (issues.length) return this.invalid(issues, this.makeDefinition(current, false, this.disabledOverridesByName()))
    let serialized: string
    try {
      serialized = serializeDefinition(frontmatter, request.prompt === undefined ? rawPromptBody(current.content) : request.prompt)
    } catch {
      return this.invalid([issue('invalid-fields', 'Updated frontmatter contains a value the native YAML parser cannot safely serialize.')], this.makeDefinition(current, false, this.disabledOverridesByName()))
    }
    if (Buffer.byteLength(serialized, 'utf8') > AGENT_DEFINITION_MAX_BYTES) {
      return this.invalid([issue('invalid-fields', 'The serialized definition exceeds the 1 MiB file-size limit.', 'prompt')], this.makeDefinition(current, false, this.disabledOverridesByName()))
    }
    const latest = this.readRaw(target.sourceRoot, target.relativePath)
    if (!latest || latest.revision !== current.revision) {
      return this.conflict(latest ? this.read(request.id).definition : null, latest?.revision ?? null)
    }
    atomicWrite(this.targetPath(target.sourceRoot, target.relativePath, false), serialized)
    const definition = this.read(request.id).definition
    return { status: 'saved', definition, currentRevision: definition?.revision ?? revisionFor(serialized), validationIssues: [] }
  }

  delete(id: string, expectedRevision: number): AgentDefinitionMutationResponse {
    const target = this.resolveMutationTarget(id)
    if (!target) return this.notFound()
    if (target.scope === 'project' && !this.projectIsTrusted()) return this.unavailable()
    const current = this.readRaw(target.sourceRoot, target.relativePath)
    if (!current) return this.notFound()
    if (current.revision !== expectedRevision) return this.conflict(this.read(id).definition, current.revision)
    const latest = this.readRaw(target.sourceRoot, target.relativePath)
    if (!latest || latest.revision !== expectedRevision) {
      return this.conflict(latest ? this.read(id).definition : null, latest?.revision ?? null)
    }
    unlinkSync(this.targetPath(target.sourceRoot, target.relativePath, false))
    return { status: 'saved', definition: null, currentRevision: null, validationIssues: [] }
  }

  setEnabled(request: AgentDefinitionEnableRequest): AgentDefinitionMutationResponse {
    const target = this.resolveMutationTarget(request.id)
    if (!target) return this.notFound()
    if (target.scope === 'project' && !this.projectIsTrusted()) return this.unavailable()
    const current = this.readRaw(target.sourceRoot, target.relativePath)
    if (!current) return this.notFound()
    if (current.revision !== request.expectedRevision) return this.conflict(this.read(request.id).definition, current.revision)
    const parsed = parseDefinition(current.content, basename(current.relativePath))
    if (parsed.validationIssues.length) return this.invalid(parsed.validationIssues, this.makeDefinition(current, false, this.disabledOverridesByName()))
    const definition = this.read(request.id).definition
    if (definition?.shadowed) {
      return this.invalid([issue('invalid-fields', 'This definition is shadowed by a higher-priority agent; enable or disable the active definition instead.')], definition)
    }

    if (target.scope !== 'user' && target.scope !== 'project') return this.notFound()
    const settingScope: AgentDefinitionWriteScope = target.scope
    const settings = this.readSettings(settingScope)
    if (!settings) return this.invalid([issue('invalid-fields', 'Native agent settings could not be read safely.')], definition)
    const userSettings = settingScope === 'user' ? settings : this.readSettings('user')
    const projectSettings = settingScope === 'project' ? settings : this.projectIsTrusted() ? this.readSettings('project') : null
    if (!userSettings || !settingsOverridesAreReadable(userSettings.document)
      || (this.projectIsTrusted() && (!projectSettings || !settingsOverridesAreReadable(projectSettings.document)))) {
      return this.invalid([issue('invalid-fields', 'Native agent settings contain unreadable enablement overrides; no change was made.', 'enabled')], definition)
    }
    const ownValue = settingsOverride(settings.document, parsed.runtimeName)
    const higherScope = settingScope === 'user' ? projectSettings : null
    const higherValue = higherScope ? settingsOverride(higherScope.document, parsed.runtimeName) : undefined
    const lowerValue = settingScope === 'project' && userSettings ? settingsOverride(userSettings.document, parsed.runtimeName) : undefined
    const currentlyDisabled = higherValue ?? ownValue ?? (settingScope === 'project' ? lowerValue : undefined) ?? false
    if ((!request.enabled) === currentlyDisabled) {
      return { status: 'saved', definition, currentRevision: current.revision, validationIssues: [] }
    }
    if (higherValue !== undefined && higherValue !== !request.enabled) {
      return this.invalid([issue('invalid-fields', `A project-scope disabled override is taking precedence. Change the project setting to ${request.enabled ? 'enable' : 'disable'} this agent.`, 'enabled')], definition)
    }
    if (settingScope === 'project' && request.enabled && lowerValue === true) {
      return this.invalid([issue('invalid-fields', 'The project override cannot enable this agent while a user-scope disabled override remains. Enable it at user scope first.', 'enabled')], definition)
    }
    if (settingScope === 'user' && higherValue !== undefined) {
      return this.invalid([issue('invalid-fields', 'A project-scope override controls this agent; change the project setting instead.', 'enabled')], definition)
    }

    const latestDefinition = this.readRaw(target.sourceRoot, target.relativePath)
    if (!latestDefinition || latestDefinition.revision !== request.expectedRevision) {
      return this.conflict(latestDefinition ? this.read(request.id).definition : null, latestDefinition?.revision ?? null)
    }
    const changed = this.writeDisabledOverride(settingScope, parsed.runtimeName, !request.enabled, settings)
    if (changed === 'conflict') {
      const latest = this.readRaw(target.sourceRoot, target.relativePath)
      return this.conflict(latest ? this.read(request.id).definition : null, latest?.revision ?? null)
    }
    if (changed === 'invalid') {
      return this.invalid([issue('invalid-fields', 'The native agent settings contain malformed subagents overrides; they were left unchanged.', 'enabled')], definition)
    }
    const afterSettings = this.readSettings(settingScope)
    const after = afterSettings ? settingsOverride(afterSettings.document, parsed.runtimeName) : undefined
    const effectiveDisabled = settingScope === 'project'
      ? after ?? (userSettings ? settingsOverride(userSettings.document, parsed.runtimeName) : undefined) ?? false
      : (projectSettings ? settingsOverride(projectSettings.document, parsed.runtimeName) : undefined) ?? after ?? false
    if (effectiveDisabled !== !request.enabled) {
      return this.invalid([issue('invalid-fields', 'The settings override was written but the effective agent state did not change. A higher-precedence native override is active.', 'enabled')], this.read(request.id).definition)
    }
    const updated = this.read(request.id).definition
    return { status: 'saved', definition: updated, currentRevision: updated?.revision ?? current.revision, validationIssues: [] }
  }

  private validateRequestedFields(fields: AgentDefinitionFields): readonly AgentDefinitionValidationIssue[] {
    const issues: AgentDefinitionValidationIssue[] = []
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'enabled') {
        issues.push(issue('invalid-fields', 'nicobailon agents are enabled through native settings overrides, not an enabled frontmatter field.', key))
      } else if (!NICOBAILON_FIELDS.has(key) || !validNativeField(key, value)) {
        issues.push(issue('invalid-fields', `The value supplied for '${key}' is not supported by nicobailon native frontmatter.`, key))
      }
    }
    return issues
  }

  private validateFrontmatter(frontmatter: Readonly<Record<string, unknown>>): readonly AgentDefinitionValidationIssue[] {
    const issues: AgentDefinitionValidationIssue[] = []
    const name = frontmatter.name
    if (typeof name !== 'string' || !name.trim()) {
      issues.push(issue('missing-frontmatter', 'Native pi-subagents requires a non-empty name field.', 'name'))
    } else if (name.length > MAX_NAME) {
      issues.push(issue('invalid-name', 'Agent names may not exceed 256 characters.', 'name'))
    } else if (name.includes(':')) {
      issues.push(issue('reserved-name', 'Native pi-subagents reserves colons in agent names.', 'name'))
    }
    if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
      issues.push(issue('missing-frontmatter', 'Native pi-subagents requires a non-empty description field.', 'description'))
    }
    if (frontmatter.package !== undefined && frontmatter.package !== false && frontmatter.package !== '' && !normalizePackageName(frontmatter.package)) {
      issues.push(issue('invalid-fields', 'Native package names must resolve to lowercase identifiers separated by dots.', 'package'))
    }
    if (frontmatter.permission !== undefined && frontmatter.permissions !== undefined) {
      issues.push(issue('invalid-fields', 'Native definitions cannot declare both permission and permissions.', 'permissions'))
    }
    if (this.runtimeName(frontmatter).length > MAX_NAME) {
      issues.push(issue('invalid-name', 'The fully qualified runtime agent name may not exceed 256 characters.', 'name'))
    }
    for (const [key, value] of Object.entries(frontmatter)) {
      if (!FRONTMATTER_KEY.test(key) || UNSAFE_COMPONENT.test(key) || !isJsonValue(value)) {
        issues.push(issue('invalid-fields', 'Frontmatter contains a key or value that cannot be safely serialized.', key.slice(0, 128)))
      } else if (NICOBAILON_FIELDS.has(key) && !validNativeField(key, normalizedNativeField(key, value))) {
        issues.push(issue('invalid-fields', `Native field '${key}' has an unsupported value.`, key))
      }
    }
    return issues
  }

  private runtimeName(frontmatter: Readonly<Record<string, unknown>>): string {
    const name = typeof frontmatter.name === 'string' ? frontmatter.name : ''
    const packageName = normalizePackageName(frontmatter.package)
    return packageName ? `${packageName}.${name}` : name
  }

  private projectIsTrusted(): boolean {
    try { return this.options.isProjectTrusted() === true } catch { return false }
  }

  private sourceDirectory(sourceRoot: SourceRoot, create: boolean): string {
    const source = sourceParts(sourceRoot)
    const root = source.root === 'user' ? this.agentDir : this.cwd
    return safeDirectory(root, source.directoryParts, create)
  }

  private targetPath(sourceRoot: SourceRoot, relativePath: string, createParents: boolean): string {
    if (!isSafeRelativePath(relativePath) || !relativePath.endsWith('.md') || relativePath.endsWith('.chain.md')) {
      throw new TypeError('Agent definition file path is invalid.')
    }
    const source = sourceParts(sourceRoot)
    const root = source.root === 'user' ? this.agentDir : this.cwd
    const directory = safeDirectory(root, [...source.directoryParts, ...relativePath.split(/[\\/]/).slice(0, -1)], createParents)
    const target = join(directory, basename(relativePath))
    const rel = relative(resolve(root), target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError('Agent definition path escapes its configured root.')
    try {
      const details = lstatSync(target)
      if (details.isSymbolicLink() || !details.isFile()) throw new TypeError('Agent definition target is not a regular file.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return target
  }

  private readRaw(sourceRoot: SourceRoot, relativePath: string): RawDefinition | null {
    if (sourceRoot !== 'user' && !this.projectIsTrusted()) return null
    let content: string | undefined
    try {
      content = readRegularFile(this.targetPath(sourceRoot, relativePath, false))
    } catch {
      return null
    }
    if (content === undefined) return null
    const scope: AgentDefinitionWriteScope = sourceRoot === 'user' ? 'user' : 'project'
    return { scope, sourceRoot, relativePath, content, revision: revisionFor(content) }
  }

  private readNativeOrder(): RawDefinition[] {
    const records: RawDefinition[] = []
    for (const sourceRoot of ['user', 'legacy', 'project'] as const) {
      if (sourceRoot !== 'user' && !this.projectIsTrusted()) continue
      let directory: string
      try {
        directory = this.sourceDirectory(sourceRoot, false)
      } catch {
        continue
      }
      let count = 0
      const visit = (absoluteDirectory: string, relativeDirectory: string): void => {
        if (count >= MAX_FILES_PER_ROOT) return
        let entries: Dirent[]
        try {
          entries = readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
        } catch {
          return
        }
        for (const entry of entries) {
          if (count >= MAX_FILES_PER_ROOT || entry.isSymbolicLink()) continue
          const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
          const fullPath = join(absoluteDirectory, entry.name)
          if (entry.isDirectory()) {
            if (!UNSAFE_COMPONENT.test(entry.name)) visit(fullPath, relativePath)
          } else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.endsWith('.chain.md')) {
            count += 1
            const raw = this.readRaw(sourceRoot, relativePath)
            if (raw) records.push(raw)
          }
        }
      }
      visit(directory, '')
    }
    return records
  }

  private readSettings(scope: AgentDefinitionWriteScope): SettingsSnapshot | null {
    const root = scope === 'user' ? this.agentDir : this.cwd
    let directory: string
    try {
      directory = safeDirectory(root, scope === 'user' ? [] : ['.pi'], false)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: join(root, ...(scope === 'user' ? [] : ['.pi']), 'settings.json'), content: undefined, revision: 0, document: {} }
      return null
    }
    const filePath = join(directory, 'settings.json')
    try {
      const fileDetails = lstatSync(filePath)
      if (fileDetails.isSymbolicLink() || !fileDetails.isFile() || fileDetails.size > AGENT_DEFINITION_MAX_BYTES) return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      return { path: filePath, content: undefined, revision: 0, document: {} }
    }
    let content: string | undefined
    try { content = readRegularFile(filePath) } catch { return null }
    if (content === undefined) return { path: filePath, content, revision: 0, document: {} }
    let document: unknown
    try { document = JSON.parse(content) } catch { return null }
    if (!isPlainRecord(document)) return null
    return { path: filePath, content, revision: revisionFor(content), document: cloneJsonObject(document) }
  }

  private disabledOverridesByName(): ReadonlyMap<string, boolean> {
    const user = this.readSettings('user')
    const project = this.projectIsTrusted() ? this.readSettings('project') : null
    const names = new Set<string>()
    for (const snapshot of [user, project]) {
      if (!snapshot) continue
      const subagents = snapshot.document.subagents
      const overrides = isPlainRecord(subagents) && isPlainRecord(subagents.agentOverrides) ? subagents.agentOverrides : null
      if (overrides) for (const name of Object.keys(overrides)) names.add(name)
    }
    const result = new Map<string, boolean>()
    for (const name of names) {
      const projectValue = project ? settingsOverride(project.document, name) : undefined
      const value = projectValue ?? (user ? settingsOverride(user.document, name) : undefined)
      if (value !== undefined) result.set(name, value)
    }
    return result
  }

  private settingsAreReadable(): boolean {
    const user = this.readSettings('user')
    if (!user || !settingsOverridesAreReadable(user.document)) return false
    if (!this.projectIsTrusted()) return true
    const project = this.readSettings('project')
    return project !== null && settingsOverridesAreReadable(project.document)
  }

  private writeDisabledOverride(
    scope: AgentDefinitionWriteScope,
    runtimeName: string,
    disabled: boolean,
    snapshot: SettingsSnapshot,
  ): 'saved' | 'conflict' | 'invalid' {
    const latest = this.readSettings(scope)
    if (!latest || latest.revision !== snapshot.revision) return 'conflict'
    if (!settingsOverridesAreReadable(latest.document)) return 'invalid'
    if (latest.document.subagents !== undefined && !isPlainRecord(latest.document.subagents)) return 'invalid'
    const existingSubagents = isPlainRecord(latest.document.subagents) ? latest.document.subagents : undefined
    if (existingSubagents?.agentOverrides !== undefined && !isPlainRecord(existingSubagents.agentOverrides)) return 'invalid'
    const existingOverrides = isPlainRecord(existingSubagents?.agentOverrides) ? existingSubagents.agentOverrides : undefined
    if (existingOverrides && Object.hasOwn(existingOverrides, runtimeName)
      && !isPlainRecord(existingOverrides[runtimeName])) return 'invalid'
    const document = cloneJsonObject(latest.document)
    const currentSubagents = document.subagents
    const subagents = isPlainRecord(currentSubagents) ? currentSubagents : Object.create(null) as Record<string, unknown>
    const currentOverrides = subagents.agentOverrides
    const overrides = isPlainRecord(currentOverrides) ? currentOverrides : Object.create(null) as Record<string, unknown>
    const currentOverride = Object.hasOwn(overrides, runtimeName) ? overrides[runtimeName] : undefined
    const override = isPlainRecord(currentOverride) ? currentOverride : Object.create(null) as Record<string, unknown>
    if (disabled) {
      Object.defineProperty(override, 'disabled', { value: true, enumerable: true, writable: true, configurable: true })
      Object.defineProperty(overrides, runtimeName, { value: override, enumerable: true, writable: true, configurable: true })
    } else {
      delete override.disabled
      if (Object.keys(override).length > 0) Object.defineProperty(overrides, runtimeName, { value: override, enumerable: true, writable: true, configurable: true })
      else delete overrides[runtimeName]
    }
    if (Object.keys(overrides).length > 0) subagents.agentOverrides = overrides
    else delete subagents.agentOverrides
    if (Object.keys(subagents).length > 0) document.subagents = subagents
    else delete document.subagents

    const content = `${JSON.stringify(document, null, 2)}\n`
    const root = scope === 'user' ? this.agentDir : this.cwd
    const directoryParts = scope === 'user' ? [] : ['.pi']
    const directory = safeDirectory(root, directoryParts, true)
    const filePath = join(directory, 'settings.json')
    let latestContent: string | undefined
    try { latestContent = readRegularFile(filePath) } catch { return 'conflict' }
    if (revisionFor(latestContent) !== snapshot.revision) return 'conflict'
    try {
      atomicWrite(filePath, content, latestContent === undefined)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'conflict'
      throw error
    }
    return 'saved'
  }

  private uniqueFileName(sourceRoot: 'user' | 'project', runtimeName: string): string {
    const source = sourceRoot
    const base = runtimeName.trim().toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 100) || 'agent'
    let candidate = `${base}.md`
    let suffix = 2
    while (this.pathExists(source, candidate)) {
      candidate = `${base.slice(0, 94)}-${suffix}.md`
      suffix += 1
    }
    return candidate
  }

  private pathExists(sourceRoot: SourceRoot, relativePath: string): boolean {
    try {
      const details = lstatSync(this.targetPath(sourceRoot, relativePath, false))
      return details.isFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private makeDefinition(
    raw: RawDefinition,
    shadowed: boolean,
    disabled?: ReadonlyMap<string, boolean>,
    settingsAvailable = true,
  ): AgentDefinition {
    const parsed = parseDefinition(raw.content, basename(raw.relativePath))
    const validationIssues = settingsAvailable
      ? parsed.validationIssues
      : [...parsed.validationIssues, issue('invalid-fields', 'Native enablement settings could not be read safely.', 'enabled')]
    return {
      id: encodeId(raw.scope, raw.sourceRoot, raw.relativePath),
      provider: 'nicobailon',
      path: raw.sourceRoot === 'user'
        ? `agents/${raw.relativePath}`
        : raw.sourceRoot === 'legacy' ? `.agents/${raw.relativePath}` : `.pi/agents/${raw.relativePath}`,
      name: parsed.runtimeName.slice(0, MAX_NAME),
      fileName: basename(raw.relativePath),
      scope: raw.scope,
      provenance: raw.scope,
      shadowed,
      revision: raw.revision,
      fields: parsed.fields,
      prompt: parsed.prompt.slice(0, MAX_PROMPT),
      enabled: settingsAvailable && disabled?.get(parsed.runtimeName) !== true,
      valid: validationIssues.length === 0,
      validationIssues,
    }
  }

  private resolveMutationTarget(id: string): DecodedId | null {
    const decoded = decodeId(id)
    return decoded
  }

  private uniqueTargetName(sourceRoot: SourceRoot, runtimeName: string): boolean {
    return this.readNativeOrder().some((raw) => {
      if (raw.sourceRoot !== sourceRoot) return false
      const parsed = parseDefinition(raw.content, basename(raw.relativePath))
      return parsed.validationIssues.length === 0 && parsed.runtimeName === runtimeName
    })
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
