import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import {
  APP_PREFERENCE_AREAS,
  type AppPreferenceArea,
  type AppPreferences,
  type AppPreferencesSnapshot,
  type PreferencesDiagnostic,
  type PreferencesMutationResult,
  type TraceRetentionDays,
} from '../../shared/app-preferences.ts'
import { hasExactKeys, isPlainRecord } from '../../shared/ipc-contracts.ts'

export const APP_PREFERENCES_SCHEMA_VERSION = 1 as const
export const APP_PREFERENCES_MAX_BYTES = 256 * 1024

const DEFAULTS: AppPreferences = {
  appearance: { theme: 'system', density: 'comfortable', accentColor: '#5b6ee1' },
  layout: {
    sidebar: { visible: true, width: 260 },
    inspector: { visible: true, width: 320 },
    terminal: { visible: false, height: 240 },
  },
  tabs: { activeArea: 'conversation', openAreas: ['conversation'] },
  drafts: {},
  notifications: { enabled: true, sound: false },
  accessibility: { keyboardMode: 'standard', reducedMotion: false },
  privacy: { persistDrafts: false, traceRetentionDays: 7, shareDiagnostics: false },
}

const AREA_SET = new Set<string>(APP_PREFERENCE_AREAS)
const RETENTION_DAYS = new Set<number>([0, 1, 7, 30, 90])
const SENSITIVE_FORWARD_KEY = /(?:secret|token|credential|password|provider|api.?key|authorization|mcp|native|session|config)/i
const DIAGNOSTICS: Record<PreferencesDiagnostic['code'], PreferencesDiagnostic> = {
  CORRUPT_STORE: {
    code: 'CORRUPT_STORE',
    message: 'Stored application preferences are invalid. Defaults are active; save or reset to replace them.',
  },
  INVALID_VALUES: {
    code: 'INVALID_VALUES',
    message: 'Some stored preference values were invalid and have been replaced with safe defaults.',
  },
  MIGRATED: {
    code: 'MIGRATED',
    message: 'Stored application preferences use an older schema and will be upgraded on the next save.',
  },
  NEWER_SCHEMA: {
    code: 'NEWER_SCHEMA',
    message: 'Preferences were created by a newer application version and are read-only here.',
  },
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
interface StoredDocument {
  readonly schemaVersion: number
  readonly revision: number
  readonly preferences: AppPreferences
  readonly future: Record<string, JsonValue>
}

interface LoadedStore {
  readonly snapshot: AppPreferencesSnapshot
  readonly future: Record<string, JsonValue>
}

const KNOWN_PREFERENCE_KEYS = [
  'appearance', 'layout', 'tabs', 'drafts', 'notifications', 'accessibility', 'privacy',
] as const
const PREFERENCE_SHAPE = {
  appearance: ['theme', 'density', 'accentColor'],
  layout: {
    sidebar: ['visible', 'width'],
    inspector: ['visible', 'width'],
    terminal: ['visible', 'height'],
  },
  tabs: ['activeArea', 'openAreas'],
  drafts: APP_PREFERENCE_AREAS,
  notifications: ['enabled', 'sound'],
  accessibility: ['keyboardMode', 'reducedMotion'],
  privacy: ['persistDrafts', 'traceRetentionDays', 'shareDiagnostics'],
} as const

function freshDefaults(): AppPreferences {
  return JSON.parse(JSON.stringify(DEFAULTS)) as AppPreferences
}

function isArea(value: unknown): value is AppPreferenceArea {
  return typeof value === 'string' && AREA_SET.has(value)
}

function isEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
}

function isPane(value: unknown, sizeKey: 'width' | 'height', minimum: number, maximum: number): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ['visible', sizeKey])
    && typeof value.visible === 'boolean'
    && isBoundedInteger(value[sizeKey], minimum, maximum)
}

export function isAppPreferences(value: unknown): value is AppPreferences {
  if (!isPlainRecord(value) || !hasExactKeys(value, KNOWN_PREFERENCE_KEYS)) return false
  if (!isPlainRecord(value.appearance)
    || !hasExactKeys(value.appearance, ['theme', 'density', 'accentColor'])
    || !isEnum(value.appearance.theme, ['system', 'light', 'dark'] as const)
    || !isEnum(value.appearance.density, ['comfortable', 'compact'] as const)
    || typeof value.appearance.accentColor !== 'string'
    || !/^#[0-9a-fA-F]{6}$/.test(value.appearance.accentColor)) return false

  if (!isPlainRecord(value.layout)
    || !hasExactKeys(value.layout, ['sidebar', 'inspector', 'terminal'])
    || !isPane(value.layout.sidebar, 'width', 160, 640)
    || !isPane(value.layout.inspector, 'width', 180, 720)
    || !isPane(value.layout.terminal, 'height', 120, 700)) return false

  if (!isPlainRecord(value.tabs)
    || !hasExactKeys(value.tabs, ['activeArea', 'openAreas'])
    || !isArea(value.tabs.activeArea)
    || !Array.isArray(value.tabs.openAreas)
    || value.tabs.openAreas.length === 0
    || value.tabs.openAreas.length > APP_PREFERENCE_AREAS.length
    || !value.tabs.openAreas.every(isArea)
    || new Set(value.tabs.openAreas).size !== value.tabs.openAreas.length
    || !value.tabs.openAreas.includes(value.tabs.activeArea)) return false

  if (!isPlainRecord(value.drafts)
    || Object.keys(value.drafts).length > APP_PREFERENCE_AREAS.length
    || Object.entries(value.drafts).some(([area, draft]) => !isArea(area)
      || typeof draft !== 'string' || draft.length > 16_384)) return false

  if (!isPlainRecord(value.notifications)
    || !hasExactKeys(value.notifications, ['enabled', 'sound'])
    || typeof value.notifications.enabled !== 'boolean'
    || typeof value.notifications.sound !== 'boolean') return false

  if (!isPlainRecord(value.accessibility)
    || !hasExactKeys(value.accessibility, ['keyboardMode', 'reducedMotion'])
    || !isEnum(value.accessibility.keyboardMode, ['standard', 'vim'] as const)
    || typeof value.accessibility.reducedMotion !== 'boolean') return false

  if (!isPlainRecord(value.privacy)
    || !hasExactKeys(value.privacy, ['persistDrafts', 'traceRetentionDays', 'shareDiagnostics'])
    || typeof value.privacy.persistDrafts !== 'boolean'
    || !RETENTION_DAYS.has(value.privacy.traceRetentionDays as number)
    || typeof value.privacy.shareDiagnostics !== 'boolean') return false

  return value.privacy.persistDrafts || Object.keys(value.drafts).length === 0
}

function isDiagnostic(value: unknown): value is PreferencesDiagnostic {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['code', 'message'])) return false
  return Object.hasOwn(DIAGNOSTICS, value.code as string)
    && value.message === DIAGNOSTICS[value.code as PreferencesDiagnostic['code']].message
}

export function isPreferencesSnapshot(value: unknown): value is AppPreferencesSnapshot {
  return isPlainRecord(value)
    && hasExactKeys(value, ['schemaVersion', 'revision', 'preferences', 'diagnostic', 'readOnly'])
    && value.schemaVersion === APP_PREFERENCES_SCHEMA_VERSION
    && isBoundedInteger(value.revision, 0, Number.MAX_SAFE_INTEGER)
    && isAppPreferences(value.preferences)
    && (value.diagnostic === null || isDiagnostic(value.diagnostic))
    && typeof value.readOnly === 'boolean'
}

export function isPreferencesMutationResult(value: unknown): value is PreferencesMutationResult {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome', 'snapshot'])
    && isEnum(value.outcome, ['saved', 'conflict', 'read-only'] as const)
    && isPreferencesSnapshot(value.snapshot)
}

function isRevision(value: unknown): value is number {
  return isBoundedInteger(value, 0, Number.MAX_SAFE_INTEGER)
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {}
}

interface SanitizedPreferences {
  readonly preferences: AppPreferences
  readonly changed: boolean
}

function sanitizePreferences(raw: unknown): SanitizedPreferences {
  const defaults = freshDefaults()
  const input = objectOrEmpty(raw)
  let changed = !isPlainRecord(raw)

  const markInvalid = (valid: boolean): void => { if (!valid) changed = true }
  const appearance = objectOrEmpty(input.appearance)
  const layout = objectOrEmpty(input.layout)
  const tabs = objectOrEmpty(input.tabs)
  const notifications = objectOrEmpty(input.notifications)
  const accessibility = objectOrEmpty(input.accessibility)
  const privacy = objectOrEmpty(input.privacy)

  const theme = isEnum(appearance.theme, ['system', 'light', 'dark'] as const)
    ? appearance.theme : defaults.appearance.theme
  const density = isEnum(appearance.density, ['comfortable', 'compact'] as const)
    ? appearance.density : defaults.appearance.density
  const accentColor = typeof appearance.accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(appearance.accentColor)
    ? appearance.accentColor : defaults.appearance.accentColor
  markInvalid(theme === appearance.theme)
  markInvalid(density === appearance.density)
  markInvalid(accentColor === appearance.accentColor)

  const sidebarRaw = objectOrEmpty(layout.sidebar)
  const inspectorRaw = objectOrEmpty(layout.inspector)
  const terminalRaw = objectOrEmpty(layout.terminal)
  const sidebar = {
    visible: typeof sidebarRaw.visible === 'boolean' ? sidebarRaw.visible : defaults.layout.sidebar.visible,
    width: isBoundedInteger(sidebarRaw.width, 160, 640) ? sidebarRaw.width : defaults.layout.sidebar.width,
  }
  const inspector = {
    visible: typeof inspectorRaw.visible === 'boolean' ? inspectorRaw.visible : defaults.layout.inspector.visible,
    width: isBoundedInteger(inspectorRaw.width, 180, 720) ? inspectorRaw.width : defaults.layout.inspector.width,
  }
  const terminal = {
    visible: typeof terminalRaw.visible === 'boolean' ? terminalRaw.visible : defaults.layout.terminal.visible,
    height: isBoundedInteger(terminalRaw.height, 120, 700) ? terminalRaw.height : defaults.layout.terminal.height,
  }
  markInvalid(typeof sidebarRaw.visible === 'boolean' && isBoundedInteger(sidebarRaw.width, 160, 640))
  markInvalid(typeof inspectorRaw.visible === 'boolean' && isBoundedInteger(inspectorRaw.width, 180, 720))
  markInvalid(typeof terminalRaw.visible === 'boolean' && isBoundedInteger(terminalRaw.height, 120, 700))

  const activeArea = isArea(tabs.activeArea) ? tabs.activeArea : defaults.tabs.activeArea
  let openAreas = Array.isArray(tabs.openAreas) && tabs.openAreas.length > 0
    && tabs.openAreas.length <= APP_PREFERENCE_AREAS.length && tabs.openAreas.every(isArea)
    ? [...new Set(tabs.openAreas)] as AppPreferenceArea[]
    : [...defaults.tabs.openAreas]
  if (!openAreas.includes(activeArea)) openAreas = [...openAreas, activeArea]
  markInvalid(activeArea === tabs.activeArea
    && Array.isArray(tabs.openAreas)
    && tabs.openAreas.length === openAreas.length
    && tabs.openAreas.every((area, index) => area === openAreas[index]))

  const persistDrafts = typeof privacy.persistDrafts === 'boolean'
    ? privacy.persistDrafts : defaults.privacy.persistDrafts
  const draftsRaw = objectOrEmpty(input.drafts)
  const drafts: Partial<Record<AppPreferenceArea, string>> = {}
  if (persistDrafts) {
    for (const [area, draft] of Object.entries(draftsRaw)) {
      if (isArea(area) && typeof draft === 'string' && draft.length <= 16_384) drafts[area] = draft
      else changed = true
    }
  } else if (Object.keys(draftsRaw).length > 0) {
    changed = true
  }
  markInvalid(typeof privacy.persistDrafts === 'boolean')

  const retention = RETENTION_DAYS.has(privacy.traceRetentionDays as number)
    ? privacy.traceRetentionDays as TraceRetentionDays : defaults.privacy.traceRetentionDays
  const shareDiagnostics = typeof privacy.shareDiagnostics === 'boolean'
    ? privacy.shareDiagnostics : defaults.privacy.shareDiagnostics
  markInvalid(retention === privacy.traceRetentionDays)
  markInvalid(typeof privacy.shareDiagnostics === 'boolean')

  const keyboardMode = isEnum(accessibility.keyboardMode, ['standard', 'vim'] as const)
    ? accessibility.keyboardMode : defaults.accessibility.keyboardMode
  const reducedMotion = typeof accessibility.reducedMotion === 'boolean'
    ? accessibility.reducedMotion : defaults.accessibility.reducedMotion
  markInvalid(keyboardMode === accessibility.keyboardMode)
  markInvalid(typeof accessibility.reducedMotion === 'boolean')

  const enabled = typeof notifications.enabled === 'boolean'
    ? notifications.enabled : defaults.notifications.enabled
  const sound = typeof notifications.sound === 'boolean'
    ? notifications.sound : defaults.notifications.sound
  markInvalid(typeof notifications.enabled === 'boolean')
  markInvalid(typeof notifications.sound === 'boolean')

  return {
    preferences: {
      appearance: { theme, density, accentColor },
      layout: { sidebar, inspector, terminal },
      tabs: { activeArea, openAreas },
      drafts,
      notifications: { enabled, sound },
      accessibility: { keyboardMode, reducedMotion },
      privacy: { persistDrafts, traceRetentionDays: retention, shareDiagnostics },
    },
    changed,
  }
}

const DROP = Symbol('drop')
type SanitizedForwardValue = JsonValue | typeof DROP

function sanitizeForwardValue(value: unknown, depth = 0): { value: SanitizedForwardValue; changed: boolean } {
  if (depth > 8) return { value: DROP, changed: true }
  if (value === null || typeof value === 'boolean') return { value, changed: false }
  if (typeof value === 'number') return Number.isFinite(value) ? { value, changed: false } : { value: DROP, changed: true }
  if (typeof value === 'string') return value.length <= 8_192 ? { value, changed: false } : { value: DROP, changed: true }
  if (Array.isArray(value)) {
    if (value.length > 64) return { value: DROP, changed: true }
    let changed = false
    const result: JsonValue[] = []
    for (const item of value) {
      const child = sanitizeForwardValue(item, depth + 1)
      changed ||= child.changed || child.value === DROP
      if (child.value !== DROP) result.push(child.value)
    }
    return { value: result, changed }
  }
  if (!isPlainRecord(value) || Object.keys(value).length > 64) return { value: DROP, changed: true }

  let changed = false
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)
      || key === 'constructor' || key === 'prototype' || SENSITIVE_FORWARD_KEY.test(key)) {
      changed = true
      continue
    }
    const child = sanitizeForwardValue(item, depth + 1)
    changed ||= child.changed || child.value === DROP
    if (child.value !== DROP) result[key] = child.value
  }
  return { value: result, changed }
}

function safeFutureObject(value: unknown): { value: Record<string, JsonValue>; changed: boolean } {
  const result = sanitizeForwardValue(value)
  if (!isPlainRecord(result.value)) return { value: Object.create(null) as Record<string, JsonValue>, changed: true }
  return { value: result.value as Record<string, JsonValue>, changed: result.changed }
}

function mergeForward(
  base: Record<string, JsonValue>,
  extra: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = Object.assign(Object.create(null), base)
  for (const [key, value] of Object.entries(extra)) {
    const previous = result[key]
    if (isPlainRecord(previous) && isPlainRecord(value)) {
      result[key] = mergeForward(previous as Record<string, JsonValue>, value as Record<string, JsonValue>)
    } else if (!Object.hasOwn(result, key)) {
      result[key] = value
    }
  }
  return result
}

function withoutKeys(value: Record<string, unknown>, excluded: readonly string[]): Record<string, unknown> {
  const omit = new Set(excluded)
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omit.has(key)))
}

type PreferenceShape = readonly string[] | { readonly [key: string]: PreferenceShape }

function collectUnknownFields(value: unknown, shape: PreferenceShape): Record<string, unknown> {
  if (!isPlainRecord(value)) return {}
  const objectShape = Array.isArray(shape) ? undefined : shape as Readonly<Record<string, PreferenceShape>>
  const knownKeys = objectShape ? Object.keys(objectShape) : shape as readonly string[]
  const unknown: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (!knownKeys.includes(key)) {
      unknown[key] = child
      continue
    }
    const childShape = objectShape?.[key]
    if (childShape) {
      const nested = collectUnknownFields(child, childShape)
      if (Object.keys(nested).length > 0) unknown[key] = nested
    }
  }
  return unknown
}

function diagnostic(code: PreferencesDiagnostic['code'] | null): PreferencesDiagnostic | null {
  return code ? DIAGNOSTICS[code] : null
}

function snapshot(
  revision: number,
  preferences: AppPreferences,
  code: PreferencesDiagnostic['code'] | null,
  readOnly = false,
): AppPreferencesSnapshot {
  return {
    schemaVersion: APP_PREFERENCES_SCHEMA_VERSION,
    revision,
    preferences: JSON.parse(JSON.stringify(preferences)) as AppPreferences,
    diagnostic: diagnostic(code),
    readOnly,
  }
}

function corruptStore(): LoadedStore {
  return { snapshot: snapshot(0, freshDefaults(), 'CORRUPT_STORE'), future: Object.create(null) as Record<string, JsonValue> }
}

function currentSchemaLoaded(document: Record<string, unknown>): LoadedStore {
  if (!isRevision(document.revision) || !isPlainRecord(document.preferences)) return corruptStore()
  const normalized = sanitizePreferences(document.preferences)
  const cleanFuture = safeFutureObject(document.future ?? {})
  const unknownPreferenceFields = collectUnknownFields(document.preferences, PREFERENCE_SHAPE)
  if (!normalized.preferences.privacy.persistDrafts) delete unknownPreferenceFields.drafts
  const safeUnknownPreferences = safeFutureObject(unknownPreferenceFields)
  const unknownRootFields = withoutKeys(document, ['schemaVersion', 'revision', 'preferences', 'future'])
  const safeUnknownRoot = safeFutureObject(unknownRootFields)
  let future = cleanFuture.value
  if (Object.keys(safeUnknownPreferences.value).length > 0) {
    future = mergeForward(future, { preferenceFields: safeUnknownPreferences.value })
  }
  if (Object.keys(safeUnknownRoot.value).length > 0) {
    future = mergeForward(future, { storeFields: safeUnknownRoot.value })
  }
  const changed = normalized.changed || cleanFuture.changed || safeUnknownPreferences.changed || safeUnknownRoot.changed
  return {
    snapshot: snapshot(document.revision, normalized.preferences, changed ? 'INVALID_VALUES' : null),
    future,
  }
}

const LEGACY_PREFERENCE_KEYS = [
  'theme', 'density', 'accentColor', 'leftPaneWidth', 'leftPaneVisible', 'rightPaneWidth', 'rightPaneVisible',
  'terminalHeight', 'terminalVisible', 'activeTab', 'openTabs', 'drafts', 'persistDrafts',
  'notificationsEnabled', 'notificationSound', 'keyboardMode', 'reducedMotion', 'traceRetentionDays',
  'shareDiagnostics',
] as const

function migratedSchemaLoaded(document: Record<string, unknown>): LoadedStore {
  const revision = document.revision === undefined ? 0 : document.revision
  if (!isRevision(revision)) return corruptStore()
  const legacy = objectOrEmpty(document.preferences)
  const persistDrafts = legacy.persistDrafts === true
  const candidate = {
    appearance: {
      theme: legacy.theme,
      density: legacy.density,
      accentColor: legacy.accentColor,
    },
    layout: {
      sidebar: { visible: legacy.leftPaneVisible, width: legacy.leftPaneWidth },
      inspector: { visible: legacy.rightPaneVisible, width: legacy.rightPaneWidth },
      terminal: { visible: legacy.terminalVisible, height: legacy.terminalHeight },
    },
    tabs: { activeArea: legacy.activeTab, openAreas: legacy.openTabs },
    drafts: persistDrafts ? legacy.drafts : {},
    notifications: { enabled: legacy.notificationsEnabled, sound: legacy.notificationSound },
    accessibility: { keyboardMode: legacy.keyboardMode, reducedMotion: legacy.reducedMotion },
    privacy: {
      persistDrafts,
      traceRetentionDays: legacy.traceRetentionDays,
      shareDiagnostics: legacy.shareDiagnostics,
    },
  }
  const normalized = sanitizePreferences(candidate)
  const cleanFuture = safeFutureObject(document.future ?? {})
  const unknownLegacy = safeFutureObject(withoutKeys(legacy, LEGACY_PREFERENCE_KEYS))
  const unknownRoot = safeFutureObject(withoutKeys(document, ['schemaVersion', 'revision', 'preferences', 'future']))
  let future = cleanFuture.value
  if (Object.keys(unknownLegacy.value).length > 0) {
    future = mergeForward(future, { legacyPreferenceFields: unknownLegacy.value })
  }
  if (Object.keys(unknownRoot.value).length > 0) {
    future = mergeForward(future, { storeFields: unknownRoot.value })
  }
  return {
    snapshot: snapshot(revision, normalized.preferences,
      normalized.changed || cleanFuture.changed || unknownLegacy.changed || unknownRoot.changed
        ? 'INVALID_VALUES' : 'MIGRATED'),
    future,
  }
}

export class AppPreferencesStore {
  readonly filePath: string

  constructor(filePath: string) {
    if (!isAbsolute(filePath) || filePath.includes('\0')) {
      throw new TypeError('Application preferences path must be absolute.')
    }
    this.filePath = filePath
  }

  read(): AppPreferencesSnapshot {
    return this.load().snapshot
  }

  /** Cancel is intentionally a read-only operation; UI drafts remain renderer-local. */
  cancel(): AppPreferencesSnapshot {
    return this.read()
  }

  update(expectedRevision: number, preferences: AppPreferences): PreferencesMutationResult {
    return this.commit(expectedRevision, preferences)
  }

  reset(expectedRevision: number): PreferencesMutationResult {
    return this.commit(expectedRevision, freshDefaults())
  }

  private commit(expectedRevision: number, preferences: AppPreferences): PreferencesMutationResult {
    if (!isRevision(expectedRevision) || !isAppPreferences(preferences)) {
      throw new TypeError('Application preference update is invalid.')
    }
    const current = this.load()
    if (current.snapshot.readOnly) return { outcome: 'read-only', snapshot: current.snapshot }
    if (current.snapshot.revision !== expectedRevision) {
      return { outcome: 'conflict', snapshot: current.snapshot }
    }
    if (expectedRevision === Number.MAX_SAFE_INTEGER) {
      return { outcome: 'read-only', snapshot: snapshot(expectedRevision, current.snapshot.preferences, 'INVALID_VALUES', true) }
    }

    const nextRevision = expectedRevision + 1
    const document: StoredDocument = {
      schemaVersion: APP_PREFERENCES_SCHEMA_VERSION,
      revision: nextRevision,
      preferences: JSON.parse(JSON.stringify(preferences)) as AppPreferences,
      future: current.future,
    }
    const text = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') > APP_PREFERENCES_MAX_BYTES) {
      throw new TypeError('Application preferences exceed the storage limit.')
    }
    this.atomicWrite(text)
    return { outcome: 'saved', snapshot: snapshot(nextRevision, document.preferences, null) }
  }

  private load(): LoadedStore {
    let descriptor: number
    try {
      descriptor = openSync(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return { snapshot: snapshot(0, freshDefaults(), null), future: Object.create(null) as Record<string, JsonValue> }
      }
      if (code === 'ELOOP' || code === 'EMLINK') return corruptStore()
      throw error
    }

    try {
      const details = fstatSync(descriptor)
      if (!details.isFile() || details.size > APP_PREFERENCES_MAX_BYTES) return corruptStore()
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(descriptor, 'utf8'))
      } catch {
        return corruptStore()
      }
      if (!isPlainRecord(raw) || !Number.isSafeInteger(raw.schemaVersion) || (raw.schemaVersion as number) < 0) {
        return corruptStore()
      }
      const version = raw.schemaVersion as number
      if (version === APP_PREFERENCES_SCHEMA_VERSION) return currentSchemaLoaded(raw)
      if (version === 0) return migratedSchemaLoaded(raw)
      if (version > APP_PREFERENCES_SCHEMA_VERSION) {
        const revision = isRevision(raw.revision) ? raw.revision : 0
        const preferences = sanitizePreferences(raw.preferences).preferences
        return { snapshot: snapshot(revision, preferences, 'NEWER_SCHEMA', true), future: Object.create(null) as Record<string, JsonValue> }
      }
      return corruptStore()
    } finally {
      closeSync(descriptor)
    }
  }

  private atomicWrite(contents: string): void {
    const directory = dirname(this.filePath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = join(directory, `.${randomUUID()}.app-preferences.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600)
      writeFileSync(descriptor, contents, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporaryPath, this.filePath)
      try {
        const directoryDescriptor = openSync(directory, 'r')
        try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
      } catch {
        // Directory fsync is not supported on every platform; the file itself was synced and renamed.
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
    }
  }
}

export function defaultAppPreferences(): AppPreferences {
  return freshDefaults()
}
