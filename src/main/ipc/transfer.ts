import type { CapabilityDefinition, EventDefinition } from './register.ts'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import {
  TRANSFER_IPC,
  isTransferShareEventPayload,
  transferValidators,
  type TransferCapabilityContracts,
  type TransferEmptyRequest,
  type TransferExportConfirmRequest,
  type TransferExportConfirmResponse,
  type TransferExportRequest,
  type TransferExportResponse,
  type TransferImportResponse,
  type TransferShareConfirmRequest,
  type TransferShareConfirmResponse,
  type TransferShareCancelRequest,
  type TransferShareCancelResponse,
  type TransferShareEventPayload,
  type TransferSharePrepareResponse,
} from '../../shared/transfer.ts'
import type { TransferService } from '../sessions/transfer-service.ts'

export type TransferCapabilityDefinition = {
  [K in keyof TransferCapabilityContracts]: CapabilityDefinition<
    TransferCapabilityContracts[K]['request'],
    TransferCapabilityContracts[K]['response']
  >
}[keyof TransferCapabilityContracts]

function requireScope(scope: RuntimeScope | undefined): RuntimeScope {
  if (!scope) throw new Error('A runtime scope is required for transfer operations.')
  return scope
}

/** Compose runtime-scoped, caller-bound export/import/share operations for IPC registration. */
export function registerTransferCapabilities(service: TransferService): readonly TransferCapabilityDefinition[] {
  const exportSession: CapabilityDefinition<TransferExportRequest, TransferExportResponse> = {
    id: TRANSFER_IPC.export,
    scope: 'runtime',
    validateRequest: transferValidators.exportRequest,
    validateResponse: transferValidators.exportResponse,
    handle: ({ caller, scope }, request) => service.prepareExport(caller, requireScope(scope), request),
  }

  const confirmExport: CapabilityDefinition<TransferExportConfirmRequest, TransferExportConfirmResponse> = {
    id: TRANSFER_IPC.exportConfirm,
    scope: 'runtime',
    validateRequest: transferValidators.exportConfirmRequest,
    validateResponse: transferValidators.exportConfirmResponse,
    handle: ({ caller, scope }, request) => service.confirmExport(caller, requireScope(scope), request),
  }

  const importSession: CapabilityDefinition<TransferEmptyRequest, TransferImportResponse> = {
    id: TRANSFER_IPC.import,
    scope: 'runtime',
    validateRequest: transferValidators.importRequest,
    validateResponse: transferValidators.importResponse,
    handle: ({ caller, scope }) => service.importSession(caller, requireScope(scope)),
  }

  const prepareShare: CapabilityDefinition<TransferEmptyRequest, TransferSharePrepareResponse> = {
    id: TRANSFER_IPC.sharePrepare,
    scope: 'runtime',
    validateRequest: transferValidators.sharePrepareRequest,
    validateResponse: transferValidators.sharePrepareResponse,
    handle: ({ caller, scope }) => service.prepareShare(caller, requireScope(scope)),
  }

  const confirmShare: CapabilityDefinition<TransferShareConfirmRequest, TransferShareConfirmResponse> = {
    id: TRANSFER_IPC.shareConfirm,
    scope: 'runtime',
    validateRequest: transferValidators.shareConfirmRequest,
    validateResponse: transferValidators.shareConfirmResponse,
    handle: ({ caller, scope }, request) => service.confirmShare(caller, requireScope(scope), request),
  }

  const cancelShare: CapabilityDefinition<TransferShareCancelRequest, TransferShareCancelResponse> = {
    id: TRANSFER_IPC.shareCancel,
    scope: 'runtime',
    validateRequest: transferValidators.shareCancelRequest,
    validateResponse: transferValidators.shareCancelResponse,
    handle: ({ caller, scope }, request) => service.cancelShare(caller, requireScope(scope), request),
  }

  return [exportSession, confirmExport, importSession, prepareShare, confirmShare, cancelShare]
}

export function registerTransferEvents(service: TransferService): readonly EventDefinition<TransferShareEventPayload>[] {
  return [{
    id: TRANSFER_IPC.shareEvents,
    scope: 'runtime',
    validatePayload: isTransferShareEventPayload,
    subscribe: (context, publish) => {
      const scope = requireScope(context.scope)
      return service.subscribeShareEvents(context.caller, scope, publish)
    },
  }]
}
