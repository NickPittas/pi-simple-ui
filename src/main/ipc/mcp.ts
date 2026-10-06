import type { AuthorizedIpcCaller, CapabilityContext, CapabilityDefinition, EventDefinition } from './register.ts'
import { hasExactKeys, isPlainRecord, type RuntimeScope } from '../../shared/ipc-contracts.ts'
import {
  isMcpAuthBeginResponse,
  isMcpAuthLogoutResponse,
  isMcpEventPayload,
  isMcpPromptGetResponse,
  isMcpPromptListResponse,
  isMcpResourceListResponse,
  isMcpResourceReadResponse,
  isMcpServerConnectionResponse,
  isMcpServerListResponse,
  isMcpServerMutationResponse,
  isMcpServerReadResponse,
  isMcpSecretWriteResponse,
  MCP_IPC,
  type McpAuthBeginRequest,
  type McpAuthBeginResponse,
  type McpAuthLogoutRequest,
  type McpAuthLogoutResponse,
  type McpCapabilities,
  type McpConfigScope,
  type McpEventPayload,
  type McpPromptGetRequest,
  type McpPromptGetResponse,
  type McpPromptListRequest,
  type McpPromptListResponse,
  type McpResourceListRequest,
  type McpResourceListResponse,
  type McpResourceReadRequest,
  type McpResourceReadResponse,
  type McpSecretMutationRequest,
  type McpSecretWriteResponse,
  type McpServerConfigInput,
  type McpServerConnectionResponse,
  type McpServerCreateRequest,
  type McpServerDeleteRequest,
  type McpServerEnableRequest,
  type McpServerListRequest,
  type McpServerListResponse,
  type McpServerMutationResponse,
  type McpServerNameRequest,
  type McpServerReadRequest,
  type McpServerReadResponse,
  type McpServerUpdateRequest,
} from '../../shared/mcp.ts'
import type { McpConfigService } from '../mcp/config-service.ts'
import type { McpConnectionService } from '../mcp/connection-service.ts'
import type { McpSecretsStore } from '../security/secrets.ts'

export type McpCapabilityDefinition = {
  [K in keyof McpCapabilities]: CapabilityDefinition<McpCapabilities[K]['request'], McpCapabilities[K]['response']>
}[keyof McpCapabilities]

export interface McpIpcRuntimeBinding {
  readonly config: McpConfigService
  readonly connections: McpConnectionService
  readonly secrets: McpSecretsStore
  /** Main-owned canonical workspace cwd, never a renderer-supplied path. */
  readonly cwd: string
  /** Consulted for each operation so revocation immediately blocks project-scoped config. */
  readonly isProjectTrusted: () => boolean
}

export type McpRuntimeResolver = (
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope,
) => McpIpcRuntimeBinding | undefined

const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

function isName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !UNSAFE_NAMES.has(value)
}

function isEmptyRequest(value: unknown): value is McpServerListRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

function isNameRequest(value: unknown): value is McpServerNameRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['name']) && isName(value.name)
}

function isConfigScope(value: unknown): value is McpConfigScope {
  return value === 'user' || value === 'project'
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isExposure(value: unknown): boolean {
  return value === 'codemode' || value === 'deferred' || value === 'direct' || value === 'hidden'
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isStringRecord(value: unknown, keyPattern: RegExp, maxEntries = 512): value is Record<string, string> {
  return isPlainRecord(value)
    && Object.keys(value).length <= maxEntries
    && Object.entries(value).every(([key, entry]) => !UNSAFE_NAMES.has(key) && keyPattern.test(key)
      && typeof entry === 'string' && entry.length <= 8192 && !entry.includes('\0'))
}

function isToolExposure(value: unknown): boolean {
  return isPlainRecord(value)
    && Object.keys(value).length <= 512
    && Object.entries(value).every(([key, exposure]) => !UNSAFE_NAMES.has(key) && key.length <= 256 && isExposure(exposure))
}

function isOAuthInput(value: unknown): boolean {
  if (!isPlainRecord(value)) return false
  const allowed = [
    'clientId', 'clientSecret', 'callbackPort', 'callbackUrl', 'scope', 'clientName', 'clientRegistration', 'authServerMetadataUrl',
  ]
  if (!hasOnlyKeys(value, allowed)) return false
  for (const key of ['clientId', 'clientSecret', 'callbackUrl', 'scope', 'clientName', 'authServerMetadataUrl']) {
    if (Object.hasOwn(value, key) && (typeof value[key] !== 'string' || (value[key] as string).length > 8192)) return false
  }
  return (!Object.hasOwn(value, 'callbackPort') || Number.isInteger(value.callbackPort) && (value.callbackPort as number) >= 1 && (value.callbackPort as number) <= 65535)
    && (!Object.hasOwn(value, 'clientRegistration') || value.clientRegistration === 'dcr' || value.clientRegistration === 'cimd')
}

function isServerConfig(value: unknown): value is McpServerConfigInput {
  if (!isPlainRecord(value) || !Object.hasOwn(value, 'type') || typeof value.type !== 'string') return false
  if (value.type === 'override') {
    const allowed = ['type', 'enabled', 'exposure', 'toolExposure']
    return hasOnlyKeys(value, allowed)
      && (Object.keys(value).length > 1)
      && (!Object.hasOwn(value, 'enabled') || typeof value.enabled === 'boolean')
      && (!Object.hasOwn(value, 'exposure') || isExposure(value.exposure))
      && (!Object.hasOwn(value, 'toolExposure') || isToolExposure(value.toolExposure))
  }
  if (value.type === 'stdio') {
    const allowed = ['type', 'command', 'args', 'env', 'cwd', 'enabled', 'exposure', 'description', 'timeout', 'toolExposure']
    return hasOnlyKeys(value, allowed)
      && Object.hasOwn(value, 'command')
      && typeof value.command === 'string' && value.command.length > 0 && value.command.length <= 8192
      && (!Object.hasOwn(value, 'args') || Array.isArray(value.args) && value.args.length <= 512
        && value.args.every((arg) => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\0')))
      && (!Object.hasOwn(value, 'env') || isStringRecord(value.env, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/))
      && (!Object.hasOwn(value, 'cwd') || typeof value.cwd === 'string' && value.cwd.length <= 4096 && !value.cwd.includes('\0'))
      && (!Object.hasOwn(value, 'enabled') || typeof value.enabled === 'boolean')
      && (!Object.hasOwn(value, 'exposure') || isExposure(value.exposure))
      && (!Object.hasOwn(value, 'description') || typeof value.description === 'string' && value.description.length <= 8192)
      && (!Object.hasOwn(value, 'timeout') || typeof value.timeout === 'number' && Number.isFinite(value.timeout))
      && (!Object.hasOwn(value, 'toolExposure') || isToolExposure(value.toolExposure))
  }
  if (value.type === 'http') {
    const allowed = ['type', 'url', 'headers', 'oauth', 'authProvider', 'enabled', 'exposure', 'description', 'timeout', 'toolExposure']
    return hasOnlyKeys(value, allowed)
      && Object.hasOwn(value, 'url')
      && typeof value.url === 'string' && value.url.length <= 4096
      && (!Object.hasOwn(value, 'headers') || isStringRecord(value.headers, /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/))
      && (!Object.hasOwn(value, 'oauth') || isOAuthInput(value.oauth))
      && (!Object.hasOwn(value, 'authProvider') || typeof value.authProvider === 'string' && value.authProvider.length <= 128)
      && (!Object.hasOwn(value, 'enabled') || typeof value.enabled === 'boolean')
      && (!Object.hasOwn(value, 'exposure') || isExposure(value.exposure))
      && (!Object.hasOwn(value, 'description') || typeof value.description === 'string' && value.description.length <= 8192)
      && (!Object.hasOwn(value, 'timeout') || typeof value.timeout === 'number' && Number.isFinite(value.timeout))
      && (!Object.hasOwn(value, 'toolExposure') || isToolExposure(value.toolExposure))
  }
  return false
}

function isCreateRequest(value: unknown): value is McpServerCreateRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['scope', 'expectedRevision', 'name', 'config'])
    && isConfigScope(value.scope)
    && isRevision(value.expectedRevision)
    && isName(value.name)
    && isServerConfig(value.config)
}

function isUpdateRequest(value: unknown): value is McpServerUpdateRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['scope', 'expectedRevision', 'name', 'config'])
    && isConfigScope(value.scope)
    && isRevision(value.expectedRevision)
    && isName(value.name)
    && isServerConfig(value.config)
}

function isDeleteRequest(value: unknown): value is McpServerDeleteRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['scope', 'expectedRevision', 'name'])
    && isConfigScope(value.scope)
    && isRevision(value.expectedRevision)
    && isName(value.name)
}

function isEnableRequest(value: unknown): value is McpServerEnableRequest {
  return isDeleteRequest(value)
}

function isPromptListRequest(value: unknown): value is McpPromptListRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['server']) && isName(value.server)
}

function isPromptGetRequest(value: unknown): value is McpPromptGetRequest {
  if (!isPlainRecord(value)) return false
  const keys = Object.hasOwn(value, 'arguments') ? ['server', 'prompt', 'arguments'] : ['server', 'prompt']
  return hasExactKeys(value, keys)
    && isName(value.server)
    && typeof value.prompt === 'string' && value.prompt.length > 0 && value.prompt.length <= 256
    && (!Object.hasOwn(value, 'arguments') || isStringRecord(value.arguments, /^.{1,256}$/))
}

function isResourceListRequest(value: unknown): value is McpResourceListRequest {
  return isPromptListRequest(value)
}

function isResourceReadRequest(value: unknown): value is McpResourceReadRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['server', 'uri'])
    && isName(value.server)
    && typeof value.uri === 'string' && value.uri.length > 0 && value.uri.length <= 4096
}

function isSecretWriteRequest(value: unknown): value is McpSecretMutationRequest {
  if (!isPlainRecord(value)) return false
  const expected = value.operation === 'set' ? ['operation', 'server', 'key', 'value'] : ['operation', 'server', 'key']
  return hasExactKeys(value, expected)
    && (value.operation === 'set' || value.operation === 'delete')
    && isName(value.server)
    && typeof value.key === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(value.key) && !UNSAFE_NAMES.has(value.key)
    && (value.operation !== 'set' || typeof value.value === 'string' && value.value.length > 0 && value.value.length <= 65_536)
}

function isAuthBeginRequest(value: unknown): value is McpAuthBeginRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['server'])
    && isName(value.server)
}

function isAuthLogoutRequest(value: unknown): value is McpAuthLogoutRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['server'])
    && isName(value.server)
}

function requireRuntimeScope(scope: RuntimeScope | undefined): RuntimeScope {
  if (!scope) throw new TypeError('An authorized runtime scope is required for MCP operations.')
  return scope
}

export function registerMcpCapabilities(resolveRuntime: McpRuntimeResolver): readonly McpCapabilityDefinition[] {
  const binding = (context: CapabilityContext): McpIpcRuntimeBinding => {
    const runtime = resolveRuntime(context.caller, requireRuntimeScope(context.scope))
    if (!runtime) throw new TypeError('The MCP runtime is unavailable for this caller.')
    return runtime
  }
  const trusted = (runtime: McpIpcRuntimeBinding): boolean => runtime.isProjectTrusted()

  const list: CapabilityDefinition<McpServerListRequest, McpServerListResponse> = {
    id: MCP_IPC.serversList,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isMcpServerListResponse,
    handle: (context) => {
      const runtime = binding(context)
      const result = runtime.config.list(runtime.cwd, trusted(runtime))
      const states = runtime.connections.listRuntimeStates()
      return {
        ...result,
        servers: result.servers.map((server) => {
          const state = states.get(server.name)
          return { ...server, ...(state ? { runtime: state } : {}) }
        }),
      }
    },
  }
  const read: CapabilityDefinition<McpServerReadRequest, McpServerReadResponse> = {
    id: MCP_IPC.serversRead,
    scope: 'runtime',
    validateRequest: (value): value is McpServerReadRequest => isNameRequest(value),
    validateResponse: isMcpServerReadResponse,
    handle: (context, request) => {
      const runtime = binding(context)
      const result = runtime.config.read(request.name, runtime.cwd, trusted(runtime))
      const state = runtime.connections.getRuntimeState(request.name)
      return {
        ...result,
        server: result.server ? { ...result.server, ...(state ? { runtime: state } : {}) } : null,
      }
    },
  }
  const create: CapabilityDefinition<McpServerCreateRequest, McpServerMutationResponse> = {
    id: MCP_IPC.serversCreate,
    scope: 'runtime',
    validateRequest: isCreateRequest,
    validateResponse: isMcpServerMutationResponse,
    handle: (context, request) => {
      const runtime = binding(context)
      return runtime.config.create(request.scope, request.expectedRevision, request.name, request.config, runtime.cwd, trusted(runtime))
    },
  }
  const update: CapabilityDefinition<McpServerUpdateRequest, McpServerMutationResponse> = {
    id: MCP_IPC.serversUpdate,
    scope: 'runtime',
    validateRequest: isUpdateRequest,
    validateResponse: isMcpServerMutationResponse,
    handle: (context, request) => {
      const runtime = binding(context)
      return runtime.config.update(
        request.scope,
        request.expectedRevision,
        request.name,
        request.config,
        runtime.cwd,
        trusted(runtime),
      )
    },
  }
  const remove: CapabilityDefinition<McpServerDeleteRequest, McpServerMutationResponse> = {
    id: MCP_IPC.serversDelete,
    scope: 'runtime',
    validateRequest: isDeleteRequest,
    validateResponse: isMcpServerMutationResponse,
    handle: (context, request) => {
      const runtime = binding(context)
      return runtime.config.delete(request.scope, request.expectedRevision, request.name, runtime.cwd, trusted(runtime))
    },
  }
  const setEnabled = (
    id: typeof MCP_IPC.serversEnable | typeof MCP_IPC.serversDisable,
    enabled: boolean,
  ): CapabilityDefinition<McpServerEnableRequest, McpServerMutationResponse> => ({
    id,
    scope: 'runtime',
    validateRequest: isEnableRequest,
    validateResponse: isMcpServerMutationResponse,
    handle: (context, request) => {
      const runtime = binding(context)
      return runtime.config.setEnabled(request.scope, request.expectedRevision, request.name, enabled, runtime.cwd, trusted(runtime))
    },
  })
  const connect: CapabilityDefinition<McpServerNameRequest, McpServerConnectionResponse> = {
    id: MCP_IPC.serversConnect,
    scope: 'runtime',
    validateRequest: isNameRequest,
    validateResponse: isMcpServerConnectionResponse,
    handle: (context, request) => binding(context).connections.connect(request.name),
  }
  const disconnect: CapabilityDefinition<McpServerNameRequest, McpServerConnectionResponse> = {
    id: MCP_IPC.serversDisconnect,
    scope: 'runtime',
    validateRequest: isNameRequest,
    validateResponse: isMcpServerConnectionResponse,
    handle: (context, request) => binding(context).connections.disconnect(request.name),
  }
  const reconnect: CapabilityDefinition<McpServerNameRequest, McpServerConnectionResponse> = {
    id: MCP_IPC.serversReconnect,
    scope: 'runtime',
    validateRequest: isNameRequest,
    validateResponse: isMcpServerConnectionResponse,
    handle: (context, request) => binding(context).connections.reconnect(request.name),
  }
  const promptsList: CapabilityDefinition<McpPromptListRequest, McpPromptListResponse> = {
    id: MCP_IPC.promptsList,
    scope: 'runtime',
    validateRequest: isPromptListRequest,
    validateResponse: isMcpPromptListResponse,
    handle: (context, request) => binding(context).connections.listPrompts(request.server),
  }
  const promptsGet: CapabilityDefinition<McpPromptGetRequest, McpPromptGetResponse> = {
    id: MCP_IPC.promptsGet,
    scope: 'runtime',
    validateRequest: isPromptGetRequest,
    validateResponse: isMcpPromptGetResponse,
    handle: (context, request) => binding(context).connections.getPrompt(request.server, request.prompt, request.arguments ? { ...request.arguments } : undefined),
  }
  const resourcesList: CapabilityDefinition<McpResourceListRequest, McpResourceListResponse> = {
    id: MCP_IPC.resourcesList,
    scope: 'runtime',
    validateRequest: isResourceListRequest,
    validateResponse: isMcpResourceListResponse,
    handle: (context, request) => binding(context).connections.listResources(request.server),
  }
  const resourcesRead: CapabilityDefinition<McpResourceReadRequest, McpResourceReadResponse> = {
    id: MCP_IPC.resourcesRead,
    scope: 'runtime',
    validateRequest: isResourceReadRequest,
    validateResponse: isMcpResourceReadResponse,
    handle: (context, request) => binding(context).connections.readResource(request.server, request.uri),
  }
  const authBegin: CapabilityDefinition<McpAuthBeginRequest, McpAuthBeginResponse> = {
    id: MCP_IPC.authBegin,
    scope: 'runtime',
    validateRequest: isAuthBeginRequest,
    validateResponse: isMcpAuthBeginResponse,
    handle: (context, request) => {
      const server = request.server
      if (!isName(server)) throw new TypeError('MCP server name is invalid.')
      return binding(context).connections.beginAuth(server).then((outcome) => ({ outcome }))
    },
  }
  const authLogout: CapabilityDefinition<McpAuthLogoutRequest, McpAuthLogoutResponse> = {
    id: MCP_IPC.authLogout,
    scope: 'runtime',
    validateRequest: isAuthLogoutRequest,
    validateResponse: isMcpAuthLogoutResponse,
    handle: (context, request) => {
      const runtime = binding(context)
      const server = request.server
      if (!isName(server)) throw new TypeError('MCP server name is invalid.')
      return runtime.connections.logout(server, runtime.secrets)
    },
  }
  const writeSecret: CapabilityDefinition<McpSecretMutationRequest, McpSecretWriteResponse> = {
    id: MCP_IPC.secretsWrite,
    scope: 'runtime',
    validateRequest: isSecretWriteRequest,
    validateResponse: isMcpSecretWriteResponse,
    handle: (context, request) => {
      const runtime = binding(context)
      if (request.operation === 'set') {
        runtime.secrets.set(request.server, request.key, request.value)
        return { outcome: 'saved', server: request.server, key: request.key }
      }
      return {
        outcome: runtime.secrets.delete(request.server, request.key) ? 'deleted' : 'not-found',
        server: request.server,
        key: request.key,
      }
    },
  }

  return [
    list, read, create, update, remove,
    setEnabled(MCP_IPC.serversEnable, true),
    setEnabled(MCP_IPC.serversDisable, false),
    connect, disconnect, reconnect, promptsList, promptsGet, resourcesList, resourcesRead,
    authBegin, authLogout, writeSecret,
  ]
}

export function registerMcpEvents(resolveRuntime: McpRuntimeResolver): readonly EventDefinition<McpEventPayload>[] {
  const events: EventDefinition<McpEventPayload> = {
    id: MCP_IPC.events,
    scope: 'runtime',
    validatePayload: isMcpEventPayload,
    subscribe: (context, publish) => {
      const scope = requireRuntimeScope(context.scope)
      const runtime = resolveRuntime(context.caller, scope)
      if (!runtime) throw new TypeError('The MCP runtime is unavailable for this caller.')
      return runtime.connections.subscribe(publish)
    },
  }
  return [events]
}
