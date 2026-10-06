import type {
  NativeMcpFacade,
  NativeMcpPromptResult,
  NativeMcpResource,
  NativeMcpServerState,
} from './native-facade.ts'
import type { McpSecretsStore } from '../security/secrets.ts'
import type {
  McpEventPayload,
  McpPromptGetResponse,
  McpPromptListResponse,
  McpResourceListResponse,
  McpResourceReadResponse,
  McpServerConnectionResponse,
  McpServerRuntimeState,
} from '../../shared/mcp.ts'

const MAX_MCP_RESULT_BYTES = 512 * 1024
const MAX_LIST_ITEMS = 512
const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const SENSITIVE_VALUE = /((?:authorization|access[-_]?token|refresh[-_]?token|client[-_]?secret|api[-_]?key|password|credential|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi

function redactMessage(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(SENSITIVE_VALUE, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1?[redacted]')
    .slice(0, 512)
}

export interface McpConnectionServiceOptions {
  readonly facade: NativeMcpFacade
  /** Resource reads require a public native-owner hook; this seam stays unavailable until Pi exposes one. */
  readonly readResource?: (server: string, uri: string) => Promise<readonly unknown[]>
  /** OAuth flow hooks must be provided by a main-owned adapter over Pi's native sign-in flow. */
  readonly beginOAuth?: (server: string) => Promise<'started' | 'auth-required'>
  readonly logoutOAuth?: (server: string) => Promise<boolean>
}

function projectRuntimeState(state: NativeMcpServerState | undefined): McpServerRuntimeState | undefined {
  if (!state) return undefined
  return {
    state: state.state,
    authentication: state.authentication,
    ...(state.error ? { error: redactMessage(state.error) } : {}),
    ...(state.diagnostic ? { diagnostic: redactMessage(state.diagnostic) } : {}),
  }
}

function assertName(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value) || UNSAFE_NAMES.has(value)) throw new TypeError('MCP server name is invalid.')
}

function assertBoundedResult(value: unknown): void {
  let serialized: string | undefined
  try { serialized = JSON.stringify(value) } catch { throw new TypeError('MCP server returned an invalid result.') }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_MCP_RESULT_BYTES) {
    throw new TypeError('MCP server result exceeds the response limit.')
  }
}

function mapResource(resource: NativeMcpResource): McpResourceListResponse['resources'][number] {
  return {
    uri: resource.uri.slice(0, 4096),
    name: resource.name.slice(0, 512),
    ...(resource.title === undefined ? {} : { title: resource.title.slice(0, 1024) }),
    ...(resource.description === undefined ? {} : { description: resource.description.slice(0, 8192) }),
    ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType.slice(0, 256) }),
    ...(resource.size === undefined ? {} : { size: resource.size }),
  }
}

function projectPromptResult(server: string, prompt: string, result: NativeMcpPromptResult): McpPromptGetResponse {
  const response: McpPromptGetResponse = {
    server,
    prompt,
    ...(result.description === undefined ? {} : { description: result.description.slice(0, 8192) }),
    messages: result.messages.slice(0, 256).map((message) => ({ role: message.role, content: message.content })),
  }
  assertBoundedResult(response)
  return response
}

export class McpConnectionService {
  private readonly facade: NativeMcpFacade
  private readonly readResourceHook?: McpConnectionServiceOptions['readResource']
  private readonly beginOAuthHook?: McpConnectionServiceOptions['beginOAuth']
  private readonly logoutOAuthHook?: McpConnectionServiceOptions['logoutOAuth']

  constructor(options: McpConnectionServiceOptions) {
    this.facade = options.facade
    this.readResourceHook = options.readResource
    this.beginOAuthHook = options.beginOAuth
    this.logoutOAuthHook = options.logoutOAuth
  }

  get available(): boolean {
    return this.facade.available
  }

  listRuntimeStates(): ReadonlyMap<string, McpServerRuntimeState> {
    const states = new Map<string, McpServerRuntimeState>()
    for (const server of this.facade.listServers()) {
      const state = projectRuntimeState(server)
      if (state) states.set(server.name, state)
    }
    return states
  }

  getRuntimeState(name: string): McpServerRuntimeState | undefined {
    assertName(name)
    return projectRuntimeState(this.facade.getServerState(name))
  }

  async connect(name: string): Promise<McpServerConnectionResponse> {
    return this.runConnectionAction(name, 'connected', () => this.facade.connect(name))
  }

  async disconnect(name: string): Promise<McpServerConnectionResponse> {
    return this.runConnectionAction(name, 'disconnected', () => this.facade.disconnect(name))
  }

  async reconnect(name: string): Promise<McpServerConnectionResponse> {
    return this.runConnectionAction(name, 'reconnected', () => this.facade.reconnect(name))
  }

  async listPrompts(server: string): Promise<McpPromptListResponse> {
    assertName(server)
    this.assertAvailable()
    const prompts = await this.facade.listPrompts(server)
    if (prompts.length > MAX_LIST_ITEMS) throw new TypeError('MCP prompt list exceeds the response limit.')
    const response: McpPromptListResponse = {
      server,
      prompts: prompts.map((prompt) => ({
        name: prompt.name.slice(0, 256),
        ...(prompt.title === undefined ? {} : { title: prompt.title.slice(0, 1024) }),
        ...(prompt.description === undefined ? {} : { description: prompt.description.slice(0, 8192) }),
        ...(prompt.arguments === undefined ? {} : {
          arguments: prompt.arguments.slice(0, 256).map((argument) => ({
            name: argument.name.slice(0, 256),
            ...(argument.description === undefined ? {} : { description: argument.description.slice(0, 4096) }),
            ...(argument.required === undefined ? {} : { required: argument.required }),
          })),
        }),
      })),
    }
    assertBoundedResult(response)
    return response
  }

  async getPrompt(server: string, prompt: string, args?: Record<string, string>): Promise<McpPromptGetResponse> {
    assertName(server)
    if (!prompt || prompt.length > 256) throw new TypeError('MCP prompt name is invalid.')
    this.assertAvailable()
    const result = await this.facade.getPrompt(server, prompt, args)
    return projectPromptResult(server, prompt, result)
  }

  async listResources(server: string): Promise<McpResourceListResponse> {
    assertName(server)
    this.assertAvailable()
    const resources = await this.facade.listResources(server)
    if (resources.length > MAX_LIST_ITEMS) throw new TypeError('MCP resource list exceeds the response limit.')
    const response: McpResourceListResponse = { server, resources: resources.map(mapResource) }
    assertBoundedResult(response)
    return response
  }

  async readResource(server: string, uri: string): Promise<McpResourceReadResponse> {
    assertName(server)
    if (!uri || uri.length > 4096) throw new TypeError('MCP resource URI is invalid.')
    this.assertAvailable()
    if (!this.readResourceHook) return { outcome: 'unsupported', server, uri }
    const contents = await this.readResourceHook(server, uri)
    if (contents.length > 256) throw new TypeError('MCP resource result exceeds the response limit.')
    const response: McpResourceReadResponse = { outcome: 'read', server, uri, contents }
    assertBoundedResult(response)
    return response
  }

  async beginAuth(server: string): Promise<'started' | 'auth-required' | 'unsupported'> {
    assertName(server)
    this.assertAvailable()
    if (this.beginOAuthHook) return this.beginOAuthHook(server)
    return 'unsupported'
  }

  async logout(
    server: string,
    secrets: McpSecretsStore,
  ): Promise<{ readonly outcome: 'cleared' | 'not-found' | 'oauth-unsupported'; readonly appSecretsCleared: boolean }> {
    assertName(server)
    const clearedAppSecrets = secrets.clearServer(server)
    if (this.logoutOAuthHook) {
      const clearedOAuth = await this.logoutOAuthHook(server)
      return {
        outcome: clearedOAuth || clearedAppSecrets ? 'cleared' : 'not-found',
        appSecretsCleared: clearedAppSecrets,
      }
    }
    return { outcome: 'oauth-unsupported', appSecretsCleared: clearedAppSecrets }
  }

  subscribe(publish: (event: McpEventPayload) => void): () => void {
    return this.facade.subscribe((event) => {
      if (event.type === 'availability-changed') {
        publish({ type: 'availability-changed', available: event.available })
      } else if (event.type === 'server-removed') {
        publish({ type: 'server-removed', server: event.name.slice(0, 256) })
      } else {
        publish({
          type: 'server-state-changed',
          server: event.server.name.slice(0, 256),
          state: event.server.state,
          authentication: event.server.authentication,
          ...(event.server.error ? { error: redactMessage(event.server.error) } : {}),
          ...(event.server.diagnostic ? { diagnostic: redactMessage(event.server.diagnostic) } : {}),
        })
      }
    })
  }

  private async runConnectionAction(
    name: string,
    success: 'connected' | 'disconnected' | 'reconnected',
    operation: () => Promise<void>,
  ): Promise<McpServerConnectionResponse> {
    assertName(name)
    if (!this.facade.available) return { outcome: 'unavailable', server: name }
    if (!this.facade.getServerState(name)) return { outcome: 'failed', server: name }
    try {
      await operation()
      const state = this.getRuntimeState(name)
      return {
        outcome: state?.state === 'auth-required' ? 'auth-required' : success,
        server: name,
        ...(state ? { state } : {}),
      }
    } catch {
      const state = this.getRuntimeState(name)
      return {
        outcome: state?.state === 'auth-required' ? 'auth-required' : 'failed',
        server: name,
        ...(state ? { state } : {}),
      }
    }
  }

  private assertAvailable(): void {
    if (!this.facade.available) throw new TypeError('The native MCP owner is unavailable.')
  }
}
