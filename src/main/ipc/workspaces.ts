import { isAbsolute } from 'node:path'
import type { CapabilityDefinition, EventDefinition } from './register.ts'
import { hasExactKeys, isPlainRecord } from '../../shared/ipc-contracts.ts'
import {
  isWorkspaceEventPayload,
  isWorkspaceFolderPickerResult,
  isWorkspaceOperationResult,
  isWorkspaceSnapshot,
  type EmptyWorkspaceRequest,
  type OpenRecentWorkspaceRequest,
  type OpenWorkspaceRequest,
  type WorkspaceCapabilityContracts,
  type WorkspaceEventPayload,
  type WorkspaceFolderPickerResult,
  type WorkspaceOperationResult,
  type WorkspaceSnapshot,
  type WorkspaceTrustRequest,
} from '../../shared/workspaces.ts'
import type { WorkspaceService } from '../workspaces/workspace-service.ts'
import type { WorkspaceFolderPicker } from '../workspaces/folder-picker.ts'

export interface WorkspaceOperations {
  list(): Promise<WorkspaceSnapshot>
  open(path: string): Promise<WorkspaceOperationResult>
  openRecent(workspaceId: string): Promise<WorkspaceOperationResult>
  grantTrust?(workspaceId: string): Promise<WorkspaceOperationResult>
  revokeTrust?(workspaceId: string): Promise<WorkspaceOperationResult>
  cancel(): Promise<WorkspaceOperationResult>
}

export type WorkspaceCapabilityDefinition = {
  [K in keyof WorkspaceCapabilityContracts]: CapabilityDefinition<
    WorkspaceCapabilityContracts[K]['request'],
    WorkspaceCapabilityContracts[K]['response']
  >
}[keyof WorkspaceCapabilityContracts]

function isEmptyRequest(value: unknown): value is EmptyWorkspaceRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

function isOpenRequest(value: unknown): value is OpenWorkspaceRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['path'])
    && typeof value.path === 'string'
    && value.path.length > 0
    && value.path.length <= 4096
    && !value.path.includes('\0')
    && isAbsolute(value.path)
}

function isWorkspaceIdRequest(value: unknown): value is WorkspaceTrustRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['workspaceId'])
    && typeof value.workspaceId === 'string'
    && /^[a-f0-9-]{36}$/i.test(value.workspaceId)
}

function isOpenRecentRequest(value: unknown): value is OpenRecentWorkspaceRequest {
  return isWorkspaceIdRequest(value)
}

export function registerWorkspaceCapabilities(
  operations: WorkspaceOperations,
  folderPicker?: WorkspaceFolderPicker,
): readonly WorkspaceCapabilityDefinition[] {
  const list: CapabilityDefinition<EmptyWorkspaceRequest, WorkspaceSnapshot> = {
    id: 'workspaces.list',
    scope: 'window',
    validateRequest: isEmptyRequest,
    validateResponse: isWorkspaceSnapshot,
    handle: () => operations.list(),
  }
  const pickFolder: CapabilityDefinition<EmptyWorkspaceRequest, WorkspaceFolderPickerResult> = {
    id: 'workspaces.pick-folder',
    scope: 'window',
    validateRequest: isEmptyRequest,
    validateResponse: isWorkspaceFolderPickerResult,
    handle: (context) => folderPicker?.(context.caller) ?? { path: null },
  }
  const open: CapabilityDefinition<OpenWorkspaceRequest, WorkspaceOperationResult> = {
    id: 'workspaces.open',
    scope: 'window',
    validateRequest: isOpenRequest,
    validateResponse: isWorkspaceOperationResult,
    handle: (_context, request) => operations.open(request.path),
  }
  const openRecent: CapabilityDefinition<OpenRecentWorkspaceRequest, WorkspaceOperationResult> = {
    id: 'workspaces.open-recent',
    scope: 'window',
    validateRequest: isOpenRecentRequest,
    validateResponse: isWorkspaceOperationResult,
    handle: (_context, request) => operations.openRecent(request.workspaceId),
  }
  const trust: CapabilityDefinition<WorkspaceTrustRequest, WorkspaceOperationResult>[] = []
  // Native registrations must not write application trust or guess a `/trust` route.
  if (operations.grantTrust) trust.push({
    id: 'workspaces.trust.grant',
    scope: 'window',
    validateRequest: isWorkspaceIdRequest,
    validateResponse: isWorkspaceOperationResult,
    handle: (_context, request) => operations.grantTrust!(request.workspaceId),
  })
  if (operations.revokeTrust) trust.push({
    id: 'workspaces.trust.revoke',
    scope: 'window',
    validateRequest: isWorkspaceIdRequest,
    validateResponse: isWorkspaceOperationResult,
    handle: (_context, request) => operations.revokeTrust!(request.workspaceId),
  })
  const cancel: CapabilityDefinition<EmptyWorkspaceRequest, WorkspaceOperationResult> = {
    id: 'workspaces.cancel',
    scope: 'window',
    validateRequest: isEmptyRequest,
    validateResponse: isWorkspaceOperationResult,
    handle: () => operations.cancel(),
  }
  return [list, pickFolder, open, openRecent, ...trust, cancel]
}

export function registerWorkspaceEvents(service: WorkspaceService): readonly EventDefinition<WorkspaceEventPayload>[] {
  const changed: EventDefinition<WorkspaceEventPayload> = {
    id: 'workspaces.changed',
    scope: 'window',
    validatePayload: isWorkspaceEventPayload,
    subscribe: (_context, publish) => service.subscribe(publish),
  }
  return [changed]
}
