import { isAbsolute } from 'node:path'
import type { CapabilityDefinition } from './register.ts'
import type { AuthorizedIpcCaller } from './register.ts'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import {
  CONTENT_LIMITS,
  isAttachmentReadRequest,
  isAttachmentReadResponse,
  isExportWriteRequest,
  isExportWriteResponse,
  type AttachmentReadRequest,
  type AttachmentReadResponse,
  type ContentCapabilityContracts,
  type ExportWriteRequest,
  type ExportWriteResponse,
} from '../../shared/content.ts'
import type { PrivilegedFileService } from '../security/file-service.ts'

export type FileCapabilityDefinition = {
  [K in keyof ContentCapabilityContracts]: CapabilityDefinition<
    ContentCapabilityContracts[K]['request'],
    ContentCapabilityContracts[K]['response']
  >
}[keyof ContentCapabilityContracts]

export interface FileCapabilityOptions {
  readonly authorizeWorkspace: (
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    workspacePath: string,
  ) => boolean
}

function isReadAttachmentRequest(value: unknown): value is AttachmentReadRequest {
  return isAttachmentReadRequest(value)
    && isAbsolute(value.workspacePath)
    && value.workspacePath.length <= CONTENT_LIMITS.pathCharacters
}

function authorizedWorkspace(
  options: FileCapabilityOptions,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
  workspacePath: string,
): boolean {
  if (!scope) return false
  try {
    return options.authorizeWorkspace(caller, scope, workspacePath) === true
  } catch {
    return false
  }
}

/** Returns capability descriptors for composition into the application's existing IPC registry. */
export function registerFileCapabilities(
  service: PrivilegedFileService,
  options: FileCapabilityOptions,
): readonly FileCapabilityDefinition[] {
  const readAttachment: CapabilityDefinition<AttachmentReadRequest, AttachmentReadResponse> = {
    // The central IPC registry permits only lower-case IDs; these identify the requested
    // files.readAttachment operation while remaining valid under isCapabilityId().
    id: 'files.read-attachment',
    scope: 'runtime',
    validateRequest: isReadAttachmentRequest,
    validateResponse: isAttachmentReadResponse,
    handle: (context, request) => {
      if (!authorizedWorkspace(options, context.caller, context.scope, request.workspacePath)) {
        throw new Error('Workspace is not available.')
      }
      return service.readAttachment(request.workspacePath, request.relativeOrAbsPath)
    },
  }

  const writeExport: CapabilityDefinition<ExportWriteRequest, ExportWriteResponse> = {
    id: 'files.write-export',
    scope: 'runtime',
    validateRequest: isExportWriteRequest,
    validateResponse: isExportWriteResponse,
    handle: (context, request) => {
      if (!context.scope) throw new Error('Runtime scope is not available.')
      return service.writeExport(context.caller, request.suggestedName, request.bytesBase64)
    },
  }

  return [readAttachment, writeExport]
}
