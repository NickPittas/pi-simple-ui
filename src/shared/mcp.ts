import { hasExactKeys, isPlainRecord, type RuntimeScope } from './ipc-contracts.ts'

export const MCP_IPC = Object.freeze({
  serversList: 'mcp.servers.list',
  serversRead: 'mcp.servers.read',
  serversCreate: 'mcp.servers.create',
  serversUpdate: 'mcp.servers.update',
  serversDelete: 'mcp.servers.delete',
  serversEnable: 'mcp.servers.enable',
  serversDisable: 'mcp.servers.disable',
  serversConnect: 'mcp.servers.connect',
  serversDisconnect: 'mcp.servers.disconnect',
  serversReconnect: 'mcp.servers.reconnect',
  promptsList: 'mcp.prompts.list',
  promptsGet: 'mcp.prompts.get',
  resourcesList: 'mcp.resources.list',
  resourcesRead: 'mcp.resources.read',
  toolsList: 'mcp.tools.list',
  resourceTemplatesList: 'mcp.resource-templates.list',
  serverInstructions: 'mcp.server.instructions',
  exposureRead: 'mcp.exposure.read',
  exposureUpdate: 'mcp.exposure.update',
  appsOpen: 'mcp.apps.open',
  authBegin: 'mcp.auth.begin',
  authLogout: 'mcp.auth.logout',
  secretsWrite: 'mcp.secrets.write',
  events: 'mcp.events',
})

export type McpConfigScope = 'user' | 'project'
export type McpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden'
export type McpServerStatus = 'connecting' | 'connected' | 'auth-required' | 'failed' | 'disabled'

export interface McpOAuthInput {
  readonly clientId?: string
  /** Native config reference only, for example `${MCP_CLIENT_SECRET}` or `!secret-command`. */
  readonly clientSecret?: string
  readonly callbackPort?: number
  readonly callbackUrl?: string
  readonly scope?: string
  readonly clientName?: string
  readonly clientRegistration?: 'dcr' | 'cimd'
  readonly authServerMetadataUrl?: string
}

export interface McpStdioConfigInput {
  readonly type: 'stdio'
  readonly command: string
  readonly args?: readonly string[]
  /** Native Pi config values are literals, `${ENV}` references, or `!command` references. */
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly enabled?: boolean
  readonly exposure?: McpExposure
  readonly description?: string
  readonly timeout?: number
  readonly toolExposure?: Readonly<Record<string, McpExposure>>
}

export interface McpHttpConfigInput {
  readonly type: 'http'
  readonly url: string
  /** Native Pi config values are literals, `${ENV}` references, or `!command` references. */
  readonly headers?: Readonly<Record<string, string>>
  readonly oauth?: McpOAuthInput
  readonly authProvider?: string
  readonly enabled?: boolean
  readonly exposure?: McpExposure
  readonly description?: string
  readonly timeout?: number
  readonly toolExposure?: Readonly<Record<string, McpExposure>>
}

export interface McpProjectOverrideInput {
  readonly type: 'override'
  readonly enabled?: boolean
  readonly exposure?: McpExposure
  readonly toolExposure?: Readonly<Record<string, McpExposure>>
}

export type McpServerConfigInput = McpStdioConfigInput | McpHttpConfigInput | McpProjectOverrideInput

/** Configuration projection. Credential values, environment values and header values are never included. */
export interface McpServerConfigView {
  readonly name: string
  readonly scope: McpConfigScope
  readonly transport: 'stdio' | 'http'
  readonly enabled: boolean
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly envKeys?: readonly string[]
  /** User info, query and fragment are removed. */
  readonly url?: string
  readonly headerNames?: readonly string[]
  readonly authProvider?: string
  readonly oauth?: {
    readonly clientId?: string
    readonly clientSecretConfigured: boolean
    readonly callbackPort?: number
    readonly callbackUrl?: string
    readonly scope?: string
    readonly clientName?: string
    readonly clientRegistration?: 'dcr' | 'cimd'
    readonly authServerMetadataUrl?: string
  }
  readonly timeout?: number
  readonly exposure: McpExposure
  readonly description?: string
  readonly toolExposure?: Readonly<Record<string, McpExposure>>
  readonly overriddenByProject?: boolean
  readonly runtime?: McpServerRuntimeState
}

export interface McpServerRuntimeState {
  readonly state: McpServerStatus
  readonly authentication: 'none' | 'configured' | 'required'
  readonly error?: string
  readonly diagnostic?: string
  readonly instructions?: string
}

export interface McpServerListRequest {}
export interface McpServerListResponse {
  readonly servers: readonly (McpServerConfigView & { readonly runtime?: McpServerRuntimeState })[]
  readonly userRevision: number
  readonly projectRevision?: number
}

export interface McpServerReadRequest { readonly name: string }
export interface McpServerReadResponse {
  readonly server: (McpServerConfigView & { readonly runtime?: McpServerRuntimeState }) | null
  readonly userRevision: number
  readonly projectRevision?: number
}

export interface McpServerCreateRequest {
  readonly scope: McpConfigScope
  readonly expectedRevision: number
  readonly name: string
  readonly config: McpServerConfigInput
}

export interface McpServerUpdateRequest {
  readonly scope: McpConfigScope
  readonly expectedRevision: number
  readonly name: string
  readonly config: McpServerConfigInput
}

export interface McpServerDeleteRequest {
  readonly scope: McpConfigScope
  readonly expectedRevision: number
  readonly name: string
}

export interface McpServerEnableRequest {
  readonly scope: McpConfigScope
  readonly expectedRevision: number
  readonly name: string
}

export interface McpServerMutationResponse {
  readonly outcome: 'saved' | 'conflict' | 'session-reload-required'
  readonly revision: number
  readonly server: McpServerConfigView | null
}

export interface McpServerNameRequest { readonly name: string }
export interface McpServerConnectionResponse {
  readonly outcome: 'connected' | 'disconnected' | 'reconnected' | 'auth-required' | 'failed' | 'unavailable'
  readonly server: string
  readonly state?: McpServerRuntimeState
}

export interface McpPromptListRequest { readonly server: string }
export interface McpPromptListResponse {
  readonly server: string
  readonly prompts: readonly {
    readonly name: string
    readonly title?: string
    readonly description?: string
    readonly arguments?: readonly { readonly name: string; readonly description?: string; readonly required?: boolean }[]
  }[]
}

export interface McpPromptGetRequest {
  readonly server: string
  readonly prompt: string
  readonly arguments?: Readonly<Record<string, string>>
}
export interface McpPromptGetResponse {
  readonly server: string
  readonly prompt: string
  readonly description?: string
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: unknown }[]
}

export interface McpResourceListRequest { readonly server: string }
export interface McpResourceListResponse {
  readonly server: string
  readonly resources: readonly {
    readonly uri: string
    readonly name: string
    readonly title?: string
    readonly description?: string
    readonly mimeType?: string
    readonly size?: number
  }[]
}

export interface McpResourceReadRequest { readonly server: string; readonly uri: string }
export interface McpResourceReadResponse {
  readonly outcome: 'read' | 'unsupported'
  readonly server: string
  readonly uri: string
  readonly contents?: readonly unknown[]
}

export type McpJsonValue = null | boolean | number | string | readonly McpJsonValue[] | { readonly [key: string]: McpJsonValue }
export interface McpJsonObject { readonly [key: string]: McpJsonValue }

export type McpToolExposureSource = 'project' | 'user' | 'native-tool' | 'native-server' | 'native-default'
export type McpNativeToolExposureSource = 'native-tool' | 'native-server' | 'native-default'
export interface McpToolExposureResolution {
  readonly server: string
  readonly tool: string
  readonly exposure: McpExposure
  readonly source: McpToolExposureSource
  readonly nativeExposure: McpExposure
  readonly nativeSource: McpNativeToolExposureSource
  readonly serverState: McpServerStatus | 'unknown'
}

export interface McpToolAnnotations {
  readonly title: string | null
  readonly readOnlyHint: boolean | null
  readonly destructiveHint: boolean | null
  readonly idempotentHint: boolean | null
  readonly openWorldHint: boolean | null
}

export interface McpNativeToolView {
  readonly name: string
  readonly title: string | null
  readonly description: string | null
  readonly inputSchema: McpJsonObject
  readonly outputSchema: McpJsonObject | null
  readonly annotations: McpToolAnnotations
  readonly taskSupport: 'forbidden' | 'optional' | 'required' | null
  readonly exposure: McpToolExposureResolution
}

export interface McpToolsListRequest { readonly server: string }
export interface McpToolsListResponse {
  readonly outcome: 'listed' | 'denied' | 'unavailable'
  readonly server: string
  readonly tools: readonly McpNativeToolView[]
  readonly truncated: boolean
}

export interface McpResourceTemplatesListRequest { readonly server: string }
export interface McpResourceTemplatesListResponse {
  readonly outcome: 'listed' | 'denied' | 'unavailable'
  readonly server: string
  readonly templates: readonly {
    readonly uriTemplate: string
    readonly name: string
    readonly title: string | null
    readonly description: string | null
    readonly mimeType: string | null
  }[]
  readonly truncated: boolean
}

export interface McpServerInstructionsRequest { readonly server: string }
export interface McpServerInstructionsResponse {
  readonly outcome: 'available' | 'denied' | 'unavailable'
  readonly server: string
  readonly instructions: string | null
  readonly state: McpServerStatus | null
}

export interface McpToolExposureReadRequest { readonly server: string; readonly tool: string }
export interface McpToolExposureReadResponse {
  readonly outcome: 'resolved' | 'denied' | 'unavailable'
  readonly server: string
  readonly tool: string
  readonly resolution: McpToolExposureResolution | null
  readonly userRevision: number | null
  readonly projectRevision: number | null
}

export interface McpToolExposureUpdateRequest {
  readonly scope: McpConfigScope
  readonly expectedRevision: number
  readonly server: string
  readonly tool: string
  /** Null removes this app-side override and restores inherited native exposure. */
  readonly exposure: McpExposure | null
}
export interface McpToolExposureUpdateResponse {
  readonly outcome: 'saved' | 'conflict' | 'denied' | 'unavailable'
  readonly scope: McpConfigScope | null
  readonly server: string
  readonly tool: string
  readonly resolution: McpToolExposureResolution | null
  readonly userRevision: number | null
  readonly projectRevision: number | null
}

export interface McpAppsOpenRequest { readonly server: string; readonly resourceUri: string }
export interface McpAppsOpenResponse {
  readonly outcome: 'opened' | 'denied' | 'unavailable'
  readonly server: string
  readonly resourceUri: string
  readonly appId: string | null
  readonly windowId: number | null
}

export interface McpAuthBeginRequest { readonly server: string }
export interface McpAuthBeginResponse { readonly outcome: 'started' | 'auth-required' | 'unsupported' }
export interface McpAuthLogoutRequest { readonly server: string }
export interface McpAuthLogoutResponse {
  readonly outcome: 'cleared' | 'not-found' | 'oauth-unsupported'
  readonly appSecretsCleared: boolean
}

/** Write-only secret input. Values are accepted once and are never echoed in a response. */
export interface McpSecretWriteRequest {
  readonly operation: 'set'
  readonly server: string
  readonly key: string
  readonly value: string
}
export interface McpSecretDeleteRequest {
  readonly operation: 'delete'
  readonly server: string
  readonly key: string
}
export type McpSecretMutationRequest = McpSecretWriteRequest | McpSecretDeleteRequest
export interface McpSecretWriteResponse {
  readonly outcome: 'saved' | 'deleted' | 'not-found'
  readonly server: string
  readonly key: string
}

export type McpEventPayload =
  | {
      readonly type: 'server-state-changed'
      readonly server: string
      readonly state: McpServerStatus
      readonly authentication: 'none' | 'configured' | 'required'
      readonly error?: string
      readonly diagnostic?: string
    }
  | { readonly type: 'server-removed'; readonly server: string }
  | { readonly type: 'availability-changed'; readonly available: boolean }

export interface McpCapabilities {
  'mcp.servers.list': { readonly request: McpServerListRequest; readonly response: McpServerListResponse }
  'mcp.servers.read': { readonly request: McpServerReadRequest; readonly response: McpServerReadResponse }
  'mcp.servers.create': { readonly request: McpServerCreateRequest; readonly response: McpServerMutationResponse }
  'mcp.servers.update': { readonly request: McpServerUpdateRequest; readonly response: McpServerMutationResponse }
  'mcp.servers.delete': { readonly request: McpServerDeleteRequest; readonly response: McpServerMutationResponse }
  'mcp.servers.enable': { readonly request: McpServerEnableRequest; readonly response: McpServerMutationResponse }
  'mcp.servers.disable': { readonly request: McpServerEnableRequest; readonly response: McpServerMutationResponse }
  'mcp.servers.connect': { readonly request: McpServerNameRequest; readonly response: McpServerConnectionResponse }
  'mcp.servers.disconnect': { readonly request: McpServerNameRequest; readonly response: McpServerConnectionResponse }
  'mcp.servers.reconnect': { readonly request: McpServerNameRequest; readonly response: McpServerConnectionResponse }
  'mcp.prompts.list': { readonly request: McpPromptListRequest; readonly response: McpPromptListResponse }
  'mcp.prompts.get': { readonly request: McpPromptGetRequest; readonly response: McpPromptGetResponse }
  'mcp.resources.list': { readonly request: McpResourceListRequest; readonly response: McpResourceListResponse }
  'mcp.resources.read': { readonly request: McpResourceReadRequest; readonly response: McpResourceReadResponse }
  'mcp.tools.list': { readonly request: McpToolsListRequest; readonly response: McpToolsListResponse }
  'mcp.resource-templates.list': { readonly request: McpResourceTemplatesListRequest; readonly response: McpResourceTemplatesListResponse }
  'mcp.server.instructions': { readonly request: McpServerInstructionsRequest; readonly response: McpServerInstructionsResponse }
  'mcp.exposure.read': { readonly request: McpToolExposureReadRequest; readonly response: McpToolExposureReadResponse }
  'mcp.exposure.update': { readonly request: McpToolExposureUpdateRequest; readonly response: McpToolExposureUpdateResponse }
  'mcp.apps.open': { readonly request: McpAppsOpenRequest; readonly response: McpAppsOpenResponse }
  'mcp.auth.begin': { readonly request: McpAuthBeginRequest; readonly response: McpAuthBeginResponse }
  'mcp.auth.logout': { readonly request: McpAuthLogoutRequest; readonly response: McpAuthLogoutResponse }
  'mcp.secrets.write': { readonly request: McpSecretMutationRequest; readonly response: McpSecretWriteResponse }
}

export interface McpEventContracts {
  'mcp.events': { readonly payload: McpEventPayload }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends McpCapabilities {}
  interface IpcEventContracts extends McpEventContracts {}
}

export function isMcpEventPayload(value: unknown): value is McpEventPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  if (event.type === 'availability-changed') {
    return Object.keys(event).length === 2 && typeof event.available === 'boolean'
  }
  if (event.type === 'server-removed') {
    return Object.keys(event).length === 2 && typeof event.server === 'string'
      && /^[A-Za-z0-9_-]{1,128}$/.test(event.server)
  }
  if (event.type !== 'server-state-changed'
    || typeof event.server !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.server)
    || !['connecting', 'connected', 'auth-required', 'failed', 'disabled'].includes(String(event.state))
    || !['none', 'configured', 'required'].includes(String(event.authentication))) return false
  const allowed = ['type', 'server', 'state', 'authentication', 'error', 'diagnostic']
  if (Object.keys(event).some((key) => !allowed.includes(key))) return false
  return (!Object.hasOwn(event, 'error') || typeof event.error === 'string' && event.error.length <= 512)
    && (!Object.hasOwn(event, 'diagnostic') || typeof event.diagnostic === 'string' && event.diagnostic.length <= 512)
}

export function isMcpServerRuntimeState(value: unknown): value is McpServerRuntimeState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  const allowed = ['state', 'authentication', 'error', 'diagnostic', 'instructions']
  return Object.keys(state).every((key) => allowed.includes(key))
    && ['connecting', 'connected', 'auth-required', 'failed', 'disabled'].includes(String(state.state))
    && ['none', 'configured', 'required'].includes(String(state.authentication))
    && (!Object.hasOwn(state, 'error') || typeof state.error === 'string' && state.error.length <= 512)
    && (!Object.hasOwn(state, 'diagnostic') || typeof state.diagnostic === 'string' && state.diagnostic.length <= 512)
    && (!Object.hasOwn(state, 'instructions') || typeof state.instructions === 'string' && state.instructions.length <= 4096)
}

export function isMcpServerConfigView(value: unknown): value is McpServerConfigView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  const allowed = [
    'name', 'scope', 'transport', 'enabled', 'command', 'args', 'cwd', 'envKeys', 'url', 'headerNames',
    'authProvider', 'oauth', 'timeout', 'exposure', 'description', 'toolExposure', 'overriddenByProject', 'runtime',
  ]
  if (Object.keys(config).some((key) => !allowed.includes(key))) return false
  const isStringArray = (item: unknown): boolean => Array.isArray(item)
    && item.length <= 512 && item.every((entry) => typeof entry === 'string' && entry.length <= 8192)
  if (typeof config.name !== 'string' || config.name.length > 128
    || (config.scope !== 'user' && config.scope !== 'project')
    || (config.transport !== 'stdio' && config.transport !== 'http')
    || typeof config.enabled !== 'boolean'
    || !['codemode', 'deferred', 'direct', 'hidden'].includes(String(config.exposure))) return false
  if (Object.hasOwn(config, 'command') && (typeof config.command !== 'string' || config.command.length > 8192)) return false
  if (Object.hasOwn(config, 'args') && !isStringArray(config.args)) return false
  if (Object.hasOwn(config, 'cwd') && (typeof config.cwd !== 'string' || config.cwd.length > 4096)) return false
  if (Object.hasOwn(config, 'envKeys') && !isStringArray(config.envKeys)) return false
  if (Object.hasOwn(config, 'url') && (typeof config.url !== 'string' || config.url.length > 4096)) return false
  if (Object.hasOwn(config, 'headerNames') && !isStringArray(config.headerNames)) return false
  if (Object.hasOwn(config, 'authProvider') && (typeof config.authProvider !== 'string' || config.authProvider.length > 256)) return false
  if (Object.hasOwn(config, 'timeout') && (typeof config.timeout !== 'number' || !Number.isFinite(config.timeout))) return false
  if (Object.hasOwn(config, 'description') && (typeof config.description !== 'string' || config.description.length > 8192)) return false
  if (Object.hasOwn(config, 'overriddenByProject') && typeof config.overriddenByProject !== 'boolean') return false
  if (Object.hasOwn(config, 'runtime') && !isMcpServerRuntimeState(config.runtime)) return false
  const validExposures = (item: unknown): boolean => item !== null && typeof item === 'object' && !Array.isArray(item)
    && Object.entries(item).length <= 512
    && Object.entries(item).every(([key, entry]) => key.length <= 256 && ['codemode', 'deferred', 'direct', 'hidden'].includes(String(entry)))
  if (Object.hasOwn(config, 'toolExposure') && !validExposures(config.toolExposure)) return false
  if (Object.hasOwn(config, 'oauth')) {
    if (config.oauth === null || typeof config.oauth !== 'object' || Array.isArray(config.oauth)) return false
    const oauth = config.oauth as Record<string, unknown>
    const oauthKeys = ['clientId', 'clientSecretConfigured', 'callbackPort', 'callbackUrl', 'scope', 'clientName', 'clientRegistration', 'authServerMetadataUrl']
    if (Object.keys(oauth).some((key) => !oauthKeys.includes(key))
      || typeof oauth.clientSecretConfigured !== 'boolean'
      || Object.entries(oauth).some(([key, entry]) => key !== 'clientSecretConfigured' && key !== 'callbackPort' && typeof entry !== 'string')
      || (Object.hasOwn(oauth, 'callbackPort') && (typeof oauth.callbackPort !== 'number' || !Number.isInteger(oauth.callbackPort)))
      || (Object.hasOwn(oauth, 'clientRegistration') && oauth.clientRegistration !== 'dcr' && oauth.clientRegistration !== 'cimd')) return false
  }
  return true
}

export function isMcpServerListResponse(value: unknown): value is McpServerListResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const keys = Object.hasOwn(response, 'projectRevision')
    ? ['servers', 'userRevision', 'projectRevision'] : ['servers', 'userRevision']
  return Object.keys(response).length === keys.length && keys.every((key) => Object.hasOwn(response, key))
    && Array.isArray(response.servers) && response.servers.length <= 512
    && response.servers.every(isMcpServerConfigView)
    && Number.isSafeInteger(response.userRevision) && (response.userRevision as number) >= 0
    && (!Object.hasOwn(response, 'projectRevision') || Number.isSafeInteger(response.projectRevision) && (response.projectRevision as number) >= 0)
}

export function isMcpServerReadResponse(value: unknown): value is McpServerReadResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const keys = Object.hasOwn(response, 'projectRevision')
    ? ['server', 'userRevision', 'projectRevision'] : ['server', 'userRevision']
  return Object.keys(response).length === keys.length && keys.every((key) => Object.hasOwn(response, key))
    && (response.server === null || isMcpServerConfigView(response.server))
    && Number.isSafeInteger(response.userRevision) && (response.userRevision as number) >= 0
    && (!Object.hasOwn(response, 'projectRevision') || Number.isSafeInteger(response.projectRevision) && (response.projectRevision as number) >= 0)
}

export function isMcpServerMutationResponse(value: unknown): value is McpServerMutationResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  return Object.keys(response).length === 3
    && Object.hasOwn(response, 'outcome') && Object.hasOwn(response, 'revision') && Object.hasOwn(response, 'server')
    && ['saved', 'conflict', 'session-reload-required'].includes(String(response.outcome))
    && Number.isSafeInteger(response.revision) && (response.revision as number) >= 0
    && (response.server === null || isMcpServerConfigView(response.server))
}

export function isMcpServerConnectionResponse(value: unknown): value is McpServerConnectionResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const keys = Object.hasOwn(response, 'state') ? ['outcome', 'server', 'state'] : ['outcome', 'server']
  return Object.keys(response).length === keys.length && keys.every((key) => Object.hasOwn(response, key))
    && ['connected', 'disconnected', 'reconnected', 'auth-required', 'failed', 'unavailable'].includes(String(response.outcome))
    && typeof response.server === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(response.server)
    && (!Object.hasOwn(response, 'state') || isMcpServerRuntimeState(response.state))
}

export function isMcpSecretWriteResponse(value: unknown): value is McpSecretWriteResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  return Object.keys(response).length === 3
    && Object.hasOwn(response, 'outcome') && Object.hasOwn(response, 'server') && Object.hasOwn(response, 'key')
    && ['saved', 'deleted', 'not-found'].includes(String(response.outcome))
    && typeof response.server === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(response.server)
    && typeof response.key === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(response.key)
}

export function isMcpPromptGetResponse(value: unknown): value is McpPromptGetResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const keys = Object.hasOwn(response, 'description')
    ? ['server', 'prompt', 'description', 'messages'] : ['server', 'prompt', 'messages']
  return Object.keys(response).length === keys.length && keys.every((key) => Object.hasOwn(response, key))
    && typeof response.server === 'string' && response.server.length <= 128
    && typeof response.prompt === 'string' && response.prompt.length <= 256
    && (!Object.hasOwn(response, 'description') || typeof response.description === 'string' && response.description.length <= 8192)
    && Array.isArray(response.messages) && response.messages.length <= 256
    && response.messages.every((message) => message !== null && typeof message === 'object' && !Array.isArray(message)
      && Object.keys(message).length === 2
      && ((message as Record<string, unknown>).role === 'user' || (message as Record<string, unknown>).role === 'assistant')
      && Object.hasOwn(message, 'content'))
}

export function isMcpPromptListResponse(value: unknown): value is McpPromptListResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  return Object.keys(response).length === 2
    && typeof response.server === 'string' && response.server.length <= 128
    && Array.isArray(response.prompts) && response.prompts.length <= 512
    && response.prompts.every((prompt) => {
      if (prompt === null || typeof prompt !== 'object' || Array.isArray(prompt)) return false
      const item = prompt as Record<string, unknown>
      const keys = ['name', 'title', 'description', 'arguments']
      return Object.keys(item).every((key) => keys.includes(key))
        && typeof item.name === 'string' && item.name.length <= 256
        && (!Object.hasOwn(item, 'title') || typeof item.title === 'string' && item.title.length <= 1024)
        && (!Object.hasOwn(item, 'description') || typeof item.description === 'string' && item.description.length <= 8192)
        && (!Object.hasOwn(item, 'arguments') || Array.isArray(item.arguments) && item.arguments.length <= 256
          && item.arguments.every((argument) => {
            if (argument === null || typeof argument !== 'object' || Array.isArray(argument)) return false
            const arg = argument as Record<string, unknown>
            return Object.keys(arg).every((key) => ['name', 'description', 'required'].includes(key))
              && typeof arg.name === 'string' && arg.name.length <= 256
              && (!Object.hasOwn(arg, 'description') || typeof arg.description === 'string' && arg.description.length <= 4096)
              && (!Object.hasOwn(arg, 'required') || typeof arg.required === 'boolean')
          }))
    })
}

export function isMcpResourceListResponse(value: unknown): value is McpResourceListResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  return Object.keys(response).length === 2
    && typeof response.server === 'string' && response.server.length <= 128
    && Array.isArray(response.resources) && response.resources.length <= 2048
    && response.resources.every((resource) => {
      if (resource === null || typeof resource !== 'object' || Array.isArray(resource)) return false
      const item = resource as Record<string, unknown>
      return Object.keys(item).every((key) => ['uri', 'name', 'title', 'description', 'mimeType', 'size'].includes(key))
        && typeof item.uri === 'string' && item.uri.length <= 4096
        && typeof item.name === 'string' && item.name.length <= 512
        && (!Object.hasOwn(item, 'title') || typeof item.title === 'string' && item.title.length <= 1024)
        && (!Object.hasOwn(item, 'description') || typeof item.description === 'string' && item.description.length <= 8192)
        && (!Object.hasOwn(item, 'mimeType') || typeof item.mimeType === 'string' && item.mimeType.length <= 256)
        && (!Object.hasOwn(item, 'size') || typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0)
    })
}

export function isMcpResourceReadResponse(value: unknown): value is McpResourceReadResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  if (response.outcome === 'unsupported') {
    return Object.keys(response).length === 3
      && typeof response.server === 'string' && response.server.length <= 128
      && typeof response.uri === 'string' && response.uri.length <= 4096
  }
  return response.outcome === 'read' && Object.keys(response).length === 4
    && typeof response.server === 'string' && response.server.length <= 128
    && typeof response.uri === 'string' && response.uri.length <= 4096
    && Array.isArray(response.contents) && response.contents.length <= 256
}

function isMcpServerName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value)
}

function isMcpToolName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0')
    && !['__proto__', 'constructor', 'prototype'].includes(value)
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isBoundedMcpJson(value: unknown, state = { nodes: 16_384, bytes: 512 * 1024 }, depth = 0): value is McpJsonValue {
  state.nodes -= 1
  if (state.nodes < 0 || depth > 24) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') {
    state.bytes -= utf8ByteLength(value)
    return value.length <= 65_536 && state.bytes >= 0
  }
  if (Array.isArray(value)) {
    if (value.length > 4_096) return false
    return value.every((item) => isBoundedMcpJson(item, state, depth + 1))
  }
  if (!isPlainRecord(value)) return false
  const entries = Object.entries(value)
  if (entries.length > 2_048) return false
  for (const [key, item] of entries) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false
    state.bytes -= utf8ByteLength(key)
    if (state.bytes < 0 || !isBoundedMcpJson(item, state, depth + 1)) return false
  }
  return true
}

function isMcpJsonObject(value: unknown, budget = { nodes: 16_384, bytes: 512 * 1024 }): value is McpJsonObject {
  return isPlainRecord(value) && isBoundedMcpJson(value, budget)
}

export function isMcpToolExposureResolution(value: unknown): value is McpToolExposureResolution {
  return isPlainRecord(value)
    && hasExactKeys(value, ['server', 'tool', 'exposure', 'source', 'nativeExposure', 'nativeSource', 'serverState'])
    && isMcpServerName(value.server)
    && isMcpToolName(value.tool)
    && ['codemode', 'deferred', 'direct', 'hidden'].includes(String(value.exposure))
    && ['project', 'user', 'native-tool', 'native-server', 'native-default'].includes(String(value.source))
    && ['codemode', 'deferred', 'direct', 'hidden'].includes(String(value.nativeExposure))
    && ['native-tool', 'native-server', 'native-default'].includes(String(value.nativeSource))
    && (value.serverState === 'unknown' || ['connecting', 'connected', 'auth-required', 'failed', 'disabled'].includes(String(value.serverState)))
}

function isMcpNativeToolView(
  value: unknown,
  budget: { nodes: number; bytes: number },
): value is McpNativeToolView {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations', 'taskSupport', 'exposure',
  ])) return false
  const annotations = value.annotations
  if (!isPlainRecord(annotations) || !hasExactKeys(annotations, [
    'title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint',
  ])) return false
  return isMcpToolName(value.name)
    && (value.title === null || typeof value.title === 'string' && value.title.length <= 256)
    && (value.description === null || typeof value.description === 'string' && value.description.length <= 8_192)
    && isMcpJsonObject(value.inputSchema, budget)
    && (value.outputSchema === null || isMcpJsonObject(value.outputSchema, budget))
    && (annotations.title === null || typeof annotations.title === 'string' && annotations.title.length <= 256)
    && ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
      .every((key) => annotations[key] === null || typeof annotations[key] === 'boolean')
    && (value.taskSupport === null || ['forbidden', 'optional', 'required'].includes(String(value.taskSupport)))
    && isMcpToolExposureResolution(value.exposure)
}

export function isMcpToolsListRequest(value: unknown): value is McpToolsListRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['server']) && isMcpServerName(value.server)
}

export function isMcpToolsListResponse(value: unknown): value is McpToolsListResponse {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['outcome', 'server', 'tools', 'truncated'])
    || !['listed', 'denied', 'unavailable'].includes(String(value.outcome))
    || !isMcpServerName(value.server)
    || !Array.isArray(value.tools) || value.tools.length > 512
    || typeof value.truncated !== 'boolean') return false
  const budget = { nodes: 32_768, bytes: 1024 * 1024 }
  return value.tools.every((tool) => isMcpNativeToolView(tool, budget))
}

export function isMcpResourceTemplatesListRequest(value: unknown): value is McpResourceTemplatesListRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['server']) && isMcpServerName(value.server)
}

export function isMcpResourceTemplatesListResponse(value: unknown): value is McpResourceTemplatesListResponse {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['outcome', 'server', 'templates', 'truncated'])
    || !['listed', 'denied', 'unavailable'].includes(String(value.outcome))
    || !isMcpServerName(value.server) || !Array.isArray(value.templates) || value.templates.length > 512
    || typeof value.truncated !== 'boolean') return false
  return value.templates.every((item) => isPlainRecord(item)
    && hasExactKeys(item, ['uriTemplate', 'name', 'title', 'description', 'mimeType'])
    && typeof item.uriTemplate === 'string' && item.uriTemplate.length > 0 && item.uriTemplate.length <= 4_096
    && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 512
    && (item.title === null || typeof item.title === 'string' && item.title.length <= 1_024)
    && (item.description === null || typeof item.description === 'string' && item.description.length <= 8_192)
    && (item.mimeType === null || typeof item.mimeType === 'string' && item.mimeType.length <= 256))
}

export function isMcpServerInstructionsRequest(value: unknown): value is McpServerInstructionsRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['server']) && isMcpServerName(value.server)
}

export function isMcpServerInstructionsResponse(value: unknown): value is McpServerInstructionsResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome', 'server', 'instructions', 'state'])
    && ['available', 'denied', 'unavailable'].includes(String(value.outcome))
    && isMcpServerName(value.server)
    && (value.instructions === null || typeof value.instructions === 'string' && value.instructions.length <= 4_096)
    && (value.state === null || ['connecting', 'connected', 'auth-required', 'failed', 'disabled'].includes(String(value.state)))
}

export function isMcpToolExposureReadRequest(value: unknown): value is McpToolExposureReadRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['server', 'tool'])
    && isMcpServerName(value.server) && isMcpToolName(value.tool)
}

export function isMcpToolExposureReadResponse(value: unknown): value is McpToolExposureReadResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome', 'server', 'tool', 'resolution', 'userRevision', 'projectRevision'])
    && ['resolved', 'denied', 'unavailable'].includes(String(value.outcome))
    && isMcpServerName(value.server) && isMcpToolName(value.tool)
    && (value.resolution === null || isMcpToolExposureResolution(value.resolution))
    && (value.userRevision === null || Number.isSafeInteger(value.userRevision) && (value.userRevision as number) >= 0)
    && (value.projectRevision === null || Number.isSafeInteger(value.projectRevision) && (value.projectRevision as number) >= 0)
}

export function isMcpToolExposureUpdateRequest(value: unknown): value is McpToolExposureUpdateRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['scope', 'expectedRevision', 'server', 'tool', 'exposure'])
    && (value.scope === 'user' || value.scope === 'project')
    && Number.isSafeInteger(value.expectedRevision) && (value.expectedRevision as number) >= 0
    && isMcpServerName(value.server) && isMcpToolName(value.tool)
    && (value.exposure === null || ['codemode', 'deferred', 'direct', 'hidden'].includes(String(value.exposure)))
}

export function isMcpToolExposureUpdateResponse(value: unknown): value is McpToolExposureUpdateResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome', 'scope', 'server', 'tool', 'resolution', 'userRevision', 'projectRevision'])
    && ['saved', 'conflict', 'denied', 'unavailable'].includes(String(value.outcome))
    && (value.scope === null || value.scope === 'user' || value.scope === 'project')
    && isMcpServerName(value.server) && isMcpToolName(value.tool)
    && (value.resolution === null || isMcpToolExposureResolution(value.resolution))
    && (value.userRevision === null || Number.isSafeInteger(value.userRevision) && (value.userRevision as number) >= 0)
    && (value.projectRevision === null || Number.isSafeInteger(value.projectRevision) && (value.projectRevision as number) >= 0)
}

export function isMcpAppsOpenRequest(value: unknown): value is McpAppsOpenRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['server', 'resourceUri'])
    && isMcpServerName(value.server)
    && typeof value.resourceUri === 'string' && value.resourceUri.length > 0 && value.resourceUri.length <= 4_096
    && !value.resourceUri.includes('\0')
}

export function isMcpAppsOpenResponse(value: unknown): value is McpAppsOpenResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['outcome', 'server', 'resourceUri', 'appId', 'windowId'])
    && ['opened', 'denied', 'unavailable'].includes(String(value.outcome))
    && isMcpServerName(value.server)
    && typeof value.resourceUri === 'string' && value.resourceUri.length > 0 && value.resourceUri.length <= 4_096
    && (value.appId === null || typeof value.appId === 'string' && value.appId.length <= 128)
    && (value.windowId === null || Number.isSafeInteger(value.windowId) && (value.windowId as number) >= 0)
}

export function isMcpAuthBeginResponse(value: unknown): value is McpAuthBeginResponse {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && ['started', 'auth-required', 'unsupported'].includes(String((value as Record<string, unknown>).outcome))
}

export function isMcpAuthLogoutResponse(value: unknown): value is McpAuthLogoutResponse {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2
    && ['cleared', 'not-found', 'oauth-unsupported'].includes(String((value as Record<string, unknown>).outcome))
    && typeof (value as Record<string, unknown>).appSecretsCleared === 'boolean'
}

export type McpRuntimeEventEnvelope = { readonly runtime: RuntimeScope; readonly payload: McpEventPayload }
