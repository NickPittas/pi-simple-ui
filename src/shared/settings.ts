import { hasExactKeys, isPlainRecord, isRuntimeScope, type RuntimeScope } from './ipc-contracts.ts'

export type NativeSettingsScope = 'user' | 'project' | 'session'
export type SettingsEffect = 'now' | 'reload' | 'new-session' | 'restart'
export type SettingsValueType = 'boolean' | 'number' | 'string' | 'string[]' | 'array' | 'number|string' | 'boolean|string' | 'object' | 'unknown'
export type SettingsReadonlyClass = 'editable' | 'read-only' | 'native-readonly'

export interface SettingsDescriptor {
  readonly key: string
  readonly scopes: readonly NativeSettingsScope[]
  readonly type: SettingsValueType
  readonly validator: string
  readonly readonly: SettingsReadonlyClass
  readonly effect: SettingsEffect
  /** `native` is Pi's SettingsManager; all other values are installed extension ids. */
  readonly source: string
  readonly description?: string
  readonly readonlyReason?: string
}

export interface SettingsSchemaResponse {
  readonly descriptors: readonly SettingsDescriptor[]
}

export interface SettingsFieldValue {
  readonly key: string
  readonly value?: unknown
  readonly effective?: unknown
  readonly provenance: 'user' | 'project' | 'session' | 'override' | 'environment' | 'default' | 'native-readonly'
  readonly revision: number
  readonly editableScopes: readonly NativeSettingsScope[]
}

export interface SettingsReadResponse {
  readonly fields: readonly SettingsFieldValue[]
}

export interface SettingsReadRequest {
  readonly scope: NativeSettingsScope
}

export interface SettingsUpdateRequest {
  readonly key: string
  readonly scope: NativeSettingsScope
  readonly expectedRevision: number
  readonly value: unknown
}

export interface SettingsResetRequest {
  readonly key: string
  readonly scope: NativeSettingsScope
  readonly expectedRevision: number
}

export interface SettingsMutationResult {
  readonly outcome: 'saved' | 'conflict'
  readonly field: SettingsFieldValue
}

export interface SettingsEventPayload {
  readonly key: string
  readonly scope: NativeSettingsScope
  readonly revision: number
}

export interface SettingsCapabilityContracts {
  'settings.schema': { readonly request: Record<string, never>; readonly response: SettingsSchemaResponse }
  'settings.read': { readonly request: SettingsReadRequest; readonly response: SettingsReadResponse }
  'settings.update': { readonly request: SettingsUpdateRequest; readonly response: SettingsMutationResult }
  'settings.reset': { readonly request: SettingsResetRequest; readonly response: SettingsMutationResult }
}

export interface SettingsEventContracts {
  'settings.events': { readonly payload: SettingsEventPayload }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends SettingsCapabilityContracts {}
  interface IpcEventContracts extends SettingsEventContracts {}
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const JSON_VALUE_MAX_DEPTH = 12

function isSafeJsonValue(value: unknown, depth = 0): boolean {
  if (depth > JSON_VALUE_MAX_DEPTH) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((entry) => isSafeJsonValue(entry, depth + 1))
  if (!isPlainRecord(value)) return false
  return Object.keys(value).length <= 10_000
    && Object.keys(value).every((key) => !['__proto__', 'prototype', 'constructor'].includes(key))
    && Object.values(value).every((entry) => isSafeJsonValue(entry, depth + 1))
}

/** Shared descriptor validation. Unknown validator ids fail closed. */
export function validateSettingsValue(descriptor: SettingsDescriptor, value: unknown): boolean {
  if (descriptor.readonly !== 'editable' || !isSafeJsonValue(value)) return false
  switch (descriptor.validator) {
    case 'boolean': return typeof value === 'boolean'
    case 'string': return typeof value === 'string' && value.length <= 16_384 && !value.includes('\0')
    case 'non-empty-string': return typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !value.includes('\0')
    case 'thinking-level': return typeof value === 'string' && THINKING_LEVELS.includes(value as typeof THINKING_LEVELS[number])
    case 'non-negative-integer': return Number.isSafeInteger(value) && (value as number) >= 0
    case 'positive-integer': return Number.isSafeInteger(value) && (value as number) > 0
    case 'bounded-integer': return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 10_000_000
    case 'string-array': return Array.isArray(value) && value.length <= 10_000
      && value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4_096 && !entry.includes('\0'))
    case 'optional-tool-array': return Array.isArray(value) && value.length <= 1_024
      && value.every((entry) => typeof entry === 'string' && /^[+-]?[A-Za-z0-9_.:-]{1,128}$/.test(entry))
    case 'enum:transport': return ['auto', 'sse', 'websocket'].includes(value as string)
    case 'enum:steering':
    case 'enum:follow-up': return ['all', 'one-at-a-time'].includes(value as string)
    case 'enum:double-escape': return ['fork', 'tree', 'none'].includes(value as string)
    case 'enum:tree-filter': return ['default', 'no-tools', 'user-only', 'labeled-only', 'all'].includes(value as string)
    case 'enum:mermaid': return ['off', 'final', 'streaming'].includes(value as string)
    case 'enum:cache-warming': return ['off', 'streaming', 'idle'].includes(value as string)
    case 'enum:tui-mode': return ['fullscreen', 'regular'].includes(value as string)
    case 'enum:fullscreen-exit': return ['transcript', 'resume-hint'].includes(value as string)
    case 'enum:scrollbar': return ['auto', 'always', 'hidden'].includes(value as string)
    case 'enum:scroll-lines': return value === 'auto' || Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 100
    case 'enum:quiet-startup': return value === true || value === false || value === 'header'
    case 'enum:project-trust': return ['ask', 'always', 'never'].includes(value as string)
    case 'enum:optional-boolean': return typeof value === 'boolean'
    case 'string-map-thinking': return isPlainRecord(value)
      && Object.keys(value).length <= 10_000
      && Object.values(value).every((entry) => typeof entry === 'string' && THINKING_LEVELS.includes(entry as typeof THINKING_LEVELS[number]))
    case 'string-map': return isPlainRecord(value) && Object.keys(value).length <= 10_000
      && Object.values(value).every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4_096)
    case 'compaction-model-overrides': return isPlainRecord(value) && Object.keys(value).length <= 10_000
      && Object.values(value).every((entry) => isPlainRecord(entry)
        && Object.keys(entry).every((key) => ['reserveTokens', 'keepRecentTokens'].includes(key))
        && Object.values(entry).every((child) => Number.isSafeInteger(child) && (child as number) >= 0))
    case 'object': return isPlainRecord(value)
    case 'string-or-false': return typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !value.includes('\0') || value === false
    case 'boolean-or-auto': return typeof value === 'boolean' || value === 'auto'
    case 'image-mode': return value === false || ['auto', 'kitty', 'iterm2'].includes(value as string)
    case 'retry-number': return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000
    case 'http-timeout': return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 86_400_000
    case 'package-sources': return Array.isArray(value) && value.length <= 1_024
      && value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4_096
        || isPlainRecord(entry) && typeof entry.source === 'string' && entry.source.length > 0
          && Object.keys(entry).every((key) => ['source', 'autoload', 'extensions', 'skills', 'prompts', 'themes'].includes(key))
          && (entry.autoload === undefined || typeof entry.autoload === 'boolean')
          && ['extensions', 'skills', 'prompts', 'themes'].every((key) => entry[key] === undefined
            || Array.isArray(entry[key]) && (entry[key] as unknown[]).every((item) => typeof item === 'string')))
    case 'thinking-budgets': return isPlainRecord(value)
      && Object.keys(value).every((key) => ['minimal', 'low', 'medium', 'high'].includes(key))
      && Object.values(value).every((entry) => Number.isSafeInteger(entry) && (entry as number) >= 0)
    case 'output-pad': return value === 0 || value === 1
    case 'editor-padding': return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 3
    case 'autocomplete-limit': return Number.isSafeInteger(value) && (value as number) >= 3 && (value as number) <= 20
    case 'image-width': return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1_000_000
    case 'enum:codemode-mode': return value === 'on' || value === 'only'
    case 'scoped-models': return Array.isArray(value) && value.length <= 10_000 && value.every((entry) => {
      if (!isPlainRecord(entry)) return false
      return Object.keys(entry).every((key) => ['provider', 'id', 'thinkingLevel'].includes(key))
        && typeof entry.provider === 'string' && entry.provider.length > 0
        && typeof entry.id === 'string' && entry.id.length > 0
        && (entry.thinkingLevel === undefined || THINKING_LEVELS.includes(entry.thinkingLevel as typeof THINKING_LEVELS[number]))
    })
    case 'enum:herdr-pane-mode': return ['grouped', 'tab', 'split'].includes(value as string)
    case 'enum:herdr-pane-direction': return value === 'right' || value === 'down'
    case 'enum:subagents-join': return ['async', 'group', 'smart'].includes(value as string)
    case 'enum:subagents-description': return ['full', 'compact', 'custom'].includes(value as string)
    case 'enum:subagents-mentions': return ['model', 'direct', 'off'].includes(value as string)
    case 'enum:subagents-widget': return ['all', 'background', 'off'].includes(value as string)
    case 'enum:subagents-markdown': return ['off', 'assistant', 'all'].includes(value as string)
    case 'herdr-scalar': return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\r\n]/.test(value)
    case 'enum:herdr-boolean': return value === 'true' || value === 'false'
    case 'enum:herdr-system-prompt': return value === 'replace' || value === 'append'
    case 'enum:herdr-thinking': return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value as string)
    case 'enum:herdr-session-mode': return ['standalone', 'lineage-only', 'fork'].includes(value as string)
    default: return false
  }
}

export function isNativeSettingsScope(value: unknown): value is NativeSettingsScope {
  return value === 'user' || value === 'project' || value === 'session'
}

export function isEmptySettingsRequest(value: unknown): value is Record<string, never> {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

export function isSettingsReadRequest(value: unknown): value is SettingsReadRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['scope'])
    && isNativeSettingsScope(value.scope)
}

export function isSettingsUpdateRequest(value: unknown): value is SettingsUpdateRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['key', 'scope', 'expectedRevision', 'value'])
    && typeof value.key === 'string'
    && value.key.length > 0
    && value.key.length <= 256
    && isNativeSettingsScope(value.scope)
    && Number.isSafeInteger(value.expectedRevision)
    && (value.expectedRevision as number) >= 0
    && isSafeJsonValue(value.value)
}

export function isSettingsResetRequest(value: unknown): value is SettingsResetRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['key', 'scope', 'expectedRevision'])
    && typeof value.key === 'string'
    && value.key.length > 0
    && value.key.length <= 256
    && isNativeSettingsScope(value.scope)
    && Number.isSafeInteger(value.expectedRevision)
    && (value.expectedRevision as number) >= 0
}

export function isSettingsEventPayload(value: unknown): value is SettingsEventPayload {
  return isPlainRecord(value)
    && hasExactKeys(value, ['key', 'scope', 'revision'])
    && typeof value.key === 'string'
    && value.key.length > 0
    && value.key.length <= 256
    && isNativeSettingsScope(value.scope)
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) >= 0
}

export function isSettingsDescriptor(value: unknown): value is SettingsDescriptor {
  if (!isPlainRecord(value)) return false
  const optional = Object.hasOwn(value, 'description') ? ['description'] : []
  if (Object.hasOwn(value, 'readonlyReason')) optional.push('readonlyReason')
  return hasExactKeys(value, ['key', 'scopes', 'type', 'validator', 'readonly', 'effect', 'source', ...optional])
    && typeof value.key === 'string'
    && Array.isArray(value.scopes)
    && value.scopes.length > 0
    && value.scopes.every(isNativeSettingsScope)
    && ['boolean', 'number', 'string', 'string[]', 'array', 'number|string', 'boolean|string', 'object', 'unknown'].includes(value.type as string)
    && typeof value.validator === 'string'
    && ['editable', 'read-only', 'native-readonly'].includes(value.readonly as string)
    && ['now', 'reload', 'new-session', 'restart'].includes(value.effect as string)
    && typeof value.source === 'string'
    && (!Object.hasOwn(value, 'description') || typeof value.description === 'string')
    && (!Object.hasOwn(value, 'readonlyReason') || typeof value.readonlyReason === 'string')
}

export function isSettingsSchemaResponse(value: unknown): value is SettingsSchemaResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['descriptors'])
    && Array.isArray(value.descriptors)
    && value.descriptors.every(isSettingsDescriptor)
}

export function isSettingsFieldValue(value: unknown): value is SettingsFieldValue {
  if (!isPlainRecord(value)) return false
  const keys = ['key', 'provenance', 'revision', 'editableScopes']
  if (Object.hasOwn(value, 'value')) keys.push('value')
  if (Object.hasOwn(value, 'effective')) keys.push('effective')
  return hasExactKeys(value, keys)
    && typeof value.key === 'string'
    && ['user', 'project', 'session', 'override', 'environment', 'default', 'native-readonly'].includes(value.provenance as string)
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) >= 0
    && Array.isArray(value.editableScopes)
    && value.editableScopes.every(isNativeSettingsScope)
    && (!Object.hasOwn(value, 'value') || isSafeJsonValue(value.value))
    && (!Object.hasOwn(value, 'effective') || isSafeJsonValue(value.effective))
}

export function isSettingsReadResponse(value: unknown): value is SettingsReadResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['fields'])
    && Array.isArray(value.fields)
    && value.fields.every(isSettingsFieldValue)
}

export function isSettingsMutationResult(value: unknown): value is SettingsMutationResult {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome', 'field'])
    && (value.outcome === 'saved' || value.outcome === 'conflict')
    && isSettingsFieldValue(value.field)
}

export function isSettingsRuntimeScope(value: unknown): value is RuntimeScope {
  return isRuntimeScope(value)
}
