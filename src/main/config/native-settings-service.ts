import { createHash } from 'node:crypto'
import type { SettingsManager } from '@earendil-works/pi-coding-agent'
import type { ModelReference } from '../../shared/models.ts'
import { isPlainRecord } from '../../shared/ipc-contracts.ts'
import {
  type SettingsDescriptor,
  type NativeSettingsScope,
  type SettingsEventPayload,
  type SettingsFieldValue,
  type SettingsMutationResult,
  type SettingsReadResponse,
  validateSettingsValue,
} from '../../shared/settings.ts'
import { SETTINGS_DESCRIPTOR_BY_KEY, SETTINGS_DESCRIPTORS } from './settings-descriptors.ts'
import type { ModelSettingsService } from '../models/model-settings.ts'
import type { HerdrSettingsStore } from '../herdr/settings.ts'
import { HERDR_SETTINGS_PROVIDER } from '../../shared/herdr-settings.ts'
import type { HerdrJsonObject, HerdrJsonValue } from '../../shared/herdr-settings.ts'
import { ScopedSettingsService, type ScopedSettingsScope } from './settings-service.ts'

export type SettingsManagerAccessor = () => SettingsManager | undefined
export type SettingsProjectTrustAccessor = () => boolean

export interface SettingsProviderValue {
  readonly value?: unknown
  readonly effective?: unknown
  readonly provenance?: SettingsFieldValue['provenance']
  readonly revision: number
  readonly editable: boolean
}

export interface SettingsExtensionProvider {
  readonly source: string
  descriptors?(scope: NativeSettingsScope): readonly SettingsDescriptor[]
  read(key: string, scope: NativeSettingsScope): SettingsProviderValue | undefined
  update(key: string, scope: NativeSettingsScope, expectedRevision: number, value: unknown): Promise<'saved' | 'conflict'> | 'saved' | 'conflict'
  reset(key: string, scope: NativeSettingsScope, expectedRevision: number): Promise<'saved' | 'conflict'> | 'saved' | 'conflict'
}

export interface NativeSettingsServiceOptions {
  readonly projectTrusted?: SettingsProjectTrustAccessor
  readonly models?: ModelSettingsService
  readonly extensions?: readonly SettingsExtensionProvider[]
}

const settingsLocks = new WeakMap<SettingsManager, Promise<void>>()
const SENSITIVE_KEY = /(?:secret|token|credential|password|api.?key|authorization|private.?key|access.?key)/i
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const USER_PROJECT = ['user', 'project'] as const

function hash(value: unknown): number {
  const encoded = JSON.stringify(value === undefined ? { present: false } : { present: true, value })
  return Number.parseInt(createHash('sha256').update(encoded).digest('hex').slice(0, 12), 16)
}

function cleanValue(value: unknown, depth = 0): unknown {
  if (depth > 24) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const output: unknown[] = []
    for (const item of value) {
      const safe = cleanValue(item, depth + 1)
      if (safe !== undefined) output.push(safe)
    }
    return output
  }
  if (!isPlainRecord(value)) return undefined
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) || UNSAFE_KEYS.has(key)) continue
    const safe = cleanValue(child, depth + 1)
    if (safe !== undefined) Object.defineProperty(output, key, { value: safe, enumerable: true, writable: true, configurable: true })
  }
  return output
}

function getPath(root: unknown, path: string): unknown {
  let current = root
  for (const part of path.split('.')) {
    if (UNSAFE_KEYS.has(part) || current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function hasPath(root: unknown, path: string): boolean {
  let current = root
  for (const part of path.split('.')) {
    if (UNSAFE_KEYS.has(part) || current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return false
    current = (current as Record<string, unknown>)[part]
  }
  return true
}

function pathValue(root: unknown, descriptor: SettingsDescriptor): unknown {
  return getPath(root, nativePath(descriptor) ?? descriptor.key)
}

function nativePath(descriptor: SettingsDescriptor): string | undefined {
  if (descriptor.source === 'native') return descriptor.key
  if (descriptor.source === 'pi-powerline-footer' && descriptor.key.startsWith('powerline.')) {
    return descriptor.key.slice('powerline.'.length)
  }
  return undefined
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

async function withSettingsLock<T>(manager: SettingsManager, operation: () => Promise<T>): Promise<T> {
  const previous = settingsLocks.get(manager) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => { release = resolve })
  settingsLocks.set(manager, next)
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
    if (settingsLocks.get(manager) === next) settingsLocks.delete(manager)
  }
}

interface NativeWriter {
  readonly scopes: readonly ('user' | 'project')[]
  readonly canReset: boolean
  readonly write: (manager: SettingsManager, value: unknown, scope: 'user' | 'project') => void
}

const USER = ['user'] as const

function clearedString(value: unknown): string {
  return value === undefined ? undefined as unknown as string : value as string
}

function clearedBoolean(value: unknown): boolean {
  return value === undefined ? undefined as unknown as boolean : value as boolean
}

function clearedArray<T>(value: unknown): T[] {
  return value === undefined ? undefined as unknown as T[] : value as T[]
}

function numericSetting(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('A numeric setting value is required.')
  return Number(value)
}

function outputPadSetting(value: unknown): 0 | 1 {
  const numeric = numericSetting(value)
  if (numeric !== 0 && numeric !== 1) throw new TypeError('Output padding must be 0 or 1.')
  return numeric
}

function wheelScrollSetting(value: unknown): 'auto' | number {
  if (value === 'auto') return 'auto'
  const numeric = numericSetting(value)
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > 100) {
    throw new TypeError('Wheel scroll lines must be auto or an integer from 1 to 100.')
  }
  return Number(value)
}

function isPersistentScope(scope: NativeSettingsScope): scope is ScopedSettingsScope {
  return scope === 'user' || scope === 'project'
}

const NATIVE_WRITERS: Readonly<Record<string, NativeWriter>> = {
  defaultProvider: { scopes: USER, canReset: true, write: (manager, value) => manager.setDefaultProvider(clearedString(value)) },
  defaultModel: { scopes: USER, canReset: true, write: (manager, value) => manager.setDefaultModel(clearedString(value)) },
  defaultThinkingLevel: { scopes: USER, canReset: true, write: (manager, value) => manager.setDefaultThinkingLevel(clearedString(value) as never) },
  modelThinkingLevels: {
    scopes: USER, canReset: true,
    write(manager, value) {
      const next = value === undefined ? {} : value as Record<string, string>
      const current = manager.getGlobalSettings().modelThinkingLevels ?? {}
      for (const key of Object.keys(current)) {
        if (Object.hasOwn(next, key)) continue
        const split = key.indexOf('/')
        if (split > 0) manager.removeModelThinkingLevel(key.slice(0, split), key.slice(split + 1))
      }
      for (const [key, level] of Object.entries(next)) {
        const split = key.indexOf('/')
        if (split > 0) manager.setModelThinkingLevel(key.slice(0, split), key.slice(split + 1), level as never)
      }
    },
  },
  transport: { scopes: USER, canReset: true, write: (manager, value) => manager.setTransport(clearedString(value) as never) },
  steeringMode: { scopes: USER, canReset: true, write: (manager, value) => manager.setSteeringMode(clearedString(value) as never) },
  followUpMode: { scopes: USER, canReset: true, write: (manager, value) => manager.setFollowUpMode(clearedString(value) as never) },
  theme: { scopes: USER, canReset: true, write: (manager, value) => manager.setTheme(clearedString(value)) },
  'compaction.enabled': { scopes: USER, canReset: true, write: (manager, value) => manager.setCompactionEnabled(clearedBoolean(value)) },
  'retry.enabled': { scopes: USER, canReset: true, write: (manager, value) => manager.setRetryEnabled(clearedBoolean(value)) },
  hideThinkingBlock: { scopes: USER, canReset: true, write: (manager, value) => manager.setHideThinkingBlock(clearedBoolean(value)) },
  showCacheMissNotices: { scopes: USER, canReset: true, write: (manager, value) => manager.setShowCacheMissNotices(clearedBoolean(value)) },
  shellPath: { scopes: USER, canReset: true, write: (manager, value) => manager.setShellPath(clearedString(value)) },
  quietStartup: { scopes: USER, canReset: true, write: (manager, value) => manager.setQuietStartup(value as never) },
  defaultProjectTrust: { scopes: USER, canReset: true, write: (manager, value) => manager.setDefaultProjectTrust(clearedString(value) as never) },
  shellCommandPrefix: { scopes: USER, canReset: true, write: (manager, value) => manager.setShellCommandPrefix(clearedString(value)) },
  npmCommand: { scopes: USER, canReset: true, write: (manager, value) => manager.setNpmCommand(clearedArray<string>(value)) },
  collapseChangelog: { scopes: USER, canReset: true, write: (manager, value) => manager.setCollapseChangelog(clearedBoolean(value)) },
  enableInstallTelemetry: { scopes: USER, canReset: true, write: (manager, value) => manager.setEnableInstallTelemetry(clearedBoolean(value)) },
  enableAnalytics: { scopes: USER, canReset: true, write: (manager, value) => manager.setEnableAnalytics(clearedBoolean(value)) },
  packages: {
    scopes: USER_PROJECT, canReset: true,
    write(manager, value, scope) {
      const list = clearedArray<never>(value)
      if (scope === 'project') manager.setProjectPackages(value === undefined ? list : value as never[])
      else manager.setPackages(value === undefined ? list : value as never[])
    },
  },
  extensions: {
    scopes: USER_PROJECT, canReset: true,
    write(manager, value, scope) {
      if (scope === 'project') manager.setProjectExtensionPaths(value === undefined ? undefined as unknown as string[] : value as string[])
      else manager.setExtensionPaths(value === undefined ? undefined as unknown as string[] : value as string[])
    },
  },
  skills: {
    scopes: USER_PROJECT, canReset: true,
    write(manager, value, scope) {
      if (scope === 'project') manager.setProjectSkillPaths(value === undefined ? undefined as unknown as string[] : value as string[])
      else manager.setSkillPaths(value === undefined ? undefined as unknown as string[] : value as string[])
    },
  },
  prompts: {
    scopes: USER_PROJECT, canReset: true,
    write(manager, value, scope) {
      if (scope === 'project') manager.setProjectPromptTemplatePaths(value === undefined ? undefined as unknown as string[] : value as string[])
      else manager.setPromptTemplatePaths(value === undefined ? undefined as unknown as string[] : value as string[])
    },
  },
  themes: {
    scopes: USER_PROJECT, canReset: true,
    write(manager, value, scope) {
      if (scope === 'project') manager.setProjectThemePaths(value === undefined ? undefined as unknown as string[] : value as string[])
      else manager.setThemePaths(value === undefined ? undefined as unknown as string[] : value as string[])
    },
  },
  enableSkillCommands: { scopes: USER, canReset: true, write: (manager, value) => manager.setEnableSkillCommands(clearedBoolean(value)) },
  'terminal.showImages': { scopes: USER, canReset: true, write: (manager, value) => manager.setShowImages(clearedBoolean(value)) },
  'terminal.imageWidthCells': { scopes: USER, canReset: false, write: (manager, value) => manager.setImageWidthCells(numericSetting(value)) },
  'terminal.clearOnShrink': { scopes: USER, canReset: true, write: (manager, value) => manager.setClearOnShrink(clearedBoolean(value)) },
  'terminal.showTerminalProgress': { scopes: USER, canReset: true, write: (manager, value) => manager.setShowTerminalProgress(clearedBoolean(value)) },
  'images.autoResize': { scopes: USER, canReset: true, write: (manager, value) => manager.setImageAutoResize(clearedBoolean(value)) },
  'images.blockImages': { scopes: USER, canReset: true, write: (manager, value) => manager.setBlockImages(clearedBoolean(value)) },
  enabledModels: { scopes: USER, canReset: true, write: (manager, value) => manager.setEnabledModels(clearedArray<string>(value)) },
  doubleEscapeAction: { scopes: USER, canReset: true, write: (manager, value) => manager.setDoubleEscapeAction(clearedString(value) as never) },
  treeFilterMode: { scopes: USER, canReset: true, write: (manager, value) => manager.setTreeFilterMode(clearedString(value) as never) },
  editorPaddingX: { scopes: USER, canReset: false, write: (manager, value) => manager.setEditorPaddingX(numericSetting(value)) },
  outputPad: { scopes: USER, canReset: true, write: (manager, value) => manager.setOutputPad(outputPadSetting(value)) },
  autocompleteMaxVisible: { scopes: USER, canReset: false, write: (manager, value) => manager.setAutocompleteMaxVisible(numericSetting(value)) },
  showHardwareCursor: { scopes: USER, canReset: true, write: (manager, value) => manager.setShowHardwareCursor(clearedBoolean(value)) },
  'markdown.mermaid': { scopes: USER, canReset: true, write: (manager, value) => manager.setMermaidRenderingMode(clearedString(value) as never) },
  'warnings.anthropicExtraUsage': {
    scopes: USER, canReset: true,
    write(manager, value) {
      const warnings = { ...(manager.getGlobalSettings().warnings ?? {}) }
      if (value === undefined) delete warnings.anthropicExtraUsage
      else warnings.anthropicExtraUsage = value as boolean
      manager.setWarnings(warnings)
    },
  },
  httpIdleTimeoutMs: { scopes: USER, canReset: true, write: (manager, value) => manager.setHttpIdleTimeoutMs(numericSetting(value)) },
  cacheWarming: { scopes: USER, canReset: true, write: (manager, value) => manager.setCacheWarmingMode(clearedString(value) as never) },
  tuiMode: { scopes: USER, canReset: true, write: (manager, value) => manager.setTuiMode(clearedString(value) as never) },
  fullscreenExitOutput: { scopes: USER, canReset: true, write: (manager, value) => manager.setFullscreenExitOutput(clearedString(value) as never) },
  fullscreenScrollbar: { scopes: USER, canReset: true, write: (manager, value) => manager.setFullscreenScrollbar(clearedString(value) as never) },
  fullscreenCopyOnSelect: { scopes: USER, canReset: true, write: (manager, value) => manager.setFullscreenCopyOnSelect(clearedBoolean(value)) },
  fullscreenWheelScrollLines: { scopes: USER, canReset: false, write: (manager, value) => manager.setFullscreenWheelScrollLines(wheelScrollSetting(value)) },
}

function getWriter(descriptor: SettingsDescriptor, scope: NativeSettingsScope): NativeWriter | undefined {
  if (descriptor.source !== 'native' || scope === 'session') return undefined
  const writer = NATIVE_WRITERS[descriptor.key]
  return writer?.scopes.includes(scope) ? writer : undefined
}

function configuredSettings(manager: SettingsManager, scope: 'user' | 'project'): Record<string, unknown> {
  return (scope === 'user' ? manager.getGlobalSettings() : manager.getProjectSettings()) as Record<string, unknown>
}

function activeSettings(manager: SettingsManager): Record<string, unknown> {
  return manager.getSettings() as Record<string, unknown>
}

function mergedSettings(manager: SettingsManager): Record<string, unknown> {
  const global = manager.getGlobalSettings() as Record<string, unknown>
  const project = manager.isProjectTrusted() ? manager.getProjectSettings() as Record<string, unknown> : {}
  return deepMerge(global, project)
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const previous = result[key]
    result[key] = isPlainRecord(previous) && isPlainRecord(value) ? deepMerge(previous, value) : value
  }
  return result
}

function effectiveProvenance(
  descriptor: SettingsDescriptor,
  manager: SettingsManager,
  effective: unknown,
): SettingsFieldValue['provenance'] {
  if (descriptor.readonly === 'native-readonly'
    && !(descriptor.source === 'pi-powerline-footer' && pathValue(manager.getSettings(), descriptor) !== undefined)) return 'native-readonly'
  if (descriptor.key === 'externalEditor' && !hasPath(manager.getSettings(), descriptor.key)
    && (process.env.VISUAL || process.env.EDITOR)) return 'environment'
  if (descriptor.key === 'terminal.clearOnShrink' && !hasPath(manager.getSettings(), descriptor.key)
    && process.env.PI_CLEAR_ON_SHRINK === '1') return 'environment'
  if (descriptor.key === 'showHardwareCursor' && !hasPath(manager.getSettings(), descriptor.key)
    && process.env.PI_HARDWARE_CURSOR === '1') return 'environment'
  const path = nativePath(descriptor) ?? descriptor.key
  const project = manager.isProjectTrusted() ? manager.getProjectSettings() as Record<string, unknown> : {}
  const global = manager.getGlobalSettings() as Record<string, unknown>
  const layerEffective = descriptor.scopes.includes('project')
    ? pathValue(mergedSettings(manager), descriptor)
    : pathValue(global, descriptor)
  if (!sameValue(effective, layerEffective)) return 'override'
  if (descriptor.scopes.includes('project') && hasPath(project, path)) return 'project'
  if (hasPath(global, path)) return 'user'
  return 'default'
}

function modelReferenceList(value: unknown): value is readonly ModelReference[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every((entry) => {
    if (!isPlainRecord(entry)) return false
    const keys = Object.keys(entry)
    return keys.every((key) => ['provider', 'id', 'thinkingLevel'].includes(key))
      && typeof entry.provider === 'string' && entry.provider.length > 0
      && typeof entry.id === 'string' && entry.id.length > 0
      && (entry.thinkingLevel === undefined || typeof entry.thinkingLevel === 'string')
  })
}

function modelScopeRevision(references: readonly ModelReference[]): number {
  return hash(references)
}

function herdrPatch(path: string, value: unknown): HerdrJsonObject {
  const parts = path.split('.')
  const first = parts.shift()
  if (!first || UNSAFE_KEYS.has(first)) throw new TypeError('The Herdr settings path is invalid.')
  if (parts.length === 0) return { [first]: value as HerdrJsonValue }
  return { [first]: herdrPatch(parts.join('.'), value) as HerdrJsonValue }
}

function herdrValue(root: HerdrJsonObject, key: string): unknown {
  return getPath(root, key.replace(/^config\./, ''))
}

function herdrDefinitionKey(key: string): { readonly name: string; readonly field: string } | undefined {
  const match = key.match(/^herdr\.definitions\.([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.([a-z-]+)$/)
  if (!match) return undefined
  return { name: match[1], field: match[2] }
}

function subagentsSnapshot(files: ScopedSettingsService, scope: ScopedSettingsScope) {
  const path = scope === 'user' ? 'subagents.json' : '.pi/subagents.json'
  return files.readJson(scope, path)
}

function validateSubagentsField(key: string, value: unknown): void {
  const descriptor = SETTINGS_DESCRIPTOR_BY_KEY.get(`subagents.${key}`)
  if (!descriptor || !validateSettingsValue(descriptor, value)) throw new TypeError(`Invalid pi-subagents setting: ${key}.`)
  if ((key === 'maxConcurrent' || key === 'maxConcurrentForeground') && numericSetting(value) > 1024) {
    throw new TypeError(`Invalid pi-subagents setting: ${key}.`)
  }
  if (key === 'defaultMaxTurns' && numericSetting(value) > 10_000) throw new TypeError(`Invalid pi-subagents setting: ${key}.`)
  if (key === 'graceTurns' && numericSetting(value) > 1_000) throw new TypeError(`Invalid pi-subagents setting: ${key}.`)
  if (key === 'maxSubagentDepth' && numericSetting(value) > 16) throw new TypeError(`Invalid pi-subagents setting: ${key}.`)
}

/** Scoped adapter for pi-subagents' own user/project subagents.json files. */
export function createSubagentsSettingsProvider(files: ScopedSettingsService): SettingsExtensionProvider {
  return {
    source: '@tintinweb/pi-subagents',
    read(key, scope) {
      if (!key.startsWith('subagents.') || scope === 'session') return undefined
      const field = key.slice('subagents.'.length)
      const snapshot = subagentsSnapshot(files, scope)
      const user = scope === 'project' ? subagentsSnapshot(files, 'user').document : snapshot.document
      const project = scope === 'project' ? snapshot.document : undefined
      const effective = project && Object.hasOwn(project, field) ? project[field] : user[field]
      const value = snapshot.document[field]
      return {
        ...(value === undefined ? {} : { value }),
        ...(effective === undefined ? {} : { effective }),
        provenance: value !== undefined ? scope : effective === undefined ? 'default' : 'user',
        revision: snapshot.revision,
        // Global operational settings are documented as manually managed; only the project API writes.
        editable: scope === 'project',
      }
    },
    update(key, scope, expectedRevision, value) {
      if (scope !== 'project' || !key.startsWith('subagents.')) throw new TypeError('pi-subagents settings are editable only at project scope.')
      const field = key.slice('subagents.'.length)
      const result = files.updateJson('project', '.pi/subagents.json', expectedRevision, { [field]: value }, [], (document) => {
        validateSubagentsField(field, document[field])
      })
      return result.outcome
    },
    reset(key, scope, expectedRevision) {
      if (scope !== 'project' || !key.startsWith('subagents.')) throw new TypeError('pi-subagents settings are editable only at project scope.')
      const result = files.updateJson('project', '.pi/subagents.json', expectedRevision, {}, [key.slice('subagents.'.length)])
      return result.outcome
    },
  }
}

/** Route Herdr config fields through the T23 provider rather than another file representation. */
export function createHerdrSettingsProvider(store: HerdrSettingsStore): SettingsExtensionProvider {
  return {
    source: HERDR_SETTINGS_PROVIDER,
    descriptors(scope) {
      if (!isPersistentScope(scope)) return []
      const snapshot = store.read({ provider: HERDR_SETTINGS_PROVIDER, target: 'definitions', scope })
      if (snapshot.target !== 'definitions') return []
      const templates = SETTINGS_DESCRIPTORS.filter((entry) => entry.source === HERDR_SETTINGS_PROVIDER
        && entry.key.startsWith('herdr.definitions.{name}.'))
      return snapshot.definitions.flatMap((definition) => templates.map((entry) => ({
        ...entry,
        key: entry.key.replace('{name}', definition.name),
        scopes: [scope],
      })))
    },
    read(key, scope) {
      if (!isPersistentScope(scope)) return undefined
      if (key.startsWith('config.')) {
        if (scope !== 'user') return undefined
        const snapshot = store.read({ provider: HERDR_SETTINGS_PROVIDER, target: 'config', scope: 'user' })
        if (snapshot.target !== 'config') return undefined
        const value = herdrValue(snapshot.settings, key)
        return { value, effective: value, provenance: value === undefined ? 'default' : 'user', revision: snapshot.revision, editable: true }
      }
      const definitionKey = herdrDefinitionKey(key)
      if (!definitionKey) return undefined
      const snapshot = store.read({ provider: HERDR_SETTINGS_PROVIDER, target: 'definition', scope, name: definitionKey.name })
      if (snapshot.target !== 'definition') return undefined
      const value = snapshot.definition.metadata[definitionKey.field]
      return {
        ...(value === undefined ? {} : { value, effective: value }),
        provenance: value === undefined ? 'default' : scope,
        revision: snapshot.definition.revision,
        editable: true,
      }
    },
    update(key, scope, expectedRevision, value) {
      if (key.startsWith('config.')) {
        if (scope !== 'user') throw new TypeError('Herdr config is user-scoped.')
        const result = store.update({
          provider: HERDR_SETTINGS_PROVIDER,
          target: 'config',
          scope: 'user',
          expectedRevision,
          patch: herdrPatch(key, value),
          removePaths: [],
        })
        return result.outcome
      }
      const definitionKey = herdrDefinitionKey(key)
      if (!definitionKey || !isPersistentScope(scope) || typeof value !== 'string') {
        throw new TypeError('Herdr definition updates require a supported scalar metadata field.')
      }
      return store.update({
        provider: HERDR_SETTINGS_PROVIDER,
        target: 'definition',
        scope,
        name: definitionKey.name,
        expectedRevision,
        metadata: { [definitionKey.field]: value },
      }).outcome
    },
    reset(key, scope, expectedRevision) {
      if (key.startsWith('config.')) {
        if (scope !== 'user') throw new TypeError('Herdr config is user-scoped.')
        return store.update({
          provider: HERDR_SETTINGS_PROVIDER,
          target: 'config',
          scope: 'user',
          expectedRevision,
          patch: {},
          removePaths: [key.replace(/^config\./, '')],
        }).outcome
      }
      const definitionKey = herdrDefinitionKey(key)
      if (!definitionKey || !isPersistentScope(scope)) {
        throw new TypeError('Herdr definition reset requires a supported scalar metadata field.')
      }
      return store.update({
        provider: HERDR_SETTINGS_PROVIDER,
        target: 'definition',
        scope,
        name: definitionKey.name,
        expectedRevision,
        metadata: { [definitionKey.field]: null },
      }).outcome
    },
  }
}

export class NativeSettingsService {
  private readonly getSettingsManager: SettingsManagerAccessor
  private readonly projectTrusted: SettingsProjectTrustAccessor | undefined
  private readonly models: ModelSettingsService | undefined
  private readonly extensionProviders: ReadonlyMap<string, SettingsExtensionProvider>
  private readonly listeners = new Set<(event: SettingsEventPayload) => void>()

  constructor(getSettingsManager: SettingsManagerAccessor, options: NativeSettingsServiceOptions = {}) {
    this.getSettingsManager = getSettingsManager
    this.projectTrusted = options.projectTrusted
    this.models = options.models
    this.extensionProviders = new Map((options.extensions ?? []).map((provider) => [provider.source, provider]))
  }

  schema(): readonly SettingsDescriptor[] {
    return SETTINGS_DESCRIPTORS
  }

  read(scope: NativeSettingsScope): SettingsReadResponse {
    const manager = this.requireSettingsManager()
    this.assertScopeAllowed(manager, scope)
    return {
      fields: this.descriptorsForScope(scope).map((entry) => this.readField(manager, entry, scope)),
    }
  }

  async update(request: { key: string; scope: NativeSettingsScope; expectedRevision: number; value: unknown }): Promise<SettingsMutationResult> {
    const descriptor = this.requireDescriptor(request.key)
    const manager = this.requireSettingsManager()
    this.assertScopeAllowed(manager, request.scope)
    if (!descriptor.scopes.includes(request.scope)) throw new TypeError('This setting is not available at the requested scope.')
    if (!validateSettingsValue(descriptor, request.value)) throw new TypeError('The setting value is invalid.')
    const extension = this.extensionProviders.get(descriptor.source)
    if (extension) return this.mutateProvider(extension, descriptor, request.scope, request.expectedRevision, request.value, false)
    if (descriptor.key === 'models.scoped') return this.updateModelScope(request.expectedRevision, request.value)
    if (descriptor.source !== 'native' || descriptor.readonly !== 'editable') throw new TypeError('This setting is read-only.')
    const settingsScope = request.scope
    if (!isPersistentScope(settingsScope)) throw new TypeError('Native SettingsManager settings are not session-scoped.')
    const writer = getWriter(descriptor, settingsScope)
    if (!writer) throw new TypeError('No native SettingsManager setter is available at the requested scope.')
    return withSettingsLock(manager, async () => {
      await manager.flush()
      await manager.reload()
      this.assertScopeAllowed(manager, settingsScope)
      const before = this.readField(manager, descriptor, settingsScope)
      if (before.revision !== request.expectedRevision) return { outcome: 'conflict', field: before }
      writer.write(manager, request.value, settingsScope)
      await manager.flush()
      await manager.reload()
      const after = this.readField(manager, descriptor, settingsScope)
      const stored = pathValue(configuredSettings(manager, settingsScope), descriptor)
      if (!sameValue(stored, request.value)) throw new Error('The native SettingsManager did not persist the requested setting.')
      this.publish({ key: descriptor.key, scope: settingsScope, revision: after.revision })
      return { outcome: 'saved', field: after }
    })
  }

  async reset(request: { key: string; scope: NativeSettingsScope; expectedRevision: number }): Promise<SettingsMutationResult> {
    const descriptor = this.requireDescriptor(request.key)
    const manager = this.requireSettingsManager()
    this.assertScopeAllowed(manager, request.scope)
    if (!descriptor.scopes.includes(request.scope)) throw new TypeError('This setting is not available at the requested scope.')
    const extension = this.extensionProviders.get(descriptor.source)
    if (extension) return this.mutateProvider(extension, descriptor, request.scope, request.expectedRevision, undefined, true)
    if (descriptor.key === 'models.scoped') return this.updateModelScope(request.expectedRevision, [])
    if (descriptor.source !== 'native' || descriptor.readonly !== 'editable') throw new TypeError('This setting is read-only.')
    const settingsScope = request.scope
    if (!isPersistentScope(settingsScope)) throw new TypeError('Native SettingsManager settings are not session-scoped.')
    const writer = getWriter(descriptor, settingsScope)
    if (!writer || !writer.canReset) throw new TypeError('The native SettingsManager does not expose a safe reset API for this setting.')
    return withSettingsLock(manager, async () => {
      await manager.flush()
      await manager.reload()
      this.assertScopeAllowed(manager, settingsScope)
      const before = this.readField(manager, descriptor, settingsScope)
      if (before.revision !== request.expectedRevision) return { outcome: 'conflict', field: before }
      writer.write(manager, undefined, settingsScope)
      await manager.flush()
      await manager.reload()
      const after = this.readField(manager, descriptor, settingsScope)
      const root = configuredSettings(manager, settingsScope)
      if (hasPath(root, descriptor.key)) throw new Error('The native SettingsManager did not reset the requested setting.')
      this.publish({ key: descriptor.key, scope: settingsScope, revision: after.revision })
      return { outcome: 'saved', field: after }
    })
  }

  subscribe(listener: (event: SettingsEventPayload) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async mutateProvider(
    provider: SettingsExtensionProvider,
    descriptor: SettingsDescriptor,
    scope: NativeSettingsScope,
    expectedRevision: number,
    value: unknown,
    reset: boolean,
  ): Promise<SettingsMutationResult> {
    const current = provider.read(descriptor.key, scope)
    if (!current?.editable) throw new TypeError('No editable settings provider is available for this extension field.')
    if (current.revision !== expectedRevision) return { outcome: 'conflict', field: this.readField(this.requireSettingsManager(), descriptor, scope) }
    const outcome = reset
      ? await provider.reset(descriptor.key, scope, expectedRevision)
      : await provider.update(descriptor.key, scope, expectedRevision, value)
    const field = this.readField(this.requireSettingsManager(), descriptor, scope)
    if (outcome === 'saved') this.publish({ key: descriptor.key, scope, revision: field.revision })
    return { outcome, field }
  }

  private async updateModelScope(expectedRevision: number, value: unknown): Promise<SettingsMutationResult> {
    if (!this.models) throw new Error('The native models service is unavailable.')
    if (!modelReferenceList(value)) throw new TypeError('The model scope value is invalid.')
    const current = this.models.readScoped().orderedIds
    const revision = modelScopeRevision(current)
    if (revision !== expectedRevision) {
      return { outcome: 'conflict', field: this.modelScopeField(current) }
    }
    this.models.updateScoped(value)
    const after = this.models.readScoped().orderedIds
    const field = this.modelScopeField(after)
    this.publish({ key: 'models.scoped', scope: 'session', revision: field.revision })
    return { outcome: 'saved', field }
  }

  private modelScopeField(value: readonly ModelReference[]): SettingsFieldValue {
    return {
      key: 'models.scoped',
      value: cleanValue(value),
      effective: cleanValue(value),
      provenance: 'session',
      revision: modelScopeRevision(value),
      editableScopes: this.models ? ['session'] : [],
    }
  }

  private readField(manager: SettingsManager, descriptor: SettingsDescriptor, scope: NativeSettingsScope): SettingsFieldValue {
    if (descriptor.key === 'models.scoped' && scope === 'session' && this.models) {
      return this.modelScopeField(this.models.readScoped().orderedIds)
    }
    const provider = this.extensionProviders.get(descriptor.source)
    if (provider) {
      const snapshot = provider.read(descriptor.key, scope)
      const safe = cleanValue(snapshot?.value)
      const safeEffective = cleanValue(snapshot?.effective ?? snapshot?.value)
      return {
        key: descriptor.key,
        ...(safe === undefined ? {} : { value: safe }),
        ...(safeEffective === undefined ? {} : { effective: safeEffective }),
        provenance: snapshot?.provenance ?? (snapshot ? scope : 'native-readonly'),
        revision: snapshot?.revision ?? hash({ descriptor: descriptor.key, scope }),
        editableScopes: snapshot?.editable ? [scope] : [],
      }
    }

    const selectedRoot = scope === 'session' ? {} : configuredSettings(manager, scope)
    const effectiveRoot = activeSettings(manager)
    const scopedPath = nativePath(descriptor)
    const storedExists = scope !== 'session' && scopedPath !== undefined && hasPath(selectedRoot, scopedPath)
    const value = storedExists ? pathValue(selectedRoot, descriptor) : undefined
    const configuredEffective = descriptor.key === 'cacheWarming'
      ? getPath(manager.getGlobalSettings(), descriptor.key)
      : pathValue(effectiveRoot, descriptor)
    let effectiveValue = configuredEffective
    if (descriptor.key === 'externalEditor' && effectiveValue === undefined) {
      effectiveValue = process.env.VISUAL || process.env.EDITOR || manager.getExternalEditorCommand()
    } else if (descriptor.key === 'terminal.clearOnShrink' && effectiveValue === undefined) {
      effectiveValue = manager.getClearOnShrink()
    } else if (descriptor.key === 'showHardwareCursor' && effectiveValue === undefined) {
      effectiveValue = manager.getShowHardwareCursor()
    }
    const safeValue = cleanValue(value)
    const safeEffective = cleanValue(effectiveValue)
    const powerlineReadable = descriptor.source === 'pi-powerline-footer' && value !== undefined
    const provenance = descriptor.source !== 'native' && !powerlineReadable
      ? 'native-readonly'
      : descriptor.key === 'models.scoped' ? 'native-readonly'
        : effectiveProvenance(descriptor, manager, configuredEffective)
    return {
      key: descriptor.key,
      ...(safeValue === undefined ? {} : { value: safeValue }),
      ...(safeEffective === undefined ? {} : { effective: safeEffective }),
      provenance,
      revision: hash({ scope, value: value === undefined ? { present: false } : value }),
      editableScopes: this.editableScopes(descriptor, manager),
    }
  }

  private editableScopes(descriptor: SettingsDescriptor, manager: SettingsManager): readonly NativeSettingsScope[] {
    if (descriptor.key === 'models.scoped') return this.models ? ['session'] : []
    const provider = this.extensionProviders.get(descriptor.source)
    const trusted = this.projectTrusted?.() ?? manager.isProjectTrusted()
    if (provider) {
      return descriptor.scopes.filter((scope) => (scope !== 'project' || trusted) && provider.read(descriptor.key, scope)?.editable)
    }
    if (descriptor.source !== 'native' || descriptor.readonly !== 'editable') return []
    return descriptor.scopes.filter((scope) => (scope !== 'project' || trusted) && getWriter(descriptor, scope) !== undefined)
  }

  private requireDescriptor(key: string): SettingsDescriptor {
    const descriptor = SETTINGS_DESCRIPTOR_BY_KEY.get(key)
    if (descriptor) return descriptor
    for (const template of SETTINGS_DESCRIPTORS) {
      const marker = template.key.indexOf('{name}')
      if (marker < 0) continue
      const prefix = template.key.slice(0, marker)
      const suffix = template.key.slice(marker + '{name}'.length)
      if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
      const name = key.slice(prefix.length, key.length - suffix.length)
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) continue
      return { ...template, key }
    }
    throw new TypeError('The settings key is not registered.')
  }

  private descriptorsForScope(scope: NativeSettingsScope): readonly SettingsDescriptor[] {
    const descriptors = SETTINGS_DESCRIPTORS.filter((entry) => entry.scopes.includes(scope) && !entry.key.includes('{name}'))
    const expanded = [...this.extensionProviders.values()].flatMap((provider) => provider.descriptors?.(scope) ?? [])
    return [...descriptors, ...expanded]
  }

  private requireSettingsManager(): SettingsManager {
    const manager = this.getSettingsManager()
    if (!manager) throw new Error('The native SettingsManager is unavailable.')
    return manager
  }

  private assertScopeAllowed(manager: SettingsManager, scope: NativeSettingsScope): void {
    if (scope === 'session') return
    const trusted = this.projectTrusted?.() ?? manager.isProjectTrusted()
    if (scope === 'project' && !trusted) throw new Error('Project settings are unavailable until the workspace is trusted.')
  }

  private publish(event: SettingsEventPayload): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* Listener failures do not affect persisted settings. */ }
    }
  }
}
