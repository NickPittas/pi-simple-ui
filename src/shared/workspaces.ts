import type { RuntimeScope } from './ipc-contracts.ts'

export type WorkspaceStatus = 'available' | 'missing' | 'moved'
export type WorkspaceTrustDecision = 'trusted' | 'denied' | 'undecided' | 'native-managed'

export type WorkspaceTrustProvenance =
  | {
      readonly decision: Exclude<WorkspaceTrustDecision, 'native-managed'>
      readonly sourcePath: string | null
      readonly inherited: boolean
      /** An exact native path approval no longer matches the recorded directory identity. */
      readonly requiresReapproval: boolean
    }
  | {
      readonly decision: 'native-managed'
      readonly sourcePath: null
      readonly inherited: false
      readonly requiresReapproval: false
    }

export interface WorkspaceInfo {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly status: WorkspaceStatus
  readonly firstOpenedAt: number
  readonly lastOpenedAt: number
  readonly movedFrom: string | null
  readonly trust: WorkspaceTrustProvenance
}

export interface WorkspaceSnapshot {
  readonly generation: number
  readonly runtimeScope: RuntimeScope
  readonly activeWorkspaceId: string | null
  readonly pendingPath: string | null
  readonly workspaces: readonly WorkspaceInfo[]
}

export interface WorkspaceOperationResult {
  readonly outcome: 'opened' | 'trust-updated' | 'cancelled' | 'closed' | 'missing'
  readonly snapshot: WorkspaceSnapshot
}

export interface EmptyWorkspaceRequest {
  readonly [key: string]: never
}

export interface OpenWorkspaceRequest {
  readonly path: string
}

export interface WorkspaceTrustRequest {
  readonly workspaceId: string
}

export interface OpenRecentWorkspaceRequest {
  readonly workspaceId: string
}

export interface WorkspaceFolderPickerResult {
  readonly path: string | null
}

export interface WorkspaceCapabilityContracts {
  'workspaces.list': {
    readonly request: EmptyWorkspaceRequest
    readonly response: WorkspaceSnapshot
  }
  'workspaces.pick-folder': {
    readonly request: EmptyWorkspaceRequest
    readonly response: WorkspaceFolderPickerResult
  }
  'workspaces.open': {
    readonly request: OpenWorkspaceRequest
    readonly response: WorkspaceOperationResult
  }
  'workspaces.open-recent': {
    readonly request: OpenRecentWorkspaceRequest
    readonly response: WorkspaceOperationResult
  }
  'workspaces.trust.grant': {
    readonly request: WorkspaceTrustRequest
    readonly response: WorkspaceOperationResult
  }
  'workspaces.trust.revoke': {
    readonly request: WorkspaceTrustRequest
    readonly response: WorkspaceOperationResult
  }
  'workspaces.cancel': {
    readonly request: EmptyWorkspaceRequest
    readonly response: WorkspaceOperationResult
  }
}

export function isWorkspaceFolderPickerResult(value: unknown): value is WorkspaceFolderPickerResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1
    && Object.hasOwn(record, 'path')
    && (record.path === null || (typeof record.path === 'string' && record.path.length > 0 && record.path.length <= 4096))
}

export interface WorkspaceEventPayload {
  readonly reason: 'switching' | 'opened' | 'trust-changed' | 'cancelled' | 'missing' | 'changed'
  readonly snapshot: WorkspaceSnapshot
}

export interface WorkspaceEventContracts {
  'workspaces.changed': { readonly payload: WorkspaceEventPayload }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends WorkspaceCapabilityContracts {}
  interface IpcEventContracts extends WorkspaceEventContracts {}
}

function isTrustProvenance(value: unknown): value is WorkspaceTrustProvenance {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 4
    && ['decision', 'sourcePath', 'inherited', 'requiresReapproval'].every((key) => Object.hasOwn(record, key))
    && (record.decision === 'native-managed'
      ? record.sourcePath === null && record.inherited === false && record.requiresReapproval === false
      : (record.decision === 'trusted' || record.decision === 'denied' || record.decision === 'undecided')
        && (record.sourcePath === null || (typeof record.sourcePath === 'string' && record.sourcePath.length <= 4096))
        && typeof record.inherited === 'boolean'
        && typeof record.requiresReapproval === 'boolean')
}

function isWorkspaceInfo(value: unknown): value is WorkspaceInfo {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = ['id', 'path', 'name', 'status', 'firstOpenedAt', 'lastOpenedAt', 'movedFrom', 'trust']
  return Object.keys(record).length === keys.length
    && keys.every((key) => Object.hasOwn(record, key))
    && typeof record.id === 'string' && /^[a-f0-9-]{36}$/i.test(record.id)
    && typeof record.path === 'string' && record.path.length > 0 && record.path.length <= 4096
    && typeof record.name === 'string' && record.name.length <= 256
    && (record.status === 'available' || record.status === 'missing' || record.status === 'moved')
    && Number.isSafeInteger(record.firstOpenedAt) && (record.firstOpenedAt as number) >= 0
    && Number.isSafeInteger(record.lastOpenedAt) && (record.lastOpenedAt as number) >= 0
    && (record.movedFrom === null || (typeof record.movedFrom === 'string' && record.movedFrom.length <= 4096))
    && isTrustProvenance(record.trust)
}

export function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const scope = record.runtimeScope
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return false
  const runtimeScope = scope as Record<string, unknown>
  return Object.keys(record).length === 5
    && ['generation', 'runtimeScope', 'activeWorkspaceId', 'pendingPath', 'workspaces'].every((key) => Object.hasOwn(record, key))
    && Number.isSafeInteger(record.generation) && (record.generation as number) >= 0
    && Object.keys(runtimeScope).length === 2
    && typeof runtimeScope.ownerId === 'string' && runtimeScope.ownerId.length > 0 && runtimeScope.ownerId.length <= 128
    && Number.isSafeInteger(runtimeScope.generation) && (runtimeScope.generation as number) >= 0
    && runtimeScope.generation === record.generation
    && (record.activeWorkspaceId === null || (typeof record.activeWorkspaceId === 'string' && /^[a-f0-9-]{36}$/i.test(record.activeWorkspaceId)))
    && (record.pendingPath === null || (typeof record.pendingPath === 'string' && record.pendingPath.length <= 4096))
    && Array.isArray(record.workspaces) && record.workspaces.length <= 50
    && record.workspaces.every(isWorkspaceInfo)
}

export function isWorkspaceOperationResult(value: unknown): value is WorkspaceOperationResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 2
    && Object.hasOwn(record, 'outcome') && Object.hasOwn(record, 'snapshot')
    && (record.outcome === 'opened' || record.outcome === 'trust-updated' || record.outcome === 'cancelled'
      || record.outcome === 'closed' || record.outcome === 'missing')
    && isWorkspaceSnapshot(record.snapshot)
}

export function isWorkspaceEventPayload(value: unknown): value is WorkspaceEventPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 2
    && Object.hasOwn(record, 'reason') && Object.hasOwn(record, 'snapshot')
    && (record.reason === 'switching' || record.reason === 'opened' || record.reason === 'trust-changed'
      || record.reason === 'cancelled' || record.reason === 'missing' || record.reason === 'changed')
    && isWorkspaceSnapshot(record.snapshot)
}
