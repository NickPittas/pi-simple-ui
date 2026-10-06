export type NativeMcpServerStatus = 'connecting' | 'connected' | 'auth-required' | 'failed' | 'disabled'
export type NativeMcpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden'

export interface NativeMcpTool {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly inputSchema: Record<string, unknown>
  readonly outputSchema?: Record<string, unknown>
  readonly annotations?: {
    readonly title?: string
    readonly readOnlyHint?: boolean
    readonly destructiveHint?: boolean
    readonly idempotentHint?: boolean
    readonly openWorldHint?: boolean
  }
  readonly execution?: { readonly taskSupport?: 'forbidden' | 'optional' | 'required' }
}

export interface NativeMcpResource {
  readonly uri: string
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly mimeType?: string
  readonly size?: number
}

export interface NativeMcpResourceTemplate {
  readonly uriTemplate: string
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly mimeType?: string
}

export interface NativeMcpPromptArgument {
  readonly name: string
  readonly description?: string
  readonly required?: boolean
}

export interface NativeMcpPrompt {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly arguments?: readonly NativeMcpPromptArgument[]
}

export interface NativeMcpPromptResult {
  readonly description?: string
  readonly messages: readonly {
    readonly role: 'user' | 'assistant'
    readonly content: unknown
  }[]
}

export interface NativeMcpServerState {
  readonly name: string
  readonly state: NativeMcpServerStatus
  readonly authentication: 'none' | 'configured' | 'required'
  readonly config: {
    readonly transport: 'stdio' | 'http'
    readonly enabled: boolean
    readonly envKeys: readonly string[]
    readonly headerNames: readonly string[]
    readonly exposure: NativeMcpExposure
    readonly scope?: 'global' | 'project' | 'extension'
  }
  readonly error?: string
  readonly diagnostic?: string
  readonly instructions?: string
}

export interface NativeMcpStateChangedEvent {
  readonly type: 'server-state-changed'
  readonly server: {
    readonly name: string
    readonly state: NativeMcpServerStatus
    readonly authentication: 'none' | 'configured' | 'required'
    readonly error?: string
    readonly diagnostic?: string
  }
}

export interface NativeMcpServerRemovedEvent {
  readonly type: 'server-removed'
  readonly name: string
}

export interface NativeMcpAvailabilityChangedEvent {
  readonly type: 'availability-changed'
  readonly available: boolean
}

export type NativeMcpOwnerEvent = NativeMcpStateChangedEvent | NativeMcpServerRemovedEvent
export type NativeMcpFacadeEvent = NativeMcpOwnerEvent | NativeMcpAvailabilityChangedEvent

/** Structural view of the public owner accessor exported by Pi's native MCP extension. */
export interface NativeMcpOwner {
  listServers(): NativeMcpServerState[]
  getServerState(name: string): NativeMcpServerState | undefined
  listTools(name: string): Promise<NativeMcpTool[]>
  listResources(name: string): Promise<NativeMcpResource[]>
  listTemplates(name: string): Promise<NativeMcpResourceTemplate[]>
  listPrompts(name: string): Promise<NativeMcpPrompt[]>
  getPrompt(name: string, promptName: string, args?: Record<string, string>): Promise<NativeMcpPromptResult>
  connect(name: string): Promise<void>
  disconnect(name: string): Promise<void>
  reconnect(name: string): Promise<void>
  subscribe(listener: (event: NativeMcpOwnerEvent) => void): () => void
}

export interface NativeMcpFacade {
  readonly available: boolean
  listServers(): NativeMcpServerState[]
  getServerState(name: string): NativeMcpServerState | undefined
  listTools(name: string): Promise<NativeMcpTool[]>
  listResources(name: string): Promise<NativeMcpResource[]>
  listTemplates(name: string): Promise<NativeMcpResourceTemplate[]>
  listPrompts(name: string): Promise<NativeMcpPrompt[]>
  getPrompt(name: string, promptName: string, args?: Record<string, string>): Promise<NativeMcpPromptResult>
  connect(name: string): Promise<void>
  disconnect(name: string): Promise<void>
  reconnect(name: string): Promise<void>
  subscribe(listener: (event: NativeMcpFacadeEvent) => void): () => void
  attach(owner: NativeMcpOwner | undefined): void
  dispose(): void
}

class MainNativeMcpFacade implements NativeMcpFacade {
  private owner: NativeMcpOwner | undefined
  private unsubscribeOwner: (() => void) | undefined
  private readonly listeners = new Set<(event: NativeMcpFacadeEvent) => void>()

  get available(): boolean {
    return this.owner !== undefined
  }

  listServers(): NativeMcpServerState[] {
    return this.owner?.listServers() ?? []
  }

  getServerState(name: string): NativeMcpServerState | undefined {
    return this.owner?.getServerState(name)
  }

  listTools(name: string): Promise<NativeMcpTool[]> {
    return this.owner?.listTools(name) ?? Promise.resolve([])
  }

  listResources(name: string): Promise<NativeMcpResource[]> {
    return this.owner?.listResources(name) ?? Promise.resolve([])
  }

  listTemplates(name: string): Promise<NativeMcpResourceTemplate[]> {
    return this.owner?.listTemplates(name) ?? Promise.resolve([])
  }

  listPrompts(name: string): Promise<NativeMcpPrompt[]> {
    return this.owner?.listPrompts(name) ?? Promise.resolve([])
  }

  getPrompt(name: string, promptName: string, args?: Record<string, string>): Promise<NativeMcpPromptResult> {
    return this.requireOwner().getPrompt(name, promptName, args)
  }

  connect(name: string): Promise<void> {
    return this.requireOwner().connect(name)
  }

  disconnect(name: string): Promise<void> {
    return this.requireOwner().disconnect(name)
  }

  reconnect(name: string): Promise<void> {
    return this.requireOwner().reconnect(name)
  }

  subscribe(listener: (event: NativeMcpFacadeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  attach(owner: NativeMcpOwner | undefined): void {
    if (this.owner === owner) return
    this.unsubscribeOwner?.()
    this.unsubscribeOwner = undefined
    this.owner = owner
    if (owner) this.unsubscribeOwner = owner.subscribe((event) => this.emit(event))
    this.emit({ type: 'availability-changed', available: owner !== undefined })
  }

  dispose(): void {
    this.attach(undefined)
    this.listeners.clear()
  }

  private requireOwner(): NativeMcpOwner {
    if (!this.owner) throw new Error('The native MCP extension is not available.')
    return this.owner
  }

  private emit(event: NativeMcpFacadeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Host observers cannot disrupt the native MCP owner.
      }
    }
  }
}

export function createNativeMcpFacade(): NativeMcpFacade {
  return new MainNativeMcpFacade()
}
