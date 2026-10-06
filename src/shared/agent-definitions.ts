import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

export const AGENT_DEFINITIONS_IPC = Object.freeze({
  list: 'agents.definitions.list',
  read: 'agents.definitions.read',
  create: 'agents.definitions.create',
  update: 'agents.definitions.update',
  delete: 'agents.definitions.delete',
  enable: 'agents.definitions.enable',
  providers: 'agents.definitions.providers',
} as const)

/** Tintinweb uses the shared agents.definitions.* capability IDs without a provider suffix. */
export const TINTINWEB_AGENT_DEFINITIONS_PROVIDER = 'tintinweb' as const
export const TINTINWEB_AGENT_DEFINITIONS_IPC = AGENT_DEFINITIONS_IPC
export const NICOBAILON_AGENT_DEFINITIONS_PROVIDER = 'nicobailon' as const

export type AgentDefinitionScope = 'user' | 'project' | 'workspace' | 'bundled'
export type AgentDefinitionWriteScope = Exclude<AgentDefinitionScope, 'workspace' | 'bundled'>
export type AgentDefinitionListScope = 'all' | AgentDefinitionScope
export const AGENT_DEFINITION_PROVIDERS = Object.freeze([TINTINWEB_AGENT_DEFINITIONS_PROVIDER, NICOBAILON_AGENT_DEFINITIONS_PROVIDER, 'herdr'] as const)
export type AgentDefinitionProvider = (typeof AGENT_DEFINITION_PROVIDERS)[number]

/** Supported native frontmatter names and values. Unknown native fields are retained on writes. */
export interface AgentDefinitionFields {
  readonly name?: string
  readonly display_name?: string
  readonly color?: string
  readonly description?: string
  /** pi-herdr-agents agent/role native fields. */
  readonly 'system-prompt'?: string
  readonly 'deny-tools'?: string
  readonly spawning?: boolean
  readonly persistent?: boolean
  readonly 'auto-exit'?: boolean
  readonly 'session-mode'?: string
  readonly cwd?: string
  readonly 'disable-model-invocation'?: boolean
  readonly tools?: string | readonly string[]
  readonly disallowed_tools?: string | readonly string[]
  /** nicobailon/pi-subagents native camelCase frontmatter fields. */
  readonly package?: string | false
  readonly advertise?: boolean
  readonly alias?: string | readonly string[]
  readonly aliases?: string | readonly string[]
  readonly excludeTools?: string | readonly string[]
  readonly allowNestedSubagents?: boolean
  readonly allowedAgents?: string | readonly string[]
  readonly fast?: boolean
  readonly systemPromptMode?: string
  readonly inheritProjectContext?: boolean
  readonly inheritGlobalContext?: boolean
  readonly inheritSkills?: boolean
  readonly defaultContext?: string
  readonly async?: boolean
  readonly timeoutMs?: number
  readonly toolTimeoutMs?: number
  readonly acceptance?: string | Readonly<Record<string, unknown>>
  readonly acceptanceRole?: string
  readonly skill?: string | readonly string[]
  readonly skillPath?: string | readonly string[]
  readonly subagentOnlyExtensions?: string | readonly string[]
  readonly mutationTools?: string | readonly string[]
  readonly machine?: string
  readonly output?: string
  readonly outputMode?: string
  readonly outputSchema?: string | Readonly<Record<string, unknown>>
  readonly defaultReads?: string | readonly string[]
  readonly defaultProgress?: boolean
  readonly interactive?: boolean
  readonly maxSubagentDepth?: number
  readonly toolBudget?: string | Readonly<Record<string, unknown>>
  readonly permission?: string | Readonly<Record<string, unknown>>
  readonly permissions?: string | Readonly<Record<string, unknown>>
  readonly runner?: string | Readonly<Record<string, unknown>>
  readonly extensions?: boolean | string | readonly string[]
  readonly inherit_extensions?: boolean | string | readonly string[]
  readonly exclude_extensions?: string | readonly string[]
  readonly skills?: boolean | string | readonly string[]
  readonly inherit_skills?: boolean | string | readonly string[]
  readonly model?: string
  readonly thinking?: string | false
  readonly max_turns?: number
  readonly persist_session?: boolean
  readonly output_transcript?: boolean
  readonly session_dir?: string
  readonly allowed_subagents?: boolean | string | readonly string[]
  readonly prompt_mode?: string
  readonly inherit_context?: boolean
  readonly run_in_background?: boolean
  readonly isolated?: boolean
  readonly memory?: string | Readonly<Record<string, unknown>>
  readonly isolation?: string | boolean
  readonly enabled?: boolean
}

export interface AgentDefinitionValidationIssue {
  readonly code: 'invalid-frontmatter' | 'reserved-name' | 'invalid-name' | 'duplicate-name' | 'invalid-fields' | 'missing-frontmatter'
  readonly message: string
  readonly field?: string
}

export interface AgentDefinition {
  /** Stable, scope-qualified base64url file identifier, such as `project~cmV2aWV3ZXIubWQ`. */
  readonly id: string
  /** Provider-specific native parser and persistence behavior. Older records omit this and mean tintinweb. */
  readonly provider?: AgentDefinitionProvider
  /** Herdr's conceptual file kind (its native parser treats agent and role as the same markdown role). */
  readonly kind?: 'agent' | 'task' | 'role'
  /** Native agent type (`name:`), falling back to the filename. */
  readonly name: string
  readonly fileName: string
  readonly scope: AgentDefinitionScope
  readonly provenance: AgentDefinitionScope
  readonly shadowed: boolean
  readonly revision: number
  readonly fields: AgentDefinitionFields
  readonly prompt: string
  readonly enabled: boolean
  readonly valid: boolean
  readonly validationIssues: readonly AgentDefinitionValidationIssue[]
  /** Native source path (absolute for Herdr; root-relative for file-backed providers). */
  readonly path?: string
  readonly nativeFields?: readonly string[]
  readonly disableSemantics?: 'native-model-invocation' | 'app-dispatch-only'
  readonly editable?: boolean
}

export interface AgentDefinitionListRequest {
  readonly scope?: AgentDefinitionListScope
  readonly provider?: AgentDefinitionProvider
  readonly kind?: 'agent' | 'task' | 'role'
}

export interface AgentDefinitionListResponse {
  readonly definitions: readonly AgentDefinition[]
  /** False means project and workspace files were withheld because the project is untrusted. */
  readonly projectAvailable: boolean
}

export interface AgentDefinitionReadRequest { readonly id: string; readonly provider?: AgentDefinitionProvider }
export interface AgentDefinitionReadResponse {
  readonly definition: AgentDefinition | null
  readonly projectAvailable: boolean
  readonly validationIssues: readonly AgentDefinitionValidationIssue[]
}

export interface AgentDefinitionCreateRequest {
  readonly provider?: AgentDefinitionProvider
  readonly scope: AgentDefinitionWriteScope
  readonly kind?: 'agent' | 'task' | 'role'
  readonly expectedRevision: number
  readonly fields: AgentDefinitionFields & { readonly name: string }
  readonly prompt: string
}

export interface AgentDefinitionUpdateRequest {
  readonly provider?: AgentDefinitionProvider
  readonly id: string
  readonly expectedRevision: number
  readonly fields: AgentDefinitionFields
  readonly clearFields?: readonly (keyof AgentDefinitionFields)[]
  readonly prompt?: string
}

export interface AgentDefinitionDeleteRequest {
  readonly provider?: AgentDefinitionProvider
  readonly id: string
  readonly expectedRevision: number
}

export interface AgentDefinitionEnableRequest {
  readonly provider?: AgentDefinitionProvider
  readonly id: string
  readonly expectedRevision: number
  readonly enabled: boolean
}

export interface AgentDefinitionMutationResponse {
  readonly status: 'saved' | 'conflict' | 'invalid' | 'not-found' | 'unavailable' | 'read-only'
  readonly definition: AgentDefinition | null
  readonly currentRevision: number | null
  readonly validationIssues: readonly AgentDefinitionValidationIssue[]
}

export interface AgentDefinitionCapabilityContracts {
  'agents.definitions.list': { readonly request: AgentDefinitionListRequest; readonly response: AgentDefinitionListResponse }
  'agents.definitions.read': { readonly request: AgentDefinitionReadRequest; readonly response: AgentDefinitionReadResponse }
  'agents.definitions.create': { readonly request: AgentDefinitionCreateRequest; readonly response: AgentDefinitionMutationResponse }
  'agents.definitions.update': { readonly request: AgentDefinitionUpdateRequest; readonly response: AgentDefinitionMutationResponse }
  'agents.definitions.delete': { readonly request: AgentDefinitionDeleteRequest; readonly response: AgentDefinitionMutationResponse }
  'agents.definitions.enable': { readonly request: AgentDefinitionEnableRequest; readonly response: AgentDefinitionMutationResponse }
  'agents.definitions.providers': { readonly request: Record<string, never>; readonly response: AgentDefinitionProvidersResponse }
}

/** Providers whose extension is installed and enabled for the active Pi configuration. */
export interface AgentDefinitionProvidersResponse {
  readonly providers: readonly AgentDefinitionProvider[]
}

export function isAgentDefinitionProvidersRequest(value: unknown): value is Record<string, never> {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

export function isAgentDefinitionProvidersResponse(value: unknown): value is AgentDefinitionProvidersResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['providers'])
    && Array.isArray(value.providers)
    && value.providers.length <= AGENT_DEFINITION_PROVIDERS.length
    && value.providers.every((provider) => AGENT_DEFINITION_PROVIDERS.includes(provider as AgentDefinitionProvider))
}

const MAX_DEFINITIONS = 500
const MAX_NAME = 256
const MAX_PROMPT = 1024 * 1024
const MAX_STRING_FIELD = 8192
const MAX_LIST_ENTRIES = 256
const MAX_REVISION = Number.MAX_SAFE_INTEGER
const MUTABLE_SCOPES: readonly string[] = ['user', 'project']
const ALL_SCOPES: readonly string[] = ['user', 'project', 'workspace', 'bundled']
const LIST_SCOPES: readonly string[] = ['all', ...ALL_SCOPES]
const FRONTMATTER_KEYS = [
  'name', 'display_name', 'color', 'description', 'tools', 'disallowed_tools', 'extensions',
  'inherit_extensions', 'exclude_extensions', 'skills', 'inherit_skills', 'model', 'thinking',
  'max_turns', 'persist_session', 'output_transcript', 'session_dir', 'allowed_subagents',
  'prompt_mode', 'inherit_context', 'run_in_background', 'isolated', 'memory', 'isolation', 'enabled',
  'package', 'advertise', 'alias', 'aliases', 'excludeTools', 'allowNestedSubagents', 'allowedAgents',
  'fast', 'systemPromptMode', 'inheritProjectContext', 'inheritGlobalContext', 'inheritSkills',
  'defaultContext', 'async', 'timeoutMs', 'toolTimeoutMs', 'acceptance', 'acceptanceRole', 'skill',
  'skillPath', 'subagentOnlyExtensions', 'mutationTools', 'machine', 'output', 'outputMode',
  'outputSchema', 'defaultReads', 'defaultProgress', 'interactive', 'maxSubagentDepth', 'toolBudget',
  'permission', 'permissions', 'runner',
  'system-prompt', 'deny-tools', 'spawning', 'persistent', 'auto-exit', 'session-mode', 'cwd', 'disable-model-invocation',
] as const

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 24) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= MAX_LIST_ENTRIES && value.every((child) => isJsonValue(child, depth + 1))
  if (!isPlainRecord(value)) return false
  return Object.entries(value).length <= MAX_LIST_ENTRIES
    && Object.entries(value).every(([key, child]) => !['__proto__', 'prototype', 'constructor'].includes(key) && isJsonValue(child, depth + 1))
}

function isObjectOrText(value: unknown): boolean {
  return isText(value) || (isPlainRecord(value) && isJsonValue(value))
}

function isProvider(value: unknown): value is AgentDefinitionProvider {
  return AGENT_DEFINITION_PROVIDERS.includes(value as AgentDefinitionProvider)
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_REVISION
}

function isText(value: unknown, maximum = MAX_STRING_FIELD, allowEmpty = true): value is string {
  return typeof value === 'string'
    && value.length <= maximum
    && (allowEmpty || value.trim().length > 0)
    && !value.includes('\0')
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= MAX_LIST_ENTRIES
    && value.every((item) => isText(item, 1024))
}

function isStringOrList(value: unknown): boolean {
  return isText(value) || isStringList(value)
}

function isInheritValue(value: unknown): boolean {
  return typeof value === 'boolean' || isStringOrList(value)
}

function isFields(value: unknown, requireName = false): value is AgentDefinitionFields {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !FRONTMATTER_KEYS.includes(key as (typeof FRONTMATTER_KEYS)[number]))) return false
  if (requireName && (!Object.hasOwn(value, 'name') || !isText(value.name, MAX_NAME))) return false
  const textKeys = [
    'name', 'display_name', 'color', 'description', 'model', 'session_dir', 'prompt_mode',
    'systemPromptMode', 'defaultContext', 'acceptanceRole', 'machine', 'output', 'outputMode', 'system-prompt',
    'session-mode', 'cwd',
  ]
  for (const key of textKeys) if (Object.hasOwn(value, key) && !isText(value[key], key === 'description' ? 4096 : MAX_STRING_FIELD)) return false
  for (const key of ['tools', 'disallowed_tools', 'exclude_extensions', 'alias', 'aliases', 'excludeTools', 'allowedAgents', 'skill', 'skillPath', 'subagentOnlyExtensions', 'mutationTools', 'defaultReads', 'deny-tools']) {
    if (Object.hasOwn(value, key) && !isStringOrList(value[key])) return false
  }
  for (const key of ['extensions', 'inherit_extensions', 'skills', 'inherit_skills', 'allowed_subagents']) {
    if (Object.hasOwn(value, key) && !isInheritValue(value[key])) return false
  }
  if (Object.hasOwn(value, 'max_turns') && (!Number.isSafeInteger(value.max_turns) || (value.max_turns as number) < 0)) return false
  for (const key of [
    'persist_session', 'output_transcript', 'inherit_context', 'run_in_background', 'isolated', 'enabled',
    'advertise', 'allowNestedSubagents', 'fast', 'inheritProjectContext', 'inheritGlobalContext',
    'inheritSkills', 'async', 'defaultProgress', 'interactive', 'spawning', 'persistent', 'auto-exit',
    'disable-model-invocation',
  ]) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') return false
  }
  if (Object.hasOwn(value, 'isolation') && !(typeof value.isolation === 'boolean' || isText(value.isolation))) return false
  if (Object.hasOwn(value, 'thinking') && !(isText(value.thinking) || value.thinking === false)) return false
  if (Object.hasOwn(value, 'package') && !(isText(value.package) || value.package === false)) return false
  if (Object.hasOwn(value, 'memory') && !isObjectOrText(value.memory)) return false
  for (const key of ['timeoutMs', 'toolTimeoutMs', 'maxSubagentDepth']) {
    if (Object.hasOwn(value, key) && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) return false
  }
  for (const key of ['acceptance', 'outputSchema', 'toolBudget', 'permission', 'permissions', 'runner']) {
    if (Object.hasOwn(value, key) && !isObjectOrText(value[key])) return false
  }
  return true
}

function isIssue(value: unknown): value is AgentDefinitionValidationIssue {
  if (!isPlainRecord(value)) return false
  const keys = ['code', 'message', ...(Object.hasOwn(value, 'field') ? ['field'] : [])]
  return hasExactKeys(value, keys)
    && ['invalid-frontmatter', 'reserved-name', 'invalid-name', 'duplicate-name', 'invalid-fields', 'missing-frontmatter'].includes(value.code as string)
    && isText(value.message, 1024, false)
    && (!Object.hasOwn(value, 'field') || isText(value.field, 128, false))
}

function isIssueList(value: unknown): value is readonly AgentDefinitionValidationIssue[] {
  return Array.isArray(value) && value.length <= 100 && value.every(isIssue)
}

function isDefinition(value: unknown): value is AgentDefinition {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      'id', ...(Object.hasOwn(value, 'provider') ? ['provider'] : []), ...(Object.hasOwn(value, 'kind') ? ['kind'] : []),
      'name', 'fileName', 'scope', 'provenance', 'shadowed', 'revision', 'fields', 'prompt', 'enabled', 'valid', 'validationIssues',
      ...(Object.hasOwn(value, 'path') ? ['path'] : []), ...(Object.hasOwn(value, 'nativeFields') ? ['nativeFields'] : []),
      ...(Object.hasOwn(value, 'disableSemantics') ? ['disableSemantics'] : []), ...(Object.hasOwn(value, 'editable') ? ['editable'] : []),
    ])
    && isText(value.id, 400, false)
    && (!Object.hasOwn(value, 'provider') || isProvider(value.provider))
    && isId(value.id, value.provider)
    && (!Object.hasOwn(value, 'kind') || ['agent', 'task', 'role'].includes(value.kind as string))
    && isText(value.name, MAX_NAME, false)
    && isText(value.fileName, 255, false)
    && value.fileName.endsWith('.md')
    && ALL_SCOPES.includes(value.scope as string)
    && value.provenance === value.scope
    && typeof value.shadowed === 'boolean'
    && isRevision(value.revision)
    && isFields(value.fields)
    && isText(value.prompt, MAX_PROMPT)
    && typeof value.enabled === 'boolean'
    && typeof value.valid === 'boolean'
    && isIssueList(value.validationIssues)
    && (!Object.hasOwn(value, 'path') || isText(value.path, 1024, false))
    && (!Object.hasOwn(value, 'nativeFields') || (Array.isArray(value.nativeFields)
      && value.nativeFields.length <= 32
      && value.nativeFields.every((field) => isText(field, 64, false))))
    && (!Object.hasOwn(value, 'disableSemantics') || ['native-model-invocation', 'app-dispatch-only'].includes(value.disableSemantics as string))
    && (!Object.hasOwn(value, 'editable') || typeof value.editable === 'boolean')
}

function isId(value: unknown, provider?: unknown): value is string {
  if (provider === 'herdr') {
    return typeof value === 'string'
      && value.length <= 400
      && /^(?:(?:user|project|bundled)~(?:agent|task|role)~[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md|bundled~role~role-pack-[1-9][0-9]*~[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md)$/.test(value)
  }
  return typeof value === 'string'
    && value.length <= 400
    && /^(?:user|project|workspace)~[A-Za-z0-9_-]{1,392}$/.test(value)
}

export function isAgentDefinitionListRequest(value: unknown): value is AgentDefinitionListRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      ...(Object.hasOwn(value, 'scope') ? ['scope'] : []),
      ...(Object.hasOwn(value, 'provider') ? ['provider'] : []),
      ...(Object.hasOwn(value, 'kind') ? ['kind'] : []),
    ])
    && (!Object.hasOwn(value, 'scope') || LIST_SCOPES.includes(value.scope as string))
    && (!Object.hasOwn(value, 'provider') || isProvider(value.provider))
    && (!Object.hasOwn(value, 'kind') || (value.provider === 'herdr' && ['agent', 'task', 'role'].includes(value.kind as string)))
}

export function isAgentDefinitionListResponse(value: unknown): value is AgentDefinitionListResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['definitions', 'projectAvailable'])
    && Array.isArray(value.definitions)
    && value.definitions.length <= MAX_DEFINITIONS
    && value.definitions.every(isDefinition)
    && typeof value.projectAvailable === 'boolean'
}

export function isAgentDefinitionReadRequest(value: unknown): value is AgentDefinitionReadRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['id', ...(Object.hasOwn(value, 'provider') ? ['provider'] : [])])
    && isId(value.id, value.provider)
    && (!Object.hasOwn(value, 'provider') || isProvider(value.provider))
}

export function isAgentDefinitionReadResponse(value: unknown): value is AgentDefinitionReadResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['definition', 'projectAvailable', 'validationIssues'])
    && (value.definition === null || isDefinition(value.definition))
    && typeof value.projectAvailable === 'boolean'
    && isIssueList(value.validationIssues)
}

export function isAgentDefinitionCreateRequest(value: unknown): value is AgentDefinitionCreateRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      ...(Object.hasOwn(value, 'provider') ? ['provider'] : []), ...(Object.hasOwn(value, 'kind') ? ['kind'] : []),
      'scope', 'expectedRevision', 'fields', 'prompt',
    ])
    && (!Object.hasOwn(value, 'provider') || isProvider(value.provider))
    && (value.provider !== 'herdr' || ['agent', 'task', 'role'].includes(value.kind as string))
    && (!Object.hasOwn(value, 'kind') || (value.provider === 'herdr' && ['agent', 'task', 'role'].includes(value.kind as string)))
    && MUTABLE_SCOPES.includes(value.scope as string)
    && isRevision(value.expectedRevision)
    && isFields(value.fields, true)
    && isText(value.prompt, MAX_PROMPT)
}

export function isAgentDefinitionUpdateRequest(value: unknown): value is AgentDefinitionUpdateRequest {
  if (!isPlainRecord(value)) return false
  const keys = [
    ...(Object.hasOwn(value, 'provider') ? ['provider'] : []),
    'id', 'expectedRevision', 'fields',
    ...(Object.hasOwn(value, 'clearFields') ? ['clearFields'] : []),
    ...(Object.hasOwn(value, 'prompt') ? ['prompt'] : []),
  ]
  return hasExactKeys(value, keys)
    && (!Object.hasOwn(value, 'provider') || isProvider(value.provider))
    && isId(value.id, value.provider)
    && isRevision(value.expectedRevision)
    && isFields(value.fields)
    && (!Object.hasOwn(value, 'clearFields') || (Array.isArray(value.clearFields)
      && value.clearFields.length <= FRONTMATTER_KEYS.length
      && value.clearFields.every((key) => FRONTMATTER_KEYS.includes(key as (typeof FRONTMATTER_KEYS)[number]))
      && new Set(value.clearFields).size === value.clearFields.length
      && value.clearFields.every((key) => !Object.hasOwn(value.fields as object, key))))
    && (!Object.hasOwn(value, 'prompt') || isText(value.prompt, MAX_PROMPT))
}

export function isAgentDefinitionDeleteRequest(value: unknown): value is AgentDefinitionDeleteRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      ...(Object.hasOwn(value, 'provider') ? ['provider'] : []), 'id', 'expectedRevision',
    ])
    && (!Object.hasOwn(value, 'provider') || isProvider(value.provider))
    && isId(value.id, value.provider)
    && isRevision(value.expectedRevision)
}

export function isAgentDefinitionEnableRequest(value: unknown): value is AgentDefinitionEnableRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      ...(Object.hasOwn(value, 'provider') ? ['provider'] : []), 'id', 'expectedRevision', 'enabled',
    ])
    && (!Object.hasOwn(value, 'provider') || isProvider(value.provider))
    && isId(value.id, value.provider)
    && isRevision(value.expectedRevision)
    && typeof value.enabled === 'boolean'
}

export function isAgentDefinitionMutationResponse(value: unknown): value is AgentDefinitionMutationResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['status', 'definition', 'currentRevision', 'validationIssues'])
    && ['saved', 'conflict', 'invalid', 'not-found', 'unavailable', 'read-only'].includes(value.status as string)
    && (value.definition === null || isDefinition(value.definition))
    && (value.currentRevision === null || isRevision(value.currentRevision))
    && isIssueList(value.validationIssues)
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends AgentDefinitionCapabilityContracts {}
}
