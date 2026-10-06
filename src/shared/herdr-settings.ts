import type {} from './ipc-contracts.ts'

export const HERDR_SETTINGS_PROVIDER = 'pi-herdr-agents' as const
export type HerdrSettingsProvider = typeof HERDR_SETTINGS_PROVIDER
export type HerdrSettingsScope = 'user' | 'project'
export type HerdrSettingsTarget = 'config' | 'definitions' | 'definition'

export type HerdrJsonValue = null | boolean | number | string | HerdrJsonValue[] | { readonly [key: string]: HerdrJsonValue }
export type HerdrJsonObject = { readonly [key: string]: HerdrJsonValue }

export interface HerdrSettingsValidationIssue {
  readonly path: string
  readonly message: string
  readonly severity: 'warning' | 'error'
}

export interface HerdrDefinitionSummary {
  readonly name: string
  readonly scope: HerdrSettingsScope
  readonly revision: number
  readonly exists: boolean
  readonly hasFrontmatter: boolean
  /** Source-recognized scalar frontmatter only; the definition body is never returned. */
  readonly metadata: Readonly<Record<string, string>>
  readonly validation: readonly HerdrSettingsValidationIssue[]
}

export interface HerdrConfigSnapshot {
  readonly provider: HerdrSettingsProvider
  readonly target: 'config'
  readonly scope: 'user'
  readonly revision: number
  readonly exists: boolean
  /** The stored JSON shape as-is (including absent fields and safe unknown fields). */
  readonly settings: HerdrJsonObject
  readonly validation: readonly HerdrSettingsValidationIssue[]
}

export interface HerdrDefinitionsSnapshot {
  readonly provider: HerdrSettingsProvider
  readonly target: 'definitions'
  readonly scope: HerdrSettingsScope
  readonly definitions: readonly HerdrDefinitionSummary[]
}

export interface HerdrDefinitionSnapshot {
  readonly provider: HerdrSettingsProvider
  readonly target: 'definition'
  readonly scope: HerdrSettingsScope
  readonly definition: HerdrDefinitionSummary
}

export type HerdrSettingsSnapshot = HerdrConfigSnapshot | HerdrDefinitionsSnapshot | HerdrDefinitionSnapshot

export type HerdrSettingsReadRequest =
  | { readonly provider: HerdrSettingsProvider; readonly target: 'config'; readonly scope: 'user' }
  | { readonly provider: HerdrSettingsProvider; readonly target: 'definitions'; readonly scope: HerdrSettingsScope }
  | { readonly provider: HerdrSettingsProvider; readonly target: 'definition'; readonly scope: HerdrSettingsScope; readonly name: string }

export type HerdrSettingsUpdateRequest =
  | {
      readonly provider: HerdrSettingsProvider
      readonly target: 'config'
      readonly scope: 'user'
      readonly expectedRevision: number
      readonly patch: HerdrJsonObject
      readonly removePaths: readonly string[]
    }
  | {
      readonly provider: HerdrSettingsProvider
      readonly target: 'definition'
      readonly scope: HerdrSettingsScope
      readonly name: string
      readonly expectedRevision: number
      readonly metadata: Readonly<Record<string, string | null>>
    }

export interface HerdrSettingsMutationResult {
  readonly outcome: 'saved' | 'conflict'
  readonly snapshot: HerdrConfigSnapshot | HerdrDefinitionSnapshot
}

export interface HerdrSettingsCapabilityContracts {
  'herdr.settings.read': {
    readonly request: HerdrSettingsReadRequest
    readonly response: HerdrSettingsSnapshot
  }
  'herdr.settings.update': {
    readonly request: HerdrSettingsUpdateRequest
    readonly response: HerdrSettingsMutationResult
  }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends HerdrSettingsCapabilityContracts {}
}
