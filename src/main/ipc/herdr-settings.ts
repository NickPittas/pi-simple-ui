import type { CapabilityDefinition, CapabilityContext } from './register.ts'
import { HerdrSettingsStore } from '../herdr/settings.ts'
import { hasExactKeys, isPlainRecord } from '../../shared/ipc-contracts.ts'
import {
  HERDR_SETTINGS_PROVIDER,
  type HerdrDefinitionSummary,
  type HerdrSettingsMutationResult,
  type HerdrSettingsProvider,
  type HerdrSettingsReadRequest,
  type HerdrSettingsScope,
  type HerdrSettingsSnapshot,
  type HerdrSettingsUpdateRequest,
  type HerdrSettingsValidationIssue,
} from '../../shared/herdr-settings.ts'

const DEFINITION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const NATIVE_AGENT_FIELDS = new Set([
  'name', 'description', 'model', 'tools', 'system-prompt', 'skills', 'skill', 'thinking',
  'deny-tools', 'spawning', 'persistent', 'auto-exit', 'interactive', 'session-mode', 'cwd',
  'disable-model-invocation',
])

export type HerdrSettingsCapabilityDefinition =
  | CapabilityDefinition<HerdrSettingsReadRequest, HerdrSettingsSnapshot>
  | CapabilityDefinition<HerdrSettingsUpdateRequest, HerdrSettingsMutationResult>

export type HerdrSettingsStoreResolver = (
  provider: HerdrSettingsProvider,
  scope: HerdrSettingsScope,
  context: CapabilityContext,
) => HerdrSettingsStore | undefined

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isValidationIssue(value: unknown): value is HerdrSettingsValidationIssue {
  return isPlainRecord(value)
    && hasExactKeys(value, ['path', 'message', 'severity'])
    && typeof value.path === 'string'
    && typeof value.message === 'string'
    && (value.severity === 'warning' || value.severity === 'error')
}

function isDefinitionSummary(value: unknown, scope?: HerdrSettingsScope): value is HerdrDefinitionSummary {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['name', 'scope', 'revision', 'exists', 'hasFrontmatter', 'metadata', 'validation'])) return false

  const metadata = value.metadata
  if (!isPlainRecord(metadata)) return false

  return typeof value.name === 'string'
    && (value.scope === 'user' || value.scope === 'project')
    && (scope === undefined || value.scope === scope)
    && isRevision(value.revision)
    && typeof value.exists === 'boolean'
    && typeof value.hasFrontmatter === 'boolean'
    && Object.keys(metadata).every((key) => NATIVE_AGENT_FIELDS.has(key) && typeof metadata[key] === 'string')
    && Array.isArray(value.validation)
    && value.validation.every(isValidationIssue)
}

export function isHerdrSettingsReadRequest(value: unknown): value is HerdrSettingsReadRequest {
  if (!isPlainRecord(value) || value.provider !== HERDR_SETTINGS_PROVIDER) return false
  if (value.target === 'config') {
    return hasExactKeys(value, ['provider', 'target', 'scope']) && value.scope === 'user'
  }
  if (value.target === 'definitions') {
    return hasExactKeys(value, ['provider', 'target', 'scope']) && (value.scope === 'user' || value.scope === 'project')
  }
  return value.target === 'definition'
    && hasExactKeys(value, ['provider', 'target', 'scope', 'name'])
    && (value.scope === 'user' || value.scope === 'project')
    && typeof value.name === 'string'
    && DEFINITION_NAME.test(value.name)
}

export function isHerdrSettingsUpdateRequest(value: unknown): value is HerdrSettingsUpdateRequest {
  if (!isPlainRecord(value)
    || value.provider !== HERDR_SETTINGS_PROVIDER
    || !isRevision(value.expectedRevision)) return false
  if (value.target === 'config') {
    return hasExactKeys(value, ['provider', 'target', 'scope', 'expectedRevision', 'patch', 'removePaths'])
      && value.scope === 'user'
      && isPlainRecord(value.patch)
      && Array.isArray(value.removePaths)
      && value.removePaths.every((path) => typeof path === 'string' && path.length > 0 && path.length <= 256)
  }
  return value.target === 'definition'
    && hasExactKeys(value, ['provider', 'target', 'scope', 'name', 'expectedRevision', 'metadata'])
    && (value.scope === 'user' || value.scope === 'project')
    && typeof value.name === 'string'
    && DEFINITION_NAME.test(value.name)
    && isPlainRecord(value.metadata)
    && Object.keys(value.metadata).every((key) => NATIVE_AGENT_FIELDS.has(key))
    && Object.values(value.metadata).every((item) => item === null || (typeof item === 'string' && item.length <= 16_384 && !/[\r\n]/.test(item)))
}

export function isHerdrSettingsSnapshot(value: unknown): value is HerdrSettingsSnapshot {
  if (!isPlainRecord(value) || value.provider !== HERDR_SETTINGS_PROVIDER) return false
  if (value.target === 'config') {
    return hasExactKeys(value, ['provider', 'target', 'scope', 'revision', 'exists', 'settings', 'validation'])
      && value.scope === 'user'
      && isRevision(value.revision)
      && typeof value.exists === 'boolean'
      && isPlainRecord(value.settings)
      && Array.isArray(value.validation)
      && value.validation.every(isValidationIssue)
  }
  if (value.target === 'definitions') {
    return hasExactKeys(value, ['provider', 'target', 'scope', 'definitions'])
      && (value.scope === 'user' || value.scope === 'project')
      && Array.isArray(value.definitions)
      && value.definitions.every((definition) => isDefinitionSummary(definition, value.scope as HerdrSettingsScope))
  }
  return value.target === 'definition'
    && hasExactKeys(value, ['provider', 'target', 'scope', 'definition'])
    && (value.scope === 'user' || value.scope === 'project')
    && isDefinitionSummary(value.definition, value.scope)
}

export function isHerdrSettingsMutationResult(value: unknown): value is HerdrSettingsMutationResult {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome', 'snapshot'])
    && (value.outcome === 'saved' || value.outcome === 'conflict')
    && isHerdrSettingsSnapshot(value.snapshot)
    && (value.snapshot.target === 'config' || value.snapshot.target === 'definition')
}

/** Typed descriptors for composition into the existing, single IPC registry. */
export function registerHerdrSettingsCapabilities(resolveStore: HerdrSettingsStoreResolver): readonly HerdrSettingsCapabilityDefinition[] {
  const read: CapabilityDefinition<HerdrSettingsReadRequest, HerdrSettingsSnapshot> = {
    id: 'herdr.settings.read',
    scope: 'window',
    validateRequest: isHerdrSettingsReadRequest,
    validateResponse: isHerdrSettingsSnapshot,
    handle: (context, request) => {
      const store = resolveStore(request.provider, request.scope, context)
      if (!store) throw new TypeError('Herdr settings scope is unavailable.')
      return store.read(request)
    },
  }
  const update: CapabilityDefinition<HerdrSettingsUpdateRequest, HerdrSettingsMutationResult> = {
    id: 'herdr.settings.update',
    scope: 'window',
    validateRequest: isHerdrSettingsUpdateRequest,
    validateResponse: isHerdrSettingsMutationResult,
    handle: (context, request) => {
      const store = resolveStore(request.provider, request.scope, context)
      if (!store) throw new TypeError('Herdr settings scope is unavailable.')
      return store.update(request)
    },
  }
  return [read, update]
}
