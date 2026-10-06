import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { CONFIG_DIR_NAME, parseFrontmatter, type SettingsManager } from '@earendil-works/pi-coding-agent'
import { isPlainRecord } from '../../shared/ipc-contracts.ts'
import type {
  PackageScope,
  ResourceListResponse,
  ResourceProvenanceView,
  ResourceReloadResponse,
  SkillCreateRequest,
  SkillDeleteRequest,
  SkillDocumentView,
  SkillEnableRequest,
  SkillEnableResponse,
  SkillMutationResponse,
  SkillReadRequest,
  SkillUpdateRequest,
  TemplateCreateRequest,
  TemplateDeleteRequest,
  TemplateDocumentView,
  TemplateMutationResponse,
  TemplateReadRequest,
  TemplateUpdateRequest,
} from '../../shared/packages.ts'
import type { ResourceService } from './resource-service.ts'

const MAX_FILE_BYTES = 1024 * 1024
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type DocumentKind = 'skill' | 'template'
type ParsedDocument = {
  readonly content: string
  readonly frontmatter: Record<string, unknown>
  readonly body: string
  readonly revision: string
}

type LocalDocumentTarget = {
  readonly kind: DocumentKind
  readonly path: string
  readonly root: string
  readonly scope: PackageScope
}

export interface SkillServiceOptions {
  readonly cwd: string
  readonly agentDir: string
  readonly settingsManager: SettingsManager
  readonly resources: ResourceService
  readonly isProjectTrusted: () => boolean
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function projectSettingsRoot(cwd: string): string {
  return resolve(cwd, CONFIG_DIR_NAME)
}

function managedRoot(kind: DocumentKind, scope: PackageScope, cwd: string, agentDir: string): string {
  const project = scope === 'project'
  const base = project ? projectSettingsRoot(cwd) : resolve(agentDir)
  return resolve(base, kind === 'skill' ? 'skills' : 'prompts')
}

function isNativeDocumentPath(kind: DocumentKind, root: string, filePath: string): boolean {
  if (!isWithin(root, filePath) || resolve(root) === resolve(filePath)) return false
  if (kind === 'template') return dirname(filePath) === resolve(root) && basename(filePath).endsWith('.md')
  const segments = relative(resolve(root), resolve(filePath)).split(sep)
  if (segments.some((segment) => segment.startsWith('.') || segment === 'node_modules')) return false
  return basename(filePath) === 'SKILL.md'
    || (dirname(filePath) === resolve(root) && basename(filePath).endsWith('.md'))
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function assertNoSymlinkPath(path: string, allowMissing: boolean): void {
  const target = resolve(path)
  const parts = target.slice(sep.length).split(sep).filter(Boolean)
  let current: string = sep
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!)
    const stat = lstatOrUndefined(current)
    if (!stat) {
      if (allowMissing) return
      throw new Error('The requested native resource does not exist.')
    }
    if (stat.isSymbolicLink()) throw new Error('Native resource paths must not contain symbolic links.')
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error('A native resource parent is not a directory.')
    }
  }
}

function ensureDirectoryTree(path: string): void {
  const target = resolve(path)
  const parts = target.slice(sep.length).split(sep).filter(Boolean)
  let current: string = sep
  for (const part of parts) {
    current = resolve(current, part)
    const stat = lstatOrUndefined(current)
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Native resource directories must be real directories.')
      }
      continue
    }
    try {
      mkdirSync(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const after = lstatSync(current)
      if (after.isSymbolicLink() || !after.isDirectory()) throw new Error('Native resource directories must be real directories.')
    }
  }
}

function readFileNoFollow(path: string): string {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('The native resource file is invalid or too large.')
    return readFileSync(descriptor, 'utf8')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function readDocument(path: string): ParsedDocument {
  const content = readFileNoFollow(path)
  let parsed: { frontmatter: Record<string, unknown>; body: string }
  try {
    parsed = parseFrontmatter(content)
  } catch {
    throw new Error('The native resource frontmatter is invalid.')
  }
  if (!isPlainRecord(parsed.frontmatter)) throw new Error('The native resource frontmatter must be a YAML mapping.')
  return { content, frontmatter: parsed.frontmatter, body: parsed.body, revision: sha256(content) }
}

function mergeFrontmatter(
  current: Record<string, unknown>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(current)) {
    if (UNSAFE_KEYS.has(key)) throw new Error('Native resource frontmatter contains an unsafe key.')
    merged[key] = value
  }
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) throw new Error('Native resource frontmatter contains an unsafe key.')
    merged[key] = value
  }
  return merged
}

function serializeDocument(frontmatter: Record<string, unknown>, body: string): string {
  // JSON is a valid YAML mapping, and avoids bringing a second parser/emitter into this lane.
  const yaml = JSON.stringify(frontmatter, null, 2)
  if (yaml === undefined) throw new Error('Native resource frontmatter could not be serialized.')
  const normalizedBody = body.replace(/\r\n?/g, '\n')
  const content = `---\n${yaml}\n---\n${normalizedBody}${normalizedBody.endsWith('\n') ? '' : '\n'}`
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('The native resource file is too large.')
  return content
}

function writeTemporaryFile(path: string, content: string, mode: number): string {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    return temporaryPath
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary file may not have been created.
    }
    throw error
  }
}

function createFileExclusive(path: string, content: string): void {
  const temporaryPath = writeTemporaryFile(path, content, 0o600)
  try {
    linkSync(temporaryPath, path)
  } finally {
    unlinkSync(temporaryPath)
  }
}

function replaceFile(path: string, content: string, mode: number): void {
  const temporaryPath = writeTemporaryFile(path, content, mode)
  try {
    renameSync(temporaryPath, path)
  } finally {
    unlinkSync(temporaryPath)
  }
}

function validateSkillFrontmatter(frontmatter: Record<string, unknown>, path: string): {
  readonly name: string
  readonly description: string
  readonly disableModelInvocation: boolean
} {
  const fallbackName = basename(dirname(path))
  if (Object.hasOwn(frontmatter, 'name') && typeof frontmatter.name !== 'string') {
    throw new Error('Skill frontmatter name must be a string.')
  }
  const name = typeof frontmatter.name === 'string' ? frontmatter.name : fallbackName
  const description = frontmatter.description
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error('Skill names must be lowercase letters, digits, and single hyphens, up to 64 characters.')
  }
  if (typeof description !== 'string' || description.trim().length === 0 || description.length > 1024) {
    throw new Error('Skill description must be non-empty and at most 1024 characters.')
  }
  if (Object.hasOwn(frontmatter, 'disable-model-invocation') && typeof frontmatter['disable-model-invocation'] !== 'boolean') {
    throw new Error('Skill disable-model-invocation must be a boolean.')
  }
  return {
    name,
    description,
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
  }
}

function readSkillMetadata(frontmatter: Record<string, unknown>, path: string): {
  readonly name: string
  readonly description: string
  readonly disableModelInvocation: boolean
} {
  const name = typeof frontmatter.name === 'string' && frontmatter.name
    ? frontmatter.name
    : basename(dirname(path))
  return {
    name: name.slice(0, 1024),
    description: typeof frontmatter.description === 'string' ? frontmatter.description.slice(0, 8192) : '',
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
  }
}

function templateMetadata(frontmatter: Readonly<Record<string, unknown>>, body: string): {
  readonly description: string
  readonly argumentHint?: string
} {
  if (Object.hasOwn(frontmatter, 'description') && typeof frontmatter.description !== 'string') {
    throw new Error('Prompt template description must be a string.')
  }
  if (Object.hasOwn(frontmatter, 'argument-hint') && typeof frontmatter['argument-hint'] !== 'string') {
    throw new Error('Prompt template argument-hint must be a string.')
  }
  let description = typeof frontmatter.description === 'string' ? frontmatter.description : ''
  if (!description) {
    const firstLine = body.split('\n').find((line) => line.trim())
    description = firstLine ? `${firstLine.slice(0, 60)}${firstLine.length > 60 ? '...' : ''}` : ''
  }
  const argumentHint = typeof frontmatter['argument-hint'] === 'string' ? frontmatter['argument-hint'] : undefined
  if (description.length > 8192) throw new Error('Prompt template description is too long.')
  return { description, ...(argumentHint ? { argumentHint } : {}) }
}

function readTemplateMetadata(frontmatter: Record<string, unknown>, body: string): {
  readonly description: string
  readonly argumentHint?: string
} {
  let description = typeof frontmatter.description === 'string' ? frontmatter.description : ''
  if (!description) {
    const firstLine = body.split('\n').find((line) => line.trim())
    description = firstLine ? `${firstLine.slice(0, 60)}${firstLine.length > 60 ? '...' : ''}` : ''
  }
  const argumentHint = typeof frontmatter['argument-hint'] === 'string' && frontmatter['argument-hint']
    ? frontmatter['argument-hint'].slice(0, 2048)
    : undefined
  return { description: description.slice(0, 8192), ...(argumentHint ? { argumentHint } : {}) }
}

function nativeProvenance(path: string, scope: PackageScope): ResourceProvenanceView {
  return { path, scope, source: scope, sourceDetail: 'local' }
}

export class SkillService {
  private readonly cwd: string
  private readonly agentDir: string
  private readonly settingsManager: SettingsManager
  private readonly resources: ResourceService
  private readonly isProjectTrusted: () => boolean
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(options: SkillServiceOptions) {
    this.cwd = resolve(options.cwd)
    this.agentDir = resolve(options.agentDir)
    this.settingsManager = options.settingsManager
    this.resources = options.resources
    this.isProjectTrusted = options.isProjectTrusted
  }

  readSkill(request: SkillReadRequest): SkillDocumentView {
    const { target, provenance: view } = this.resolveReadableTarget('skill', request.scope, request.path)
    const document = readDocument(target.path)
    return this.skillView(target.path, request.scope, document, view ?? nativeProvenance(target.path, request.scope))
  }

  createSkill(request: SkillCreateRequest): Promise<SkillMutationResponse> {
    return this.enqueue(async () => {
      this.assertScopeTrusted(request.scope)
      const root = managedRoot('skill', request.scope, this.cwd, this.agentDir)
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.name) || request.name.length > 64) {
        throw new Error('The skill name is invalid.')
      }
      const path = resolve(root, request.name, 'SKILL.md')
      const target = this.assertLocalTarget('skill', request.scope, path)
      const frontmatter: Record<string, unknown> = {
        name: request.name,
        description: request.description,
        ...(request.disableModelInvocation === undefined ? {} : { 'disable-model-invocation': request.disableModelInvocation }),
      }
      validateSkillFrontmatter(frontmatter, target.path)
      const content = serializeDocument(frontmatter, request.body)
      ensureDirectoryTree(dirname(target.path))
      if (lstatOrUndefined(target.path)) return { outcome: 'conflict', item: this.safeSkillView(target.path, request.scope) }
      try {
        createFileExclusive(target.path, content)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return { outcome: 'conflict', item: this.safeSkillView(target.path, request.scope) }
        }
        throw error
      }
      const reloadOutcome = await this.reloadResources()
      return { outcome: 'saved', item: this.safeSkillView(target.path, request.scope), reloadOutcome }
    })
  }

  updateSkill(request: SkillUpdateRequest): Promise<SkillMutationResponse> {
    return this.enqueue(async () => {
      this.assertScopeTrusted(request.scope)
      const target = this.assertLocalTarget('skill', request.scope, request.path)
      const current = this.readLocal(target)
      if (!current) return { outcome: 'not-found', item: null }
      if (current.revision !== request.expectedRevision) {
        return { outcome: 'conflict', item: this.skillView(target.path, request.scope, current, this.findProvenance('skill', target.path, request.scope) ?? nativeProvenance(target.path, request.scope)) }
      }
      const frontmatter = mergeFrontmatter(current.frontmatter, request.frontmatter)
      validateSkillFrontmatter(frontmatter, target.path)
      const content = serializeDocument(frontmatter, request.body)
      this.replaceLocal(target, current, content)
      const reloadOutcome = await this.reloadResources()
      return { outcome: 'saved', item: this.safeSkillView(target.path, request.scope), reloadOutcome }
    })
  }

  deleteSkill(request: SkillDeleteRequest): Promise<SkillMutationResponse> {
    return this.enqueue(async () => {
      this.assertScopeTrusted(request.scope)
      const target = this.assertLocalTarget('skill', request.scope, request.path)
      const current = this.readLocal(target)
      if (!current) return { outcome: 'not-found', item: null }
      if (current.revision !== request.expectedRevision) {
        return { outcome: 'conflict', item: this.skillView(target.path, request.scope, current, this.findProvenance('skill', target.path, request.scope) ?? nativeProvenance(target.path, request.scope)) }
      }
      this.assertSafeLocalFile(target)
      const latest = this.readLocal(target)
      if (!latest || latest.revision !== request.expectedRevision) {
        return { outcome: 'conflict', item: latest ? this.skillView(target.path, request.scope, latest, this.findProvenance('skill', target.path, request.scope) ?? nativeProvenance(target.path, request.scope)) : null }
      }
      unlinkSync(target.path)
      const reloadOutcome = await this.reloadResources()
      return { outcome: 'saved', item: null, reloadOutcome }
    })
  }

  setSkillEnabled(request: SkillEnableRequest): Promise<SkillEnableResponse> {
    return this.enqueue(async () => {
      this.assertScopeTrusted(request.scope)
      const target = this.assertLocalTarget('skill', request.scope, request.path)
      const document = this.readLocal(target)
      if (!document) {
        return {
          outcome: 'not-found', scope: request.scope, path: target.path, enabled: request.enabled,
          semantics: 'native-skill-filter', globalSkillCommandsEnabled: this.settingsManager.getEnableSkillCommands(),
        }
      }
      const patterns = request.scope === 'user'
        ? [...(this.settingsManager.getGlobalSettings().skills ?? [])]
        : [...(this.settingsManager.getProjectSettings().skills ?? [])]
      const base = request.scope === 'user' ? this.agentDir : projectSettingsRoot(this.cwd)
      const relativeFile = relative(base, target.path).split(sep).join('/')
      const relativeDirectory = relative(base, dirname(target.path)).split(sep).join('/')
      const absoluteFile = target.path.split(sep).join('/')
      const absoluteDirectory = dirname(target.path).split(sep).join('/')
      const matchingPatterns = new Set([relativeFile, relativeDirectory, absoluteFile, absoluteDirectory])
      const marker = `${request.enabled ? '+' : '-'}${relativeFile}`
      const nextPatterns = patterns.filter((pattern) => {
        if (!pattern.startsWith('+') && !pattern.startsWith('-')) return true
        const value = pattern.slice(1).replaceAll('\\', '/')
        if (!matchingPatterns.has(value)) return true
        return request.enabled ? !pattern.startsWith('-') : !pattern.startsWith('+')
      })
      if (!nextPatterns.includes(marker)) nextPatterns.push(marker)
      if (nextPatterns.length === patterns.length && nextPatterns.every((value, index) => value === patterns[index])) {
        return {
          outcome: 'unchanged', scope: request.scope, path: target.path, enabled: request.enabled,
          semantics: 'native-skill-filter', globalSkillCommandsEnabled: this.settingsManager.getEnableSkillCommands(),
        }
      }
      if (request.scope === 'user') this.settingsManager.setSkillPaths(nextPatterns)
      else this.settingsManager.setProjectSkillPaths(nextPatterns)
      const reloadOutcome = await this.reloadResources()
      return {
        outcome: 'saved', scope: request.scope, path: target.path, enabled: request.enabled,
        semantics: 'native-skill-filter',
        globalSkillCommandsEnabled: this.settingsManager.getEnableSkillCommands(),
        reloadOutcome,
      }
    })
  }

  readTemplate(request: TemplateReadRequest): TemplateDocumentView {
    const { target, provenance: view } = this.resolveReadableTarget('template', request.scope, request.path)
    const document = readDocument(target.path)
    return this.templateView(target.path, request.scope, document, view ?? nativeProvenance(target.path, request.scope))
  }

  createTemplate(request: TemplateCreateRequest): Promise<TemplateMutationResponse> {
    return this.enqueue(async () => {
      this.assertScopeTrusted(request.scope)
      const root = managedRoot('template', request.scope, this.cwd, this.agentDir)
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.name)) throw new Error('The prompt template name is invalid.')
      const target = this.assertLocalTarget('template', request.scope, resolve(root, `${request.name}.md`))
      this.validateTemplateFrontmatter(request.frontmatter, request.body)
      const content = serializeDocument(mergeFrontmatter(Object.create(null) as Record<string, unknown>, request.frontmatter), request.body)
      ensureDirectoryTree(dirname(target.path))
      if (lstatOrUndefined(target.path)) return { outcome: 'conflict', item: this.safeTemplateView(target.path, request.scope) }
      try {
        createFileExclusive(target.path, content)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return { outcome: 'conflict', item: this.safeTemplateView(target.path, request.scope) }
        }
        throw error
      }
      const reloadOutcome = await this.reloadResources()
      return { outcome: 'saved', item: this.safeTemplateView(target.path, request.scope), reloadOutcome }
    })
  }

  updateTemplate(request: TemplateUpdateRequest): Promise<TemplateMutationResponse> {
    return this.enqueue(async () => {
      this.assertScopeTrusted(request.scope)
      const target = this.assertLocalTarget('template', request.scope, request.path)
      const current = this.readLocal(target)
      if (!current) return { outcome: 'not-found', item: null }
      if (current.revision !== request.expectedRevision) {
        return { outcome: 'conflict', item: this.templateView(target.path, request.scope, current, this.findProvenance('template', target.path, request.scope) ?? nativeProvenance(target.path, request.scope)) }
      }
      const frontmatter = mergeFrontmatter(current.frontmatter, request.frontmatter)
      this.validateTemplateFrontmatter(frontmatter, request.body)
      const content = serializeDocument(frontmatter, request.body)
      this.replaceLocal(target, current, content)
      const reloadOutcome = await this.reloadResources()
      return { outcome: 'saved', item: this.safeTemplateView(target.path, request.scope), reloadOutcome }
    })
  }

  deleteTemplate(request: TemplateDeleteRequest): Promise<TemplateMutationResponse> {
    return this.enqueue(async () => {
      this.assertScopeTrusted(request.scope)
      const target = this.assertLocalTarget('template', request.scope, request.path)
      const current = this.readLocal(target)
      if (!current) return { outcome: 'not-found', item: null }
      if (current.revision !== request.expectedRevision) {
        return { outcome: 'conflict', item: this.templateView(target.path, request.scope, current, this.findProvenance('template', target.path, request.scope) ?? nativeProvenance(target.path, request.scope)) }
      }
      this.assertSafeLocalFile(target)
      const latest = this.readLocal(target)
      if (!latest || latest.revision !== request.expectedRevision) {
        return { outcome: 'conflict', item: latest ? this.templateView(target.path, request.scope, latest, this.findProvenance('template', target.path, request.scope) ?? nativeProvenance(target.path, request.scope)) : null }
      }
      unlinkSync(target.path)
      const reloadOutcome = await this.reloadResources()
      return { outcome: 'saved', item: null, reloadOutcome }
    })
  }

  private resolveReadableTarget(kind: DocumentKind, scope: PackageScope, requestedPath: string): {
    readonly target: LocalDocumentTarget
    readonly provenance: ResourceProvenanceView
  } {
    this.assertScopeTrusted(scope)
    if (!isAbsolute(requestedPath)) throw new Error('A native resource path must be absolute.')
    const path = resolve(requestedPath)
    const root = managedRoot(kind, scope, this.cwd, this.agentDir)
    if (isNativeDocumentPath(kind, root, path)) {
      const target = { kind, path, root, scope }
      const document = this.readLocal(target)
      if (!document) throw new Error('The native resource was not found.')
      return { target, provenance: this.findProvenance(kind, path, scope) ?? nativeProvenance(path, scope) }
    }
    const loaded = this.findLoadedResource(kind, path, scope)
    if (!loaded) throw new Error('The requested resource is not a native loader resource at this scope.')
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('The native resource file is invalid or too large.')
    const target = { kind, path, root, scope }
    return { target, provenance: loaded }
  }

  private assertLocalTarget(kind: DocumentKind, scope: PackageScope, requestedPath: string): LocalDocumentTarget {
    if (!isAbsolute(requestedPath)) throw new Error('A native resource path must be absolute.')
    const path = resolve(requestedPath)
    const root = managedRoot(kind, scope, this.cwd, this.agentDir)
    if (!isNativeDocumentPath(kind, root, path)) {
      throw new Error('Writes are limited to native user or trusted project resource files.')
    }
    return { kind, path, root, scope }
  }

  private findLoadedResource(kind: DocumentKind, path: string, scope: PackageScope): ResourceProvenanceView | undefined {
    const list: ResourceListResponse = this.resources.list()
    const entries = kind === 'skill' ? list.skills : list.promptTemplates
    const match = entries.find((entry) => resolve(entry.path) === path && entry.scope === scope)
    return match
  }

  private findProvenance(kind: DocumentKind, path: string, scope: PackageScope): ResourceProvenanceView | undefined {
    return this.findLoadedResource(kind, path, scope)
  }

  private readLocal(target: LocalDocumentTarget): ParsedDocument | undefined {
    if (!lstatOrUndefined(target.path)) return undefined
    this.assertSafeLocalFile(target)
    return readDocument(target.path)
  }

  private assertSafeLocalFile(target: LocalDocumentTarget): void {
    if (!isNativeDocumentPath(target.kind, target.root, target.path)) {
      throw new Error('The native resource path is outside its managed directory.')
    }
    assertNoSymlinkPath(target.path, false)
    const stat = lstatSync(target.path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The native resource must be a regular file.')
  }

  private replaceLocal(target: LocalDocumentTarget, previous: ParsedDocument, content: string): void {
    this.assertSafeLocalFile(target)
    const latest = readDocument(target.path)
    if (latest.revision !== previous.revision) throw new Error('The native resource changed during the update.')
    const stat = lstatSync(target.path)
    replaceFile(target.path, content, stat.mode & 0o666)
  }

  private skillView(path: string, scope: PackageScope, document: ParsedDocument, provenance: ResourceProvenanceView): SkillDocumentView {
    const metadata = readSkillMetadata(document.frontmatter, path)
    const active = this.resources.list().skills
    const loaded = active.some((entry) => resolve(entry.path) === path)
    const shadowedBy = active.find((entry) => entry.name === metadata.name && resolve(entry.path) !== path)?.path
    return {
      ...provenance,
      path,
      scope,
      kind: 'skill',
      name: metadata.name,
      description: metadata.description,
      disableModelInvocation: metadata.disableModelInvocation,
      content: document.content,
      body: document.body,
      revision: document.revision,
      loaded,
      ...(shadowedBy ? { shadowedBy } : {}),
    }
  }

  private templateView(path: string, scope: PackageScope, document: ParsedDocument, provenance: ResourceProvenanceView): TemplateDocumentView {
    const metadata = readTemplateMetadata(document.frontmatter, document.body)
    const active = this.resources.list().promptTemplates
    const name = basename(path).replace(/\.md$/, '')
    const loaded = active.some((entry) => resolve(entry.path) === path)
    const shadowedBy = active.find((entry) => entry.name === name && resolve(entry.path) !== path)?.path
    return {
      ...provenance,
      path,
      scope,
      kind: 'template',
      name,
      description: metadata.description,
      ...(metadata.argumentHint ? { argumentHint: metadata.argumentHint } : {}),
      content: document.content,
      body: document.body,
      revision: document.revision,
      loaded,
      ...(shadowedBy ? { shadowedBy } : {}),
    }
  }

  private safeSkillView(path: string, scope: PackageScope): SkillDocumentView | null {
    const document = this.readLocal({ kind: 'skill', path, root: managedRoot('skill', scope, this.cwd, this.agentDir), scope })
    if (!document) return null
    return this.skillView(path, scope, document, this.findProvenance('skill', path, scope) ?? nativeProvenance(path, scope))
  }

  private safeTemplateView(path: string, scope: PackageScope): TemplateDocumentView | null {
    const document = this.readLocal({ kind: 'template', path, root: managedRoot('template', scope, this.cwd, this.agentDir), scope })
    if (!document) return null
    return this.templateView(path, scope, document, this.findProvenance('template', path, scope) ?? nativeProvenance(path, scope))
  }

  private validateTemplateFrontmatter(frontmatter: Readonly<Record<string, unknown>>, body: string): {
    readonly description: string
    readonly argumentHint?: string
  } {
    const metadata = templateMetadata(frontmatter, body)
    if (metadata.argumentHint && metadata.argumentHint.length > 2048) throw new Error('Prompt template argument-hint is too long.')
    return metadata
  }

  private assertScopeTrusted(scope: PackageScope): void {
    if (scope !== 'project') return
    let trusted = false
    try {
      trusted = this.isProjectTrusted() === true && this.settingsManager.isProjectTrusted()
    } catch {
      trusted = false
    }
    if (!trusted) throw new Error('Project resource operations require live workspace trust.')
  }

  private async reloadResources(): Promise<ResourceReloadResponse['outcome']> {
    try {
      return (await this.resources.reload()).outcome
    } catch {
      return 'failed'
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}
