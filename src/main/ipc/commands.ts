import type { CapabilityDefinition } from './register.ts'
import { hasExactKeys, isPlainRecord } from '../../shared/ipc-contracts.ts'
import {
  isCommandAutocompleteResponse,
  isCommandCatalogResponse,
  isCommandDispatchRequest,
  isCommandDispatchResponse,
  type CommandAutocompleteRequest,
  type CommandAutocompleteResponse,
  type CommandCapabilityContracts,
  type CommandCatalogRequest,
  type CommandCatalogResponse,
  type CommandDispatchRequest,
  type CommandDispatchResponse,
} from '../../shared/commands.ts'
import type { CommandDispatcher } from '../commands/dispatch.ts'

export type CommandCapabilityDefinition = {
  [K in keyof CommandCapabilityContracts]: CapabilityDefinition<
    CommandCapabilityContracts[K]['request'],
    CommandCapabilityContracts[K]['response']
  >
}[keyof CommandCapabilityContracts]

function isCatalogRequest(value: unknown): value is CommandCatalogRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

function isAutocompleteRequest(value: unknown): value is CommandAutocompleteRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['partial'])
    && typeof value.partial === 'string'
    && value.partial.length <= 128
    && !value.partial.includes('\0')
    && /^\/?[A-Za-z0-9._:-]*$/.test(value.partial)
}

export function registerCommandCapabilities(dispatcher: CommandDispatcher): readonly CommandCapabilityDefinition[] {
  const catalog: CapabilityDefinition<CommandCatalogRequest, CommandCatalogResponse> = {
    id: 'commands.catalog',
    scope: 'runtime',
    validateRequest: isCatalogRequest,
    validateResponse: isCommandCatalogResponse,
    handle: () => dispatcher.catalog.getSnapshot(),
  }

  const autocomplete: CapabilityDefinition<CommandAutocompleteRequest, CommandAutocompleteResponse> = {
    id: 'commands.autocomplete',
    scope: 'runtime',
    validateRequest: isAutocompleteRequest,
    validateResponse: isCommandAutocompleteResponse,
    handle: (_context, request) => {
      const partial = request.partial.startsWith('/') ? request.partial.slice(1) : request.partial
      const prefix = partial.toLowerCase()
      return {
        commands: dispatcher.catalog.getSnapshot().commands.filter((command) =>
          command.name.toLowerCase().startsWith(prefix)
          || command.aliases.some((alias) => alias.toLowerCase().startsWith(prefix)),
        ),
      }
    },
  }

  const dispatch: CapabilityDefinition<CommandDispatchRequest, CommandDispatchResponse> = {
    id: 'commands.dispatch',
    scope: 'runtime',
    validateRequest: isCommandDispatchRequest,
    validateResponse: isCommandDispatchResponse,
    handle: (context, request) => 'input' in request
      ? dispatcher.dispatch(request.input, context.scope)
      : dispatcher.dispatchMenuSelection(
          request.menuSelection.menuId,
          request.menuSelection.selection,
          context.scope,
        ),
  }

  return [catalog, dispatch, autocomplete]
}
