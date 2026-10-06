import type { CapabilityDefinition, EventDefinition } from './register.ts'
import {
  USAGE_IPC,
  isUsageEventPayload,
  isUsageModelsResponse,
  isUsageSessionRequest,
  isUsageSessionResponse,
  isUsageTurnResponse,
  isUsageWorkersResponse,
  type UsageCapabilityContracts,
  type UsageEventPayload,
  type UsageSessionRequest,
} from '../../shared/usage.ts'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { AuthorizedIpcCaller } from './register.ts'
import type { UsageService } from '../usage/usage-service.ts'

export type UsageCapabilityDefinition = {
  [K in keyof UsageCapabilityContracts]: CapabilityDefinition<
    UsageCapabilityContracts[K]['request'],
    UsageCapabilityContracts[K]['response']
  >
}[keyof UsageCapabilityContracts]

export type UsageEventDefinition = EventDefinition<UsageEventPayload>

export interface UsageIpcService {
  session(caller: AuthorizedIpcCaller, scope: RuntimeScope, sessionId: string): ReturnType<UsageService['session']>
  turn(caller: AuthorizedIpcCaller, scope: RuntimeScope, sessionId: string): ReturnType<UsageService['turn']>
  workers(caller: AuthorizedIpcCaller, scope: RuntimeScope, sessionId: string): ReturnType<UsageService['workers']>
  models(caller: AuthorizedIpcCaller, scope: RuntimeScope, sessionId: string): ReturnType<UsageService['models']>
  subscribe(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    publish: (payload: UsageEventPayload) => void,
  ): (() => void) | void
}

function requireScope(scope: RuntimeScope | undefined): RuntimeScope {
  if (!scope) throw new Error('A runtime scope is required for usage operations.')
  return scope
}

function registerCapability<Response>(
  id: string,
  validateResponse: (value: unknown) => value is Response,
  operation: (service: UsageIpcService, caller: AuthorizedIpcCaller, scope: RuntimeScope, sessionId: string) => Response,
  service: UsageIpcService,
): CapabilityDefinition<UsageSessionRequest, Response> {
  return {
    id,
    scope: 'runtime',
    validateRequest: isUsageSessionRequest,
    validateResponse,
    handle: ({ caller, scope }, request) => operation(service, caller, requireScope(scope), request.sessionId),
  }
}

export function registerUsageCapabilities(service: UsageIpcService): readonly UsageCapabilityDefinition[] {
  const session = registerCapability(
    USAGE_IPC.session,
    isUsageSessionResponse,
    (target, caller, scope, sessionId) => target.session(caller, scope, sessionId),
    service,
  )
  const turn = registerCapability(
    USAGE_IPC.turn,
    isUsageTurnResponse,
    (target, caller, scope, sessionId) => target.turn(caller, scope, sessionId),
    service,
  )
  const workers = registerCapability(
    USAGE_IPC.workers,
    isUsageWorkersResponse,
    (target, caller, scope, sessionId) => target.workers(caller, scope, sessionId),
    service,
  )
  const models = registerCapability(
    USAGE_IPC.models,
    isUsageModelsResponse,
    (target, caller, scope, sessionId) => target.models(caller, scope, sessionId),
    service,
  )
  return [session, turn, workers, models]
}

export function registerUsageEvents(service: UsageIpcService): readonly UsageEventDefinition[] {
  return [{
    id: USAGE_IPC.events,
    scope: 'runtime',
    validatePayload: isUsageEventPayload,
    subscribe: (context, publish) => service.subscribe(
      context.caller,
      requireScope(context.scope),
      publish,
    ),
  }]
}
