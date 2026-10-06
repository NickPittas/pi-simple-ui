import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { AgentDefinitionProvider } from '../../shared/agent-definitions.ts'
import {
  AGENT_DEFINITIONS_IPC,
  NICOBAILON_AGENT_DEFINITIONS_PROVIDER,
  TINTINWEB_AGENT_DEFINITIONS_PROVIDER,
  isAgentDefinitionCreateRequest,
  isAgentDefinitionDeleteRequest,
  isAgentDefinitionEnableRequest,
  isAgentDefinitionListRequest,
  isAgentDefinitionListResponse,
  isAgentDefinitionMutationResponse,
  isAgentDefinitionReadRequest,
  isAgentDefinitionReadResponse,
  isAgentDefinitionUpdateRequest,
  type AgentDefinitionCreateRequest,
  type AgentDefinitionDeleteRequest,
  type AgentDefinitionEnableRequest,
  type AgentDefinitionListRequest,
  type AgentDefinitionListResponse,
  type AgentDefinitionMutationResponse,
  type AgentDefinitionReadRequest,
  type AgentDefinitionReadResponse,
  type AgentDefinitionUpdateRequest,
  type AgentDefinitionCapabilityContracts,
} from '../../shared/agent-definitions.ts'
import type { AuthorizedIpcCaller, CapabilityDefinition } from './register.ts'
import type { TintinwebDefinitions } from '../agents/tintinweb-definitions.ts'
import type { NicobailonDefinitions } from '../agents/nicobailon-definitions.ts'

import {
  HerdrAgentDefinitionProvider,
  type HerdrDefinitionStore,
} from '../herdr/definitions.ts'

/** Provider discriminator for the native pi-herdr-agents adapter. */
export const HERDR_AGENT_DEFINITION_PROVIDER: AgentDefinitionProvider = 'herdr'

export type AgentDefinitionsCapabilityDefinition = {
  [K in keyof AgentDefinitionCapabilityContracts]: CapabilityDefinition<
    AgentDefinitionCapabilityContracts[K]['request'],
    AgentDefinitionCapabilityContracts[K]['response']
  >
}[keyof AgentDefinitionCapabilityContracts]

export interface AgentDefinitionProviderService {
  list(request: AgentDefinitionListRequest): AgentDefinitionListResponse
  read(id: string): AgentDefinitionReadResponse
  create(request: AgentDefinitionCreateRequest): AgentDefinitionMutationResponse
  update(request: AgentDefinitionUpdateRequest): AgentDefinitionMutationResponse
  delete(id: string, expectedRevision: number): AgentDefinitionMutationResponse
  setEnabled(request: AgentDefinitionEnableRequest): AgentDefinitionMutationResponse
}

export interface AgentDefinitionCapabilityRouter {
  isCallerAuthorized(caller: AuthorizedIpcCaller): boolean
  /** Resolve binds both caller and runtime generation to a provider-specific service. */
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope, provider: AgentDefinitionProvider): AgentDefinitionProviderService | null
}

function providerOf(request: { readonly provider?: AgentDefinitionProvider }): AgentDefinitionProvider {
  return request.provider ?? TINTINWEB_AGENT_DEFINITIONS_PROVIDER
}

/** Compose Tintinweb's native store into the existing multi-provider runtime router. */
export function withTintinwebAgentDefinitions(
  router: AgentDefinitionCapabilityRouter,
  resolveTintinweb: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => TintinwebDefinitions | null,
): AgentDefinitionCapabilityRouter {
  return {
    isCallerAuthorized: (caller) => router.isCallerAuthorized(caller),
    resolve: (caller, scope, provider) => provider === TINTINWEB_AGENT_DEFINITIONS_PROVIDER
      ? resolveTintinweb(caller, scope)
      : router.resolve(caller, scope, provider),
  }
}

/** Route the shared definition IPC surface to nicobailon's native markdown adapter. */
export function withNicobailonAgentDefinitions(
  router: AgentDefinitionCapabilityRouter,
  resolveNicobailon: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => NicobailonDefinitions | null,
): AgentDefinitionCapabilityRouter {
  return {
    isCallerAuthorized: (caller) => router.isCallerAuthorized(caller),
    resolve: (caller, scope, provider) => provider === NICOBAILON_AGENT_DEFINITIONS_PROVIDER
      ? resolveNicobailon(caller, scope)
      : router.resolve(caller, scope, provider),
  }
}

/** Route the shared definition IPC surface to Herdr's native markdown adapter. */
export function withHerdrAgentDefinitions(
  router: AgentDefinitionCapabilityRouter,
  resolver: HerdrDefinitionRuntimeResolver,
): AgentDefinitionCapabilityRouter {
  return {
    isCallerAuthorized: (caller) => router.isCallerAuthorized(caller) && resolver.isCallerAuthorized(caller),
    resolve: (caller, scope, provider) => {
      if (provider !== HERDR_AGENT_DEFINITION_PROVIDER) return router.resolve(caller, scope, provider)
      const store = resolver.resolve(caller, scope)
      return store ? new HerdrAgentDefinitionProvider(store) : null
    },
  }
}

function unavailableMutation(): AgentDefinitionMutationResponse {
  return { status: 'unavailable', definition: null, currentRevision: null, validationIssues: [] }
}

function requireRuntimeService(
  router: AgentDefinitionCapabilityRouter,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
  provider: AgentDefinitionProvider,
): AgentDefinitionProviderService {
  if (!scope) throw new Error('An authorized runtime scope is required for agent definitions.')
  const service = router.resolve(caller, scope, provider)
  if (!service) throw new Error('Agent definitions are unavailable for this runtime scope.')
  return service
}

/** Register the shared definition IPC surface, dispatching each request to its native provider adapter. */
export function registerAgentDefinitionCapabilities(
  router: AgentDefinitionCapabilityRouter,
): readonly AgentDefinitionsCapabilityDefinition[] {
  const list: CapabilityDefinition<AgentDefinitionListRequest, AgentDefinitionListResponse> = {
    id: AGENT_DEFINITIONS_IPC.list,
    scope: 'runtime',
    validateRequest: isAgentDefinitionListRequest,
    validateResponse: isAgentDefinitionListResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireRuntimeService(router, caller, scope, providerOf(request)).list(request),
  }
  const read: CapabilityDefinition<AgentDefinitionReadRequest, AgentDefinitionReadResponse> = {
    id: AGENT_DEFINITIONS_IPC.read,
    scope: 'runtime',
    validateRequest: isAgentDefinitionReadRequest,
    validateResponse: isAgentDefinitionReadResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => requireRuntimeService(router, caller, scope, providerOf(request)).read(request.id),
  }
  const create: CapabilityDefinition<AgentDefinitionCreateRequest, AgentDefinitionMutationResponse> = {
    id: AGENT_DEFINITIONS_IPC.create,
    scope: 'runtime',
    validateRequest: isAgentDefinitionCreateRequest,
    validateResponse: isAgentDefinitionMutationResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => {
      try { return requireRuntimeService(router, caller, scope, providerOf(request)).create(request) }
      catch { return unavailableMutation() }
    },
  }
  const update: CapabilityDefinition<AgentDefinitionUpdateRequest, AgentDefinitionMutationResponse> = {
    id: AGENT_DEFINITIONS_IPC.update,
    scope: 'runtime',
    validateRequest: isAgentDefinitionUpdateRequest,
    validateResponse: isAgentDefinitionMutationResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => {
      try { return requireRuntimeService(router, caller, scope, providerOf(request)).update(request) }
      catch { return unavailableMutation() }
    },
  }
  const remove: CapabilityDefinition<AgentDefinitionDeleteRequest, AgentDefinitionMutationResponse> = {
    id: AGENT_DEFINITIONS_IPC.delete,
    scope: 'runtime',
    validateRequest: isAgentDefinitionDeleteRequest,
    validateResponse: isAgentDefinitionMutationResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => {
      try { return requireRuntimeService(router, caller, scope, providerOf(request)).delete(request.id, request.expectedRevision) }
      catch { return unavailableMutation() }
    },
  }
  const enable: CapabilityDefinition<AgentDefinitionEnableRequest, AgentDefinitionMutationResponse> = {
    id: AGENT_DEFINITIONS_IPC.enable,
    scope: 'runtime',
    validateRequest: isAgentDefinitionEnableRequest,
    validateResponse: isAgentDefinitionMutationResponse,
    authorize: (caller) => router.isCallerAuthorized(caller),
    handle: ({ caller, scope }, request) => {
      try { return requireRuntimeService(router, caller, scope, providerOf(request)).setEnabled(request) }
      catch { return unavailableMutation() }
    },
  }
  return [list, read, create, update, remove, enable]
}

export interface HerdrDefinitionRuntimeResolver {
  isCallerAuthorized(caller: AuthorizedIpcCaller): boolean
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): HerdrDefinitionStore | null
}
