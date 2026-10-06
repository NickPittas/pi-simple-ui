import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

export const PACKAGES_IPC = Object.freeze({
  list: 'packages.list',
  install: 'packages.install',
  update: 'packages.update',
  remove: 'packages.remove',
  resourcesList: 'resources.list',
  resourcesReload: 'resources.reload',
  skillsRead: 'skills.read',
  skillsCreate: 'skills.create',
  skillsUpdate: 'skills.update',
  skillsDelete: 'skills.delete',
  skillsEnable: 'skills.enable',
  templatesRead: 'templates.read',
  templatesCreate: 'templates.create',
  templatesUpdate: 'templates.update',
  templatesDelete: 'templates.delete',
  templatesEnable: 'templates.enable',
  events: 'packages.events',
})

export type PackageScope = 'user' | 'project'
export type PackageEventScope = PackageScope | 'all'
export type ResourceScope = 'user' | 'project' | 'temporary' | 'unknown'
export type ResourceSource = 'user' | 'project' | 'package' | 'builtin' | 'temporary' | 'unknown'
export type PackageAction = 'install' | 'update' | 'remove'

export function formatPackageCommand(action: PackageAction, source: string, scope?: PackageScope, cwd?: string): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
  const prefix = cwd ? `cd ${quote(cwd)} && ` : ''
  const quotedSource = quote(source)
  if (action === 'update') return `${prefix}pi update --extension ${quotedSource}`
  const local = scope === 'project' ? ' --local' : ''
  return `${prefix}pi ${action} ${quotedSource}${local}`
}

export interface PackageListRequest {}
export interface PackageView {
  readonly source: string
  readonly scope: PackageScope
  readonly filtered: boolean
  readonly installed: boolean
  readonly installedPath?: string
}
export interface PackageListResponse {
  readonly packages: readonly PackageView[]
}

export interface PackageInstallRequest {
  readonly consent: true
  readonly source: string
  readonly scope: PackageScope
}
export interface PackageUpdateRequest {
  readonly consent: true
  readonly source: string
}
export interface PackageRemoveRequest {
  readonly consent: true
  readonly source: string
  readonly scope: PackageScope
}
export interface PackageMutationResponse {
  readonly outcome: 'completed' | 'not-found'
  readonly action: PackageAction
  readonly target: string
  readonly scope: PackageEventScope
  /** Shell-escaped equivalent Pi CLI command shown for consent. */
  readonly command: string
}

export interface ResourceProvenanceView {
  readonly path: string
  readonly source: ResourceSource
  readonly scope: ResourceScope
  /** Native loader's source label, such as `auto` or the configured package source. */
  readonly sourceDetail?: string
}
export interface ExtensionResourceView extends ResourceProvenanceView {
  readonly enabled: boolean
}
/**
 * Additive management facts (all optional so legacy producers still type-check). Native-composition producers always set
 * `loaded` and `writable`, and set `enabled` whenever Pi's native filter state could be computed.
 */
export interface ResourceManagementView {
  /** True only when the running Pi reported this exact file in get_commands (authoritative). False when Pi is not running or did not load it. */
  readonly loaded?: boolean
  /** Result of Pi's native settings filter (`skills` / `prompts` arrays: `-path`, `+path`, `!glob`) for this file. */
  readonly enabled?: boolean
  /** True only for regular (non-symlink) files in the user/project skill or prompt directories this app may edit/delete. */
  readonly writable?: boolean
  readonly readOnlyReason?: string
  /** Path of the loaded resource that wins the name collision when this one is not loaded. */
  readonly shadowedBy?: string
}
export interface SkillResourceView extends ResourceProvenanceView, ResourceManagementView {
  readonly name: string
  readonly description: string
}
export interface PromptTemplateResourceView extends ResourceProvenanceView, ResourceManagementView {
  readonly name: string
  readonly description: string
}
export interface ThemeResourceView extends ResourceProvenanceView {
  readonly name: string
}
export interface ContextFileResourceView extends ResourceProvenanceView {
  readonly name: string
}

export interface ResourceListRequest {}
export interface ResourceListResponse {
  readonly generation: number
  readonly loading: boolean
  readonly extensions: readonly ExtensionResourceView[]
  readonly skills: readonly SkillResourceView[]
  readonly promptTemplates: readonly PromptTemplateResourceView[]
  readonly themes: readonly ThemeResourceView[]
  readonly contextFiles: readonly ContextFileResourceView[]
}

export interface ResourceReloadRequest {}
export interface ResourceReloadResponse {
  readonly outcome: 'reloaded' | 'failed' | 'superseded' | 'busy'
  readonly generation: number
}

export type PackagesEventPayload =
  | {
      readonly type: 'package-progress'
      readonly operationId: string
      readonly action: PackageAction
      readonly target: string
      readonly scope: PackageEventScope
      readonly command: string
      readonly phase: 'started' | 'progress' | 'completed' | 'failed'
      readonly message?: string
    }
  | {
      readonly type: 'resources-reload'
      readonly generation: number
      readonly phase: 'started' | 'completed' | 'failed'
      readonly message?: string
    }

export interface PackagesCapabilities extends SkillTemplateCapabilities {
  'packages.list': { readonly request: PackageListRequest; readonly response: PackageListResponse }
  'packages.install': { readonly request: PackageInstallRequest; readonly response: PackageMutationResponse }
  'packages.update': { readonly request: PackageUpdateRequest; readonly response: PackageMutationResponse }
  'packages.remove': { readonly request: PackageRemoveRequest; readonly response: PackageMutationResponse }
  'resources.list': { readonly request: ResourceListRequest; readonly response: ResourceListResponse }
  'resources.reload': { readonly request: ResourceReloadRequest; readonly response: ResourceReloadResponse }
}

export interface ScopedResourceReadRequest {
  readonly scope: PackageScope
  readonly path: string
}

export interface SkillReadRequest extends ScopedResourceReadRequest {}
export interface SkillCreateRequest {
  readonly scope: PackageScope
  readonly name: string
  readonly description: string
  readonly body: string
  readonly disableModelInvocation?: boolean
}
export interface SkillUpdateRequest extends ScopedResourceReadRequest {
  readonly expectedRevision: string
  /** Merged into existing YAML frontmatter so omitted native/unknown keys survive. */
  readonly frontmatter: Readonly<Record<string, unknown>>
  readonly body: string
}
export interface SkillDeleteRequest extends ScopedResourceReadRequest {
  readonly expectedRevision: string
}
export interface SkillEnableRequest extends ScopedResourceReadRequest {
  readonly enabled: boolean
}

export interface TemplateReadRequest extends ScopedResourceReadRequest {}
export interface TemplateCreateRequest {
  readonly scope: PackageScope
  readonly name: string
  readonly frontmatter: Readonly<Record<string, unknown>>
  readonly body: string
}
export interface TemplateUpdateRequest extends ScopedResourceReadRequest {
  readonly expectedRevision: string
  /** Merged into existing YAML frontmatter so omitted native/unknown keys survive. */
  readonly frontmatter: Readonly<Record<string, unknown>>
  readonly body: string
}
export interface TemplateDeleteRequest extends ScopedResourceReadRequest {
  readonly expectedRevision: string
}

export interface SkillDocumentView extends ResourceProvenanceView {
  readonly enabled?: boolean
  readonly writable?: boolean
  readonly readOnlyReason?: string
  /** Raw YAML between the `---` fences (unparsed, so unknown keys such as license/compatibility/metadata/allowed-tools are visible). */
  readonly frontmatterRaw?: string
  readonly kind: 'skill'
  readonly name: string
  readonly description: string
  readonly disableModelInvocation: boolean
  readonly content: string
  readonly body: string
  readonly revision: string
  /** True when present in the live loader's effective resource set. */
  readonly loaded: boolean
  readonly shadowedBy?: string
}
export interface TemplateDocumentView extends ResourceProvenanceView {
  readonly enabled?: boolean
  readonly writable?: boolean
  readonly readOnlyReason?: string
  readonly frontmatterRaw?: string
  readonly kind: 'template'
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
  readonly content: string
  readonly body: string
  readonly revision: string
  /** True when present in the live loader's effective resource set. */
  readonly loaded: boolean
  readonly shadowedBy?: string
}

export interface SkillMutationResponse {
  readonly outcome: 'saved' | 'conflict' | 'not-found'
  readonly item: SkillDocumentView | null
  readonly reloadOutcome?: ResourceReloadResponse['outcome']
  /** Native composition: Pi has no RPC reload, so a saved change takes effect only after the Pi runtime restarts (native.pi.restart). */
  readonly restartRequired?: boolean
}
export interface TemplateMutationResponse {
  readonly outcome: 'saved' | 'conflict' | 'not-found'
  readonly item: TemplateDocumentView | null
  readonly reloadOutcome?: ResourceReloadResponse['outcome']
  readonly restartRequired?: boolean
}
export interface TemplateEnableRequest extends ScopedResourceReadRequest {
  readonly enabled: boolean
}
export interface TemplateEnableResponse {
  readonly outcome: 'saved' | 'unchanged' | 'not-found'
  readonly scope: PackageScope
  readonly path: string
  readonly enabled: boolean
  readonly semantics: 'native-prompt-filter'
  readonly reloadOutcome?: ResourceReloadResponse['outcome']
  readonly restartRequired?: boolean
}
export interface SkillEnableResponse {
  readonly outcome: 'saved' | 'unchanged' | 'not-found'
  readonly scope: PackageScope
  readonly path: string
  readonly enabled: boolean
  readonly semantics: 'native-skill-filter'
  readonly globalSkillCommandsEnabled: boolean
  readonly reloadOutcome?: ResourceReloadResponse['outcome']
  readonly restartRequired?: boolean
}

export interface SkillTemplateCapabilities {
  'skills.read': { readonly request: SkillReadRequest; readonly response: SkillDocumentView }
  'skills.create': { readonly request: SkillCreateRequest; readonly response: SkillMutationResponse }
  'skills.update': { readonly request: SkillUpdateRequest; readonly response: SkillMutationResponse }
  'skills.delete': { readonly request: SkillDeleteRequest; readonly response: SkillMutationResponse }
  'skills.enable': { readonly request: SkillEnableRequest; readonly response: SkillEnableResponse }
  'templates.read': { readonly request: TemplateReadRequest; readonly response: TemplateDocumentView }
  'templates.create': { readonly request: TemplateCreateRequest; readonly response: TemplateMutationResponse }
  'templates.update': { readonly request: TemplateUpdateRequest; readonly response: TemplateMutationResponse }
  'templates.delete': { readonly request: TemplateDeleteRequest; readonly response: TemplateMutationResponse }
  'templates.enable': { readonly request: TemplateEnableRequest; readonly response: TemplateEnableResponse }
}

export interface PackagesEventContracts {
  'packages.events': { readonly payload: PackagesEventPayload }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends PackagesCapabilities {}
  interface IpcEventContracts extends PackagesEventContracts {}
}

const MAX_MARKDOWN_LENGTH = 1024 * 1024
const UNSAFE_FRONTMATTER_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isResourcePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
}

function isSkillName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

function isTemplateName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isFrontmatterValue(value: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return typeof value !== 'string' || value.length <= 16_384
  }
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 512 && value.every((entry) => isFrontmatterValue(entry, depth + 1))
  if (!isPlainRecord(value) || Object.keys(value).length > 256) return false
  return Object.entries(value).every(([key, entry]) => key.length > 0 && key.length <= 128
    && !UNSAFE_FRONTMATTER_KEYS.has(key) && isFrontmatterValue(entry, depth + 1))
}

function isFrontmatter(value: unknown): value is Readonly<Record<string, unknown>> {
  return isPlainRecord(value) && Object.keys(value).length <= 256 && isFrontmatterValue(value)
}

function isMarkdownBody(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_MARKDOWN_LENGTH && !value.includes('\0')
}

function isScopedPathRequest(value: unknown): value is ScopedResourceReadRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['scope', 'path'])
    && isPackageScope(value.scope) && isResourcePath(value.path)
}

export function isSkillReadRequest(value: unknown): value is SkillReadRequest {
  return isScopedPathRequest(value)
}

export function isSkillCreateRequest(value: unknown): value is SkillCreateRequest {
  if (!isPlainRecord(value)) return false
  const keys = Object.hasOwn(value, 'disableModelInvocation')
    ? ['scope', 'name', 'description', 'body', 'disableModelInvocation']
    : ['scope', 'name', 'description', 'body']
  return hasExactKeys(value, keys)
    && isPackageScope(value.scope) && isSkillName(value.name)
    && typeof value.description === 'string' && value.description.trim().length > 0 && value.description.length <= 1024
    && isMarkdownBody(value.body)
    && (!Object.hasOwn(value, 'disableModelInvocation') || typeof value.disableModelInvocation === 'boolean')
}

export function isSkillUpdateRequest(value: unknown): value is SkillUpdateRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['scope', 'path', 'expectedRevision', 'frontmatter', 'body'])
    && isPackageScope(value.scope) && isResourcePath(value.path)
    && isRevision(value.expectedRevision) && isFrontmatter(value.frontmatter) && isMarkdownBody(value.body)
}

export function isSkillDeleteRequest(value: unknown): value is SkillDeleteRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['scope', 'path', 'expectedRevision'])
    && isPackageScope(value.scope) && isResourcePath(value.path) && isRevision(value.expectedRevision)
}

export function isSkillEnableRequest(value: unknown): value is SkillEnableRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['scope', 'path', 'enabled'])
    && isPackageScope(value.scope) && isResourcePath(value.path) && typeof value.enabled === 'boolean'
}

export function isTemplateReadRequest(value: unknown): value is TemplateReadRequest {
  return isScopedPathRequest(value)
}

export function isTemplateCreateRequest(value: unknown): value is TemplateCreateRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['scope', 'name', 'frontmatter', 'body'])
    && isPackageScope(value.scope) && isTemplateName(value.name)
    && isFrontmatter(value.frontmatter) && isMarkdownBody(value.body)
}

export function isTemplateUpdateRequest(value: unknown): value is TemplateUpdateRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['scope', 'path', 'expectedRevision', 'frontmatter', 'body'])
    && isPackageScope(value.scope) && isResourcePath(value.path)
    && isRevision(value.expectedRevision) && isFrontmatter(value.frontmatter) && isMarkdownBody(value.body)
}

export function isTemplateEnableRequest(value: unknown): value is TemplateEnableRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['scope', 'path', 'enabled'])
    && isPackageScope(value.scope) && isResourcePath(value.path) && typeof value.enabled === 'boolean'
}

export function isTemplateDeleteRequest(value: unknown): value is TemplateDeleteRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['scope', 'path', 'expectedRevision'])
    && isPackageScope(value.scope) && isResourcePath(value.path) && isRevision(value.expectedRevision)
}

function isPackageScope(value: unknown): value is PackageScope {
  return value === 'user' || value === 'project'
}

function isPackageSource(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048
    && !/[\0\r\n]/.test(value)
}

function isEmptyRequest(value: unknown): boolean {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

export function isPackageListRequest(value: unknown): value is PackageListRequest {
  return isEmptyRequest(value)
}

export function isPackageInstallRequest(value: unknown): value is PackageInstallRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['consent', 'source', 'scope'])
    && value.consent === true && isPackageSource(value.source) && isPackageScope(value.scope)
}

export function isPackageUpdateRequest(value: unknown): value is PackageUpdateRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['consent', 'source'])
    && value.consent === true && isPackageSource(value.source)
}

export function isPackageRemoveRequest(value: unknown): value is PackageRemoveRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['consent', 'source', 'scope'])
    && value.consent === true && isPackageSource(value.source) && isPackageScope(value.scope)
}

export function isPackageView(value: unknown): value is PackageView {
  if (!isPlainRecord(value)) return false
  const keys = Object.hasOwn(value, 'installedPath')
    ? ['source', 'scope', 'filtered', 'installed', 'installedPath']
    : ['source', 'scope', 'filtered', 'installed']
  return hasExactKeys(value, keys)
    && isPackageSource(value.source)
    && isPackageScope(value.scope)
    && typeof value.filtered === 'boolean'
    && typeof value.installed === 'boolean'
    && (!Object.hasOwn(value, 'installedPath')
      || typeof value.installedPath === 'string' && value.installedPath.length > 0 && value.installedPath.length <= 4096)
}

export function isPackageListResponse(value: unknown): value is PackageListResponse {
  return isPlainRecord(value) && hasExactKeys(value, ['packages'])
    && Array.isArray(value.packages) && value.packages.length <= 2048 && value.packages.every(isPackageView)
}

function isEventScope(value: unknown): value is PackageEventScope {
  return value === 'user' || value === 'project' || value === 'all'
}

export function isPackageMutationResponse(value: unknown): value is PackageMutationResponse {
  return isPlainRecord(value) && hasExactKeys(value, ['outcome', 'action', 'target', 'scope', 'command'])
    && (value.outcome === 'completed' || value.outcome === 'not-found')
    && (value.action === 'install' || value.action === 'update' || value.action === 'remove')
    && isPackageSource(value.target)
    && isEventScope(value.scope)
    && typeof value.command === 'string' && value.command.length > 0 && value.command.length <= 4096
}

export function isResourceListRequest(value: unknown): value is ResourceListRequest {
  return isEmptyRequest(value)
}

export function isResourceReloadRequest(value: unknown): value is ResourceReloadRequest {
  return isEmptyRequest(value)
}

export function isResourceReloadResponse(value: unknown): value is ResourceReloadResponse {
  return isPlainRecord(value) && hasExactKeys(value, ['outcome', 'generation'])
    && ['reloaded', 'failed', 'superseded', 'busy'].includes(String(value.outcome))
    && Number.isSafeInteger(value.generation) && (value.generation as number) >= 0
}

function isResourceScope(value: unknown): value is ResourceScope {
  return value === 'user' || value === 'project' || value === 'temporary' || value === 'unknown'
}

function isResourceSource(value: unknown): value is ResourceSource {
  return value === 'user' || value === 'project' || value === 'package' || value === 'builtin'
    || value === 'temporary' || value === 'unknown'
}

function isResourceProvenance(value: unknown): value is ResourceProvenanceView {
  if (!isPlainRecord(value)) return false
  const keys = Object.hasOwn(value, 'sourceDetail')
    ? ['path', 'source', 'scope', 'sourceDetail']
    : ['path', 'source', 'scope']
  return hasExactKeys(value, keys)
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
    && isResourceSource(value.source)
    && isResourceScope(value.scope)
    && (!Object.hasOwn(value, 'sourceDetail')
      || typeof value.sourceDetail === 'string' && value.sourceDetail.length <= 2048)
}

export function isExtensionResourceView(value: unknown): value is ExtensionResourceView {
  return isPlainRecord(value) && hasExactKeys(value, Object.hasOwn(value, 'sourceDetail')
    ? ['path', 'source', 'scope', 'sourceDetail', 'enabled']
    : ['path', 'source', 'scope', 'enabled'])
    && isResourceProvenance(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'enabled')))
    && typeof value.enabled === 'boolean'
}

const MANAGEMENT_KEYS = ['loaded', 'enabled', 'writable', 'readOnlyReason', 'shadowedBy'] as const

function isManagementFields(value: Record<string, unknown>): boolean {
  return (!Object.hasOwn(value, 'loaded') || typeof value.loaded === 'boolean')
    && (!Object.hasOwn(value, 'enabled') || typeof value.enabled === 'boolean')
    && (!Object.hasOwn(value, 'writable') || typeof value.writable === 'boolean')
    && (!Object.hasOwn(value, 'readOnlyReason') || (typeof value.readOnlyReason === 'string' && value.readOnlyReason.length <= 512))
    && (!Object.hasOwn(value, 'shadowedBy') || isResourcePath(value.shadowedBy))
}

function isNamedResource(value: unknown, includeDescription: boolean, allowManagement = false): boolean {
  if (!isPlainRecord(value)) return false
  const provenanceKeys = Object.hasOwn(value, 'sourceDetail')
    ? ['path', 'source', 'scope', 'sourceDetail']
    : ['path', 'source', 'scope']
  const management = allowManagement ? MANAGEMENT_KEYS.filter((key) => Object.hasOwn(value, key)) : []
  const keys = [...(includeDescription ? [...provenanceKeys, 'name', 'description'] : [...provenanceKeys, 'name']), ...management]
  return hasExactKeys(value, keys)
    && (!allowManagement || isManagementFields(value))
    && isResourceProvenance(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'name' && key !== 'description' && !(MANAGEMENT_KEYS as readonly string[]).includes(key))))
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 1024
    && (!includeDescription || typeof value.description === 'string' && value.description.length <= 8192)
}

export function isSkillResourceView(value: unknown): value is SkillResourceView {
  return isNamedResource(value, true, true)
}

export function isPromptTemplateResourceView(value: unknown): value is PromptTemplateResourceView {
  return isNamedResource(value, true, true)
}

export function isThemeResourceView(value: unknown): value is ThemeResourceView {
  return isNamedResource(value, false)
}

export function isContextFileResourceView(value: unknown): value is ContextFileResourceView {
  return isNamedResource(value, false)
}

export function isResourceListResponse(value: unknown): value is ResourceListResponse {
  return isPlainRecord(value) && hasExactKeys(value, [
    'generation', 'loading', 'extensions', 'skills', 'promptTemplates', 'themes', 'contextFiles',
  ])
    && Number.isSafeInteger(value.generation) && (value.generation as number) >= 0
    && typeof value.loading === 'boolean'
    && Array.isArray(value.extensions) && value.extensions.length <= 4096 && value.extensions.every(isExtensionResourceView)
    && Array.isArray(value.skills) && value.skills.length <= 4096 && value.skills.every(isSkillResourceView)
    && Array.isArray(value.promptTemplates) && value.promptTemplates.length <= 4096 && value.promptTemplates.every(isPromptTemplateResourceView)
    && Array.isArray(value.themes) && value.themes.length <= 4096 && value.themes.every(isThemeResourceView)
    && Array.isArray(value.contextFiles) && value.contextFiles.length <= 4096 && value.contextFiles.every(isContextFileResourceView)
}

export function isPackagesEventPayload(value: unknown): value is PackagesEventPayload {
  if (!isPlainRecord(value)) return false
  if (value.type === 'package-progress') {
    const keys = Object.hasOwn(value, 'message')
      ? ['type', 'operationId', 'action', 'target', 'scope', 'command', 'phase', 'message']
      : ['type', 'operationId', 'action', 'target', 'scope', 'command', 'phase']
    return hasExactKeys(value, keys)
      && typeof value.operationId === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(value.operationId)
      && (value.action === 'install' || value.action === 'update' || value.action === 'remove')
      && isPackageSource(value.target) && isEventScope(value.scope)
      && typeof value.command === 'string' && value.command.length > 0 && value.command.length <= 4096
      && ['started', 'progress', 'completed', 'failed'].includes(String(value.phase))
      && (!Object.hasOwn(value, 'message') || typeof value.message === 'string' && value.message.length <= 8192)
  }
  if (value.type === 'resources-reload') {
    const keys = Object.hasOwn(value, 'message')
      ? ['type', 'generation', 'phase', 'message']
      : ['type', 'generation', 'phase']
    return hasExactKeys(value, keys)
      && Number.isSafeInteger(value.generation) && (value.generation as number) >= 0
      && ['started', 'completed', 'failed'].includes(String(value.phase))
      && (!Object.hasOwn(value, 'message') || typeof value.message === 'string' && value.message.length <= 8192)
  }
  return false
}

function isDocumentProvenance(value: Record<string, unknown>): boolean {
  const keys = Object.hasOwn(value, 'sourceDetail')
    ? ['path', 'source', 'scope', 'sourceDetail']
    : ['path', 'source', 'scope']
  return hasExactKeys(value, keys)
    && isResourcePath(value.path)
    && isResourceSource(value.source)
    && isResourceScope(value.scope)
    && (!Object.hasOwn(value, 'sourceDetail')
      || typeof value.sourceDetail === 'string' && value.sourceDetail.length <= 2048)
}

const DOCUMENT_EXTRA_KEYS = ['enabled', 'writable', 'readOnlyReason', 'frontmatterRaw'] as const

function isDocumentExtras(value: Record<string, unknown>): boolean {
  return (!Object.hasOwn(value, 'enabled') || typeof value.enabled === 'boolean')
    && (!Object.hasOwn(value, 'writable') || typeof value.writable === 'boolean')
    && (!Object.hasOwn(value, 'readOnlyReason') || (typeof value.readOnlyReason === 'string' && value.readOnlyReason.length <= 512))
    && (!Object.hasOwn(value, 'frontmatterRaw') || (typeof value.frontmatterRaw === 'string' && value.frontmatterRaw.length <= MAX_MARKDOWN_LENGTH))
}

function isDocumentMetadata(value: Record<string, unknown>, kind: 'skill' | 'template'): boolean {
  if (value.kind !== kind
    || typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 1024
    || typeof value.description !== 'string' || value.description.length > 8192
    || typeof value.content !== 'string' || value.content.length > MAX_MARKDOWN_LENGTH
    || typeof value.body !== 'string' || value.body.length > MAX_MARKDOWN_LENGTH
    || !isRevision(value.revision)
    || typeof value.loaded !== 'boolean') return false
  return (!Object.hasOwn(value, 'shadowedBy') || isResourcePath(value.shadowedBy))
}

export function isSkillDocumentView(value: unknown): value is SkillDocumentView {
  if (!isPlainRecord(value)) return false
  const keys = [
    'path', 'source', 'scope', ...(Object.hasOwn(value, 'sourceDetail') ? ['sourceDetail'] : []),
    'kind', 'name', 'description', 'disableModelInvocation', 'content', 'body', 'revision', 'loaded',
    ...(Object.hasOwn(value, 'shadowedBy') ? ['shadowedBy'] : []),
    ...DOCUMENT_EXTRA_KEYS.filter((key) => Object.hasOwn(value, key)),
  ]
  const provenance = Object.fromEntries(Object.entries(value).filter(([key]) =>
    ['path', 'source', 'scope', 'sourceDetail'].includes(key)))
  return hasExactKeys(value, keys)
    && isDocumentProvenance(provenance)
    && isDocumentMetadata(value, 'skill') && isDocumentExtras(value)
    && typeof value.disableModelInvocation === 'boolean'
}

export function isTemplateDocumentView(value: unknown): value is TemplateDocumentView {
  if (!isPlainRecord(value)) return false
  const keys = [
    'path', 'source', 'scope', ...(Object.hasOwn(value, 'sourceDetail') ? ['sourceDetail'] : []),
    'kind', 'name', 'description', ...(Object.hasOwn(value, 'argumentHint') ? ['argumentHint'] : []),
    'content', 'body', 'revision', 'loaded', ...(Object.hasOwn(value, 'shadowedBy') ? ['shadowedBy'] : []),
    ...DOCUMENT_EXTRA_KEYS.filter((key) => Object.hasOwn(value, key)),
  ]
  const provenance = Object.fromEntries(Object.entries(value).filter(([key]) =>
    ['path', 'source', 'scope', 'sourceDetail'].includes(key)))
  return hasExactKeys(value, keys)
    && isDocumentProvenance(provenance)
    && isDocumentMetadata(value, 'template') && isDocumentExtras(value)
    && (!Object.hasOwn(value, 'argumentHint')
      || typeof value.argumentHint === 'string' && value.argumentHint.length <= 2048)
}

function isReloadOutcome(value: unknown): value is ResourceReloadResponse['outcome'] {
  return value === 'reloaded' || value === 'failed' || value === 'superseded' || value === 'busy'
}

export function isSkillMutationResponse(value: unknown): value is SkillMutationResponse {
  if (!isPlainRecord(value)) return false
  const keys = ['outcome', 'item', ...(Object.hasOwn(value, 'reloadOutcome') ? ['reloadOutcome'] : []), ...(Object.hasOwn(value, 'restartRequired') ? ['restartRequired'] : [])]
  return hasExactKeys(value, keys)
    && (value.outcome === 'saved' || value.outcome === 'conflict' || value.outcome === 'not-found')
    && (value.item === null || isSkillDocumentView(value.item))
    && (!Object.hasOwn(value, 'reloadOutcome') || isReloadOutcome(value.reloadOutcome))
    && (!Object.hasOwn(value, 'restartRequired') || typeof value.restartRequired === 'boolean')
}

export function isTemplateMutationResponse(value: unknown): value is TemplateMutationResponse {
  if (!isPlainRecord(value)) return false
  const keys = ['outcome', 'item', ...(Object.hasOwn(value, 'reloadOutcome') ? ['reloadOutcome'] : []), ...(Object.hasOwn(value, 'restartRequired') ? ['restartRequired'] : [])]
  return hasExactKeys(value, keys)
    && (value.outcome === 'saved' || value.outcome === 'conflict' || value.outcome === 'not-found')
    && (value.item === null || isTemplateDocumentView(value.item))
    && (!Object.hasOwn(value, 'reloadOutcome') || isReloadOutcome(value.reloadOutcome))
    && (!Object.hasOwn(value, 'restartRequired') || typeof value.restartRequired === 'boolean')
}

export function isSkillEnableResponse(value: unknown): value is SkillEnableResponse {
  if (!isPlainRecord(value)) return false
  const keys = [
    'outcome', 'scope', 'path', 'enabled', 'semantics', 'globalSkillCommandsEnabled',
    ...(Object.hasOwn(value, 'reloadOutcome') ? ['reloadOutcome'] : []),
    ...(Object.hasOwn(value, 'restartRequired') ? ['restartRequired'] : []),
  ]
  return hasExactKeys(value, keys)
    && (!Object.hasOwn(value, 'restartRequired') || typeof value.restartRequired === 'boolean')
    && (value.outcome === 'saved' || value.outcome === 'unchanged' || value.outcome === 'not-found')
    && isPackageScope(value.scope) && isResourcePath(value.path) && typeof value.enabled === 'boolean'
    && value.semantics === 'native-skill-filter' && typeof value.globalSkillCommandsEnabled === 'boolean'
    && (!Object.hasOwn(value, 'reloadOutcome') || isReloadOutcome(value.reloadOutcome))
}

export function isTemplateEnableResponse(value: unknown): value is TemplateEnableResponse {
  if (!isPlainRecord(value)) return false
  const keys = [
    'outcome', 'scope', 'path', 'enabled', 'semantics',
    ...(Object.hasOwn(value, 'reloadOutcome') ? ['reloadOutcome'] : []),
    ...(Object.hasOwn(value, 'restartRequired') ? ['restartRequired'] : []),
  ]
  return hasExactKeys(value, keys)
    && (value.outcome === 'saved' || value.outcome === 'unchanged' || value.outcome === 'not-found')
    && isPackageScope(value.scope) && isResourcePath(value.path) && typeof value.enabled === 'boolean'
    && value.semantics === 'native-prompt-filter'
    && (!Object.hasOwn(value, 'reloadOutcome') || isReloadOutcome(value.reloadOutcome))
    && (!Object.hasOwn(value, 'restartRequired') || typeof value.restartRequired === 'boolean')
}
