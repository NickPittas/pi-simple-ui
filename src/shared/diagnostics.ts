import type {} from './ipc-contracts.ts'
import type { WorkspaceStatus, WorkspaceTrustDecision } from './workspaces.ts'
import type { TraceRetentionDays } from './app-preferences.ts'

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'

export const DIAGNOSTIC_SUBSYSTEMS = [
  'app',
  'auth',
  'codemode',
  'extensions',
  'ipc',
  'logging',
  'mcp',
  'models',
  'security',
  'sessions',
  'settings',
  'startup',
  'workers',
  'workspaces',
] as const

export type DiagnosticSubsystem = (typeof DIAGNOSTIC_SUBSYSTEMS)[number]
export type DiagnosticConfigSource = 'user' | 'project' | 'session' | 'override' | 'environment' | 'default' | 'native-readonly'
export type DiagnosticJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly DiagnosticJsonValue[]
  | { readonly [key: string]: DiagnosticJsonValue }

export interface DiagnosticLogEntry {
  readonly timestamp: number
  readonly level: DiagnosticLevel
  readonly subsystem: DiagnosticSubsystem
  readonly message: string
  readonly details?: DiagnosticJsonValue
}

export interface DiagnosticWorkspaceTrust {
  readonly workspaceId: string
  readonly path: string
  readonly workspaceStatus: WorkspaceStatus
  readonly active: boolean
  readonly decision: WorkspaceTrustDecision
  readonly sourcePath: string | null
  readonly inherited: boolean
  readonly requiresReapproval: boolean
}

export interface DiagnosticsTrustSnapshot {
  readonly status: 'available' | 'unavailable'
  /** WorkspaceService.list() derives each entry by reading ProjectTrustStore on every call. */
  readonly source: 'pi-project-trust-store'
  readonly workspaces: readonly DiagnosticWorkspaceTrust[]
}

export interface DiagnosticConfigProvenance {
  readonly setting: string
  readonly source: DiagnosticConfigSource
}

export interface DiagnosticsConfigSnapshot {
  readonly status: 'available' | 'unavailable'
  readonly scope: 'user' | 'project'
  /** Provenance only; effective setting values and credential material are not exported. */
  readonly fields: readonly DiagnosticConfigProvenance[]
}

export interface DiagnosticsSnapshot {
  readonly generatedAt: number
  readonly retentionDays: TraceRetentionDays
  readonly entries: readonly DiagnosticLogEntry[]
  readonly trust: DiagnosticsTrustSnapshot
  readonly config: DiagnosticsConfigSnapshot
}

export interface DiagnosticsExportResult {
  readonly outcome: 'saved' | 'cancelled' | 'failed'
}

export interface EmptyDiagnosticsRequest extends Record<string, never> {}

export interface DiagnosticsCapabilityContracts {
  'diagnostics.read': {
    readonly request: EmptyDiagnosticsRequest
    readonly response: DiagnosticsSnapshot
  }
  'diagnostics.export': {
    readonly request: EmptyDiagnosticsRequest
    readonly response: DiagnosticsExportResult
  }
  'diagnostics.trust': {
    readonly request: EmptyDiagnosticsRequest
    readonly response: DiagnosticsTrustSnapshot
  }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends DiagnosticsCapabilityContracts {}
}
