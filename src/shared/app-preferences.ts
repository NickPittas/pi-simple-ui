import type {} from './ipc-contracts.ts'

export const APP_PREFERENCE_AREAS = [
  'conversation',
  'workers',
  'sessions',
  'models',
  'extensions',
  'settings',
] as const

export type AppPreferenceArea = (typeof APP_PREFERENCE_AREAS)[number]
export type AppTheme = 'system' | 'light' | 'dark'
export type AppDensity = 'comfortable' | 'compact'
export type KeyboardMode = 'standard' | 'vim'
export type TraceRetentionDays = 0 | 1 | 7 | 30 | 90

export interface AppPreferences {
  readonly appearance: {
    readonly theme: AppTheme
    readonly density: AppDensity
    readonly accentColor: string
  }
  readonly layout: {
    readonly sidebar: { readonly visible: boolean; readonly width: number }
    readonly inspector: { readonly visible: boolean; readonly width: number }
    readonly terminal: { readonly visible: boolean; readonly height: number }
  }
  readonly tabs: {
    readonly activeArea: AppPreferenceArea
    readonly openAreas: readonly AppPreferenceArea[]
  }
  /** Persisted only when privacy.persistDrafts is explicitly true. */
  readonly drafts: Readonly<Partial<Record<AppPreferenceArea, string>>>
  readonly notifications: {
    readonly enabled: boolean
    readonly sound: boolean
  }
  readonly accessibility: {
    readonly keyboardMode: KeyboardMode
    readonly reducedMotion: boolean
  }
  readonly privacy: {
    readonly persistDrafts: boolean
    readonly traceRetentionDays: TraceRetentionDays
    readonly shareDiagnostics: boolean
  }
}

export interface PreferencesDiagnostic {
  readonly code: 'CORRUPT_STORE' | 'INVALID_VALUES' | 'MIGRATED' | 'NEWER_SCHEMA'
  /** Static, non-sensitive text. Never includes a path or parse/OS error. */
  readonly message: string
}

export interface AppPreferencesSnapshot {
  readonly schemaVersion: 1
  readonly revision: number
  readonly preferences: AppPreferences
  readonly diagnostic: PreferencesDiagnostic | null
  readonly readOnly: boolean
}

export interface PreferencesMutationResult {
  readonly outcome: 'saved' | 'conflict' | 'read-only'
  readonly snapshot: AppPreferencesSnapshot
}

export type EmptyPreferencesRequest = Record<string, never>
export interface UpdatePreferencesRequest {
  readonly expectedRevision: number
  readonly preferences: AppPreferences
}
export interface ResetPreferencesRequest {
  readonly expectedRevision: number
}

export interface AppPreferencesCapabilityContracts {
  'app.preferences.read': {
    readonly request: EmptyPreferencesRequest
    readonly response: AppPreferencesSnapshot
  }
  'app.preferences.update': {
    readonly request: UpdatePreferencesRequest
    readonly response: PreferencesMutationResult
  }
  'app.preferences.reset': {
    readonly request: ResetPreferencesRequest
    readonly response: PreferencesMutationResult
  }
  'app.preferences.cancel': {
    readonly request: EmptyPreferencesRequest
    readonly response: AppPreferencesSnapshot
  }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends AppPreferencesCapabilityContracts {}
}
