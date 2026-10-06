import type { CapabilityDefinition, AuthorizedIpcCaller } from './register.ts'
import {
  hasExactKeys,
  isPlainRecord,
  isRuntimeScope,
  type RuntimeScope,
} from '../../shared/ipc-contracts.ts'
import {
  type DiagnosticConfigSource,
  type DiagnosticLevel,
  type DiagnosticLogEntry,
  type DiagnosticSubsystem,
  type DiagnosticWorkspaceTrust,
  DIAGNOSTIC_SUBSYSTEMS,
  type DiagnosticsCapabilityContracts,
  type DiagnosticsConfigSnapshot,
  type DiagnosticsExportResult,
  type DiagnosticsSnapshot,
  type DiagnosticsTrustSnapshot,
  type EmptyDiagnosticsRequest,
} from '../../shared/diagnostics.ts'
import type { TraceRetentionDays } from '../../shared/app-preferences.ts'
import type { WorkspaceStatus, WorkspaceTrustDecision } from '../../shared/workspaces.ts'
import type { DiagnosticLogService } from '../logging/log-service.ts'

export const DIAGNOSTICS_IPC = Object.freeze({
  read: 'diagnostics.read',
  export: 'diagnostics.export',
  trust: 'diagnostics.trust',
})

export type DiagnosticsCapabilityDefinition = {
  [K in keyof DiagnosticsCapabilityContracts]: CapabilityDefinition<
    DiagnosticsCapabilityContracts[K]['request'],
    DiagnosticsCapabilityContracts[K]['response']
  >
}[keyof DiagnosticsCapabilityContracts]

export interface DiagnosticsCapabilityRouter {
  isCallerAuthorized(caller: AuthorizedIpcCaller): boolean
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): DiagnosticLogService | undefined
}

const LEVELS: readonly DiagnosticLevel[] = ['debug', 'info', 'warn', 'error']
const TRUST_DECISIONS: readonly WorkspaceTrustDecision[] = ['trusted', 'denied', 'undecided']
const WORKSPACE_STATUSES: readonly WorkspaceStatus[] = ['available', 'missing', 'moved']
const CONFIG_SOURCES: readonly DiagnosticConfigSource[] = [
  'user', 'project', 'session', 'override', 'environment', 'default', 'native-readonly',
]
const RETENTION_DAYS: readonly TraceRetentionDays[] = [0, 1, 7, 30, 90]

function isEmptyRequest(value: unknown): value is EmptyDiagnosticsRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

function isDiagnosticJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 8_192
  if (Array.isArray(value)) return value.length <= 101 && value.every((entry) => isDiagnosticJson(entry, depth + 1))
  if (!isPlainRecord(value) || Object.keys(value).length > 101) return false
  return Object.values(value).every((entry) => isDiagnosticJson(entry, depth + 1))
}

function isDiagnosticEntry(value: unknown): value is DiagnosticLogEntry {
  if (!isPlainRecord(value)) return false
  const keys = Object.hasOwn(value, 'details')
    ? ['timestamp', 'level', 'subsystem', 'message', 'details']
    : ['timestamp', 'level', 'subsystem', 'message']
  return hasExactKeys(value, keys)
    && Number.isSafeInteger(value.timestamp)
    && (value.timestamp as number) >= 0
    && LEVELS.includes(value.level as DiagnosticLevel)
    && DIAGNOSTIC_SUBSYSTEMS.includes(value.subsystem as DiagnosticSubsystem)
    && typeof value.message === 'string'
    && value.message.length <= 4_096
    && (!Object.hasOwn(value, 'details') || isDiagnosticJson(value.details))
}

function isWorkspaceTrust(value: unknown): value is DiagnosticWorkspaceTrust {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      'workspaceId', 'path', 'workspaceStatus', 'active', 'decision', 'sourcePath', 'inherited', 'requiresReapproval',
    ])
    && typeof value.workspaceId === 'string'
    && /^[a-f0-9-]{36}$/i.test(value.workspaceId)
    && typeof value.path === 'string'
    && value.path.length > 0
    && value.path.length <= 4_096
    && WORKSPACE_STATUSES.includes(value.workspaceStatus as WorkspaceStatus)
    && typeof value.active === 'boolean'
    && TRUST_DECISIONS.includes(value.decision as WorkspaceTrustDecision)
    && (value.sourcePath === null || typeof value.sourcePath === 'string' && value.sourcePath.length <= 4_096)
    && typeof value.inherited === 'boolean'
    && typeof value.requiresReapproval === 'boolean'
}

function isTrustSnapshot(value: unknown): value is DiagnosticsTrustSnapshot {
  return isPlainRecord(value)
    && hasExactKeys(value, ['status', 'source', 'workspaces'])
    && (value.status === 'available' || value.status === 'unavailable')
    && value.source === 'pi-project-trust-store'
    && Array.isArray(value.workspaces)
    && value.workspaces.length <= 50
    && value.workspaces.every(isWorkspaceTrust)
}

function isConfigField(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ['setting', 'source'])
    && typeof value.setting === 'string'
    && value.setting.length > 0
    && value.setting.length <= 256
    && CONFIG_SOURCES.includes(value.source as DiagnosticConfigSource)
}

function isConfigSnapshot(value: unknown): value is DiagnosticsConfigSnapshot {
  return isPlainRecord(value)
    && hasExactKeys(value, ['status', 'scope', 'fields'])
    && (value.status === 'available' || value.status === 'unavailable')
    && (value.scope === 'user' || value.scope === 'project')
    && Array.isArray(value.fields)
    && value.fields.length <= 1_000
    && value.fields.every(isConfigField)
}

function isDiagnosticsSnapshot(value: unknown): value is DiagnosticsSnapshot {
  return isPlainRecord(value)
    && hasExactKeys(value, ['generatedAt', 'retentionDays', 'entries', 'trust', 'config'])
    && Number.isSafeInteger(value.generatedAt)
    && (value.generatedAt as number) >= 0
    && RETENTION_DAYS.includes(value.retentionDays as TraceRetentionDays)
    && Array.isArray(value.entries)
    && value.entries.length <= 500
    && value.entries.every(isDiagnosticEntry)
    && isTrustSnapshot(value.trust)
    && isConfigSnapshot(value.config)
}

function isExportResult(value: unknown): value is DiagnosticsExportResult {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'saved' || value.outcome === 'cancelled' || value.outcome === 'failed')
}

function requireService(
  router: DiagnosticsCapabilityRouter,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): DiagnosticLogService {
  if (!scope || !isRuntimeScope(scope)) throw new Error('A valid runtime scope is required for diagnostics.')
  const service = router.resolve(caller, scope)
  if (!service) throw new Error('No diagnostics service is bound to this caller and runtime scope.')
  return service
}

/** Return runtime-scoped descriptors; the parent resolves services only for an authorized caller/scope pair. */
export function registerDiagnosticsCapabilities(router: DiagnosticsCapabilityRouter): readonly DiagnosticsCapabilityDefinition[] {
  const read: CapabilityDefinition<EmptyDiagnosticsRequest, DiagnosticsSnapshot> = {
    id: DIAGNOSTICS_IPC.read,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isDiagnosticsSnapshot,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }) => requireService(router, caller, scope).read(),
  }
  const exportDiagnostics: CapabilityDefinition<EmptyDiagnosticsRequest, DiagnosticsExportResult> = {
    id: DIAGNOSTICS_IPC.export,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isExportResult,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }) => requireService(router, caller, scope).export(),
  }
  const trust: CapabilityDefinition<EmptyDiagnosticsRequest, DiagnosticsTrustSnapshot> = {
    id: DIAGNOSTICS_IPC.trust,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isTrustSnapshot,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }) => requireService(router, caller, scope).trust(),
  }
  return [read, exportDiagnostics, trust]
}
