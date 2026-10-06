import { randomBytes, randomUUID } from 'node:crypto'
import {
  BrowserWindow,
  ipcMain,
  protocol,
  session as electronSession,
  type IpcMainEvent,
  type Session,
  type WebContents,
} from 'electron'
import type { NativeMcpResource, NativeMcpServerState, NativeMcpTool } from './native-facade.ts'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import {
  MCP_APPS_CHANNELS,
  isMcpAppsAppMessage,
  isMcpAppsHostMessage,
  isMcpAppsJsonObject,
  type McpAppsHostMessage,
  type McpAppsJsonObject,
  type McpAppsJsonValue,
  type McpAppsToolDescription,
} from '../../shared/mcp-apps.ts'

export const MCP_APPS_PROTOCOL = 'mcp-app'
export const MCP_APPS_MAX_RESOURCE_BYTES = 2 * 1024 * 1024
const MAX_TOOLS_PER_APP = 64
const MAX_PENDING_CALLS_PER_APP = 16
const MAX_BRIDGE_JSON_BYTES = 256 * 1024
const HTML_MIME = /^text\/html(?:\s*;[^\r\n]{0,160})?$/i
const MIME_HEADER = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;[^\r\n]{0,160})?$/
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

let protocolPrivilegesRegistered = false

/** Call before app readiness. Session protocol handlers are installed separately per viewer. */
export function registerMcpAppsSchemePrivileges(): void {
  if (protocolPrivilegesRegistered) return
  protocol.registerSchemesAsPrivileged([{
    scheme: MCP_APPS_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      allowServiceWorkers: false,
      codeCache: false,
      stream: false,
    },
  }])
  protocolPrivilegesRegistered = true
}

export interface McpAppsResourcePayload {
  readonly contents: readonly {
    readonly uri: string
    readonly mimeType?: string
    readonly text?: string
    readonly blob?: string
  }[]
}

/**
 * The Pi manager facade intentionally does not expose resource reads or tool invocation. The parent
 * must bind these callbacks to the active native connection; no generic renderer IPC is used.
 */
export interface McpAppsNativeHost {
  getServerState(server: string): NativeMcpServerState | undefined
  listResources(server: string): Promise<readonly NativeMcpResource[]>
  readResource(server: string, uri: string): Promise<McpAppsResourcePayload>
  listTools(server: string): Promise<readonly NativeMcpTool[]>
  callTool(server: string, tool: string, args: McpAppsJsonObject): Promise<unknown>
}

export interface McpAppsResourceServiceOptions {
  readonly native: McpAppsNativeHost
  /** The exact runtime generation whose native resource/client owner backs this service. */
  readonly runtimeScope: RuntimeScope
  /** Permission is checked for every call; absence or rejection means deny. */
  readonly authorizeToolCall: (server: string, tool: string, appId: string) => boolean | Promise<boolean>
  readonly onResize?: (appId: string, size: { readonly width: number; readonly height: number }) => void
  readonly onAppError?: (appId: string, error: { readonly code: string; readonly message: string }) => void
  readonly maxResourceBytes?: number
}

export interface McpAppsResourceGrant {
  readonly appId: string
  readonly server: string
  readonly resourceUri: string
  readonly url: string
}

export interface McpAppsViewerResult extends McpAppsResourceGrant {
  readonly window: BrowserWindow
}

interface RegisteredApp extends McpAppsResourceGrant {
  readonly hostToken: string
  readonly tools: readonly McpAppsToolDescription[]
  readonly pendingCalls: Set<string>
  webContentsId?: number
  webContents?: WebContents
}

function isAppResource(resource: NativeMcpResource): boolean {
  return resource.uri.startsWith('ui://') || /;\s*profile\s*=\s*"?mcp-app"?/i.test(resource.mimeType ?? '')
}

function safeMimeType(value: string | undefined): string | undefined {
  return value && value.length <= 256 && MIME_HEADER.test(value) ? value : undefined
}

function isAllowedAssetMime(mimeType: string): boolean {
  const type = mimeType.split(';', 1)[0]!.trim().toLowerCase()
  return type === 'text/javascript'
    || type === 'application/javascript'
    || type === 'text/css'
    || type.startsWith('image/')
    || type.startsWith('font/')
    || type === 'application/font-woff'
    || type === 'application/font-woff2'
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toBoundedJson(value: unknown): McpAppsJsonValue {
  let remainingNodes = 2_048
  let remainingBytes = MAX_BRIDGE_JSON_BYTES
  const visit = (candidate: unknown, depth: number): McpAppsJsonValue => {
    remainingNodes -= 1
    if (remainingNodes < 0 || depth > 8) throw new Error('MCP Apps message exceeds its structural limit.')
    if (candidate === null || typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'string') {
      const bytes = Buffer.byteLength(candidate)
      remainingBytes -= bytes
      if (bytes > 64 * 1024 || remainingBytes < 0) throw new Error('MCP Apps message exceeds its size limit.')
      return candidate
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error('MCP Apps message contains an invalid number.')
      return candidate
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 256) throw new Error('MCP Apps message contains too many values.')
      return candidate.map((item) => visit(item, depth + 1))
    }
    if (!isJsonObject(candidate)) throw new Error('MCP Apps message is not JSON data.')
    const entries = Object.entries(candidate)
    if (entries.length > 256) throw new Error('MCP Apps message contains too many properties.')
    const result: Record<string, McpAppsJsonValue> = {}
    for (const [key, item] of entries) {
      if (key === '__proto__' || key === 'constructor') throw new Error('MCP Apps message contains an unsafe property.')
      remainingBytes -= Buffer.byteLength(key)
      if (remainingBytes < 0) throw new Error('MCP Apps message exceeds its size limit.')
      result[key] = visit(item, depth + 1)
    }
    return result
  }
  return visit(value, 0)
}

function toSchemaObject(value: unknown): McpAppsJsonObject {
  try {
    const bounded = toBoundedJson(value)
    return isMcpAppsJsonObject(bounded) ? bounded : Object.freeze({})
  } catch {
    return Object.freeze({})
  }
}

function makeToolDescription(tool: NativeMcpTool): McpAppsToolDescription {
  return {
    name: tool.name.slice(0, 256),
    ...(tool.title ? { title: tool.title.slice(0, 256) } : {}),
    ...(tool.description ? { description: tool.description.slice(0, 2_048) } : {}),
    inputSchema: toSchemaObject(tool.inputSchema),
  }
}

function buildAppResourceResponse(contents: Uint8Array, mimeType: string): Response {
  const body = new ArrayBuffer(contents.byteLength)
  new Uint8Array(body).set(contents)
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=()',
    },
  })
}

export class McpAppsResourceService {
  private readonly native: McpAppsNativeHost
  private readonly runtimeScope: RuntimeScope
  private readonly authorizeToolCall: McpAppsResourceServiceOptions['authorizeToolCall']
  private readonly onResize?: McpAppsResourceServiceOptions['onResize']
  private readonly onAppError?: McpAppsResourceServiceOptions['onAppError']
  private readonly maxResourceBytes: number
  private readonly apps = new Map<string, RegisteredApp>()
  private readonly appsByWebContents = new Map<number, RegisteredApp>()
  private readonly handledSessions = new WeakSet<Session>()
  private readonly onIpcMessageBound: (event: IpcMainEvent, message: unknown) => void
  private disposed = false

  constructor(options: McpAppsResourceServiceOptions) {
    this.native = options.native
    this.runtimeScope = Object.freeze({ ...options.runtimeScope })
    this.authorizeToolCall = options.authorizeToolCall
    this.onResize = options.onResize
    this.onAppError = options.onAppError
    this.maxResourceBytes = Math.min(
      Math.max(options.maxResourceBytes ?? MCP_APPS_MAX_RESOURCE_BYTES, 1),
      MCP_APPS_MAX_RESOURCE_BYTES,
    )
    this.onIpcMessageBound = (event, message) => this.onIpcMessage(event, message)
    ipcMain.on(MCP_APPS_CHANNELS.toHost, this.onIpcMessageBound)
  }

  isForRuntime(scope: RuntimeScope): boolean {
    return this.runtimeScope.ownerId === scope.ownerId && this.runtimeScope.generation === scope.generation
  }

  async registerResource(server: string, resourceUri: string): Promise<McpAppsResourceGrant> {
    if (this.disposed) throw new Error('MCP Apps resource service is disposed.')
    const state = this.native.getServerState(server)
    if (!state || state.state !== 'connected' || !state.config.enabled) {
      throw new Error('The MCP server is not connected.')
    }
    const resources = await this.native.listResources(server)
    const resource = resources.find((candidate) => candidate.uri === resourceUri)
    if (!resource || !isAppResource(resource)) throw new Error('The MCP app resource is not supplied by this connected server.')
    if (resource.size !== undefined && resource.size > this.maxResourceBytes) {
      throw new Error('The MCP app resource exceeds the configured size limit.')
    }
    const hostToken = randomBytes(24).toString('hex')
    const appId = randomUUID()
    let listedTools: readonly NativeMcpTool[] = []
    try {
      listedTools = await this.native.listTools(server)
    } catch {
      // Resource display remains available when the server's optional tool catalog cannot be read.
    }
    const tools: McpAppsToolDescription[] = []
    for (const tool of listedTools.slice(0, MAX_TOOLS_PER_APP)) {
      const candidate = makeToolDescription(tool)
      const candidateTools = [...tools, candidate]
      const validInit: McpAppsHostMessage = {
        type: 'init',
        appId,
        server,
        resourceUri,
        tools: candidateTools,
      }
      if (!isMcpAppsHostMessage(validInit)) continue
      if (Buffer.byteLength(JSON.stringify(candidateTools)) > 128 * 1024) break
      tools.push(candidate)
    }
    const grant: RegisteredApp = {
      appId,
      server,
      resourceUri,
      hostToken,
      url: `${MCP_APPS_PROTOCOL}://${hostToken}/index.html`,
      tools,
      pendingCalls: new Set(),
    }
    this.apps.set(appId, grant)
    return { appId, server, resourceUri, url: grant.url }
  }

  async openViewer(options: {
    readonly server: string
    readonly resourceUri: string
    readonly preloadPath: string
    readonly width?: number
    readonly height?: number
  }): Promise<McpAppsViewerResult> {
    if (!protocolPrivilegesRegistered) {
      throw new Error('Register the mcp-app scheme privileges before app readiness before opening viewers.')
    }
    const grant = await this.registerResource(options.server, options.resourceUri)
    const registered = this.apps.get(grant.appId)
    if (!registered) throw new Error('MCP Apps resource registration expired.')
    const partition = `mcp-apps-${grant.appId}`
    const appSession = electronSession.fromPartition(partition, { cache: false })
    this.installProtocolHandler(appSession)
    appSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    appSession.setPermissionCheckHandler(() => false)
    appSession.on('will-download', (event) => event.preventDefault())

    const width = Number.isInteger(options.width) ? Math.min(Math.max(options.width!, 320), 1_920) : 960
    const height = Number.isInteger(options.height) ? Math.min(Math.max(options.height!, 240), 1_440) : 720
    const window = new BrowserWindow({
      width,
      height,
      show: false,
      webPreferences: {
        session: appSession,
        preload: options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
      },
    })
    registered.webContentsId = window.webContents.id
    registered.webContents = window.webContents
    this.appsByWebContents.set(window.webContents.id, registered)
    const allowedOrigin = new URL(grant.url).origin
    const allowNavigation = (candidate: string): boolean => {
      try {
        const url = new URL(candidate)
        return url.origin === allowedOrigin
          && url.protocol === `${MCP_APPS_PROTOCOL}:`
          && !url.username
          && !url.password
          && !url.search
          && !url.hash
          && (url.pathname === '/index.html' || url.pathname === '/')
      } catch {
        return false
      }
    }
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, candidate) => {
      if (!allowNavigation(candidate)) event.preventDefault()
    })
    window.webContents.on('will-redirect', (event, candidate) => {
      if (!allowNavigation(candidate)) event.preventDefault()
    })
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.once('closed', () => this.releaseApp(grant.appId))

    try {
      await window.loadURL(grant.url)
      if (window.isDestroyed()) throw new Error('MCP Apps window was closed before it loaded.')
      const init: McpAppsHostMessage = {
        type: 'init',
        appId: registered.appId,
        server: registered.server,
        resourceUri: registered.resourceUri,
        tools: registered.tools,
      }
      if (isMcpAppsHostMessage(init)) window.webContents.send(MCP_APPS_CHANNELS.fromHost, init)
      window.show()
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      this.releaseApp(grant.appId)
      throw error
    }
    return { ...grant, window }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ipcMain.removeListener(MCP_APPS_CHANNELS.toHost, this.onIpcMessageBound)
    for (const appId of this.apps.keys()) this.releaseApp(appId)
  }

  private installProtocolHandler(appSession: Session): void {
    if (this.handledSessions.has(appSession)) return
    appSession.protocol.handle(MCP_APPS_PROTOCOL, (request) => this.handleResourceRequest(request))
    this.handledSessions.add(appSession)
  }

  private async handleResourceRequest(request: Request): Promise<Response> {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } })
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Not found', { status: 404 })
    }
    if (url.protocol !== `${MCP_APPS_PROTOCOL}:`
      || url.username
      || url.password
      || url.search
      || url.hash) {
      return new Response('Not found', { status: 404 })
    }
    const grant = [...this.apps.values()].find((app) => app.hostToken === url.hostname)
    if (!grant) return new Response('Not found', { status: 404 })
    const state = this.native.getServerState(grant.server)
    if (!state || state.state !== 'connected' || !state.config.enabled) return new Response('Unavailable', { status: 503 })
    try {
      const resources = await this.native.listResources(grant.server)
      let metadata: NativeMcpResource | undefined
      if (url.pathname === '/index.html' || url.pathname === '/') {
        metadata = resources.find((resource) => resource.uri === grant.resourceUri)
        if (!metadata || !isAppResource(metadata)) return new Response('Not found', { status: 404 })
      } else {
        let decodedPath: string
        try {
          decodedPath = decodeURIComponent(url.pathname)
        } catch {
          return new Response('Not found', { status: 404 })
        }
        const segments = decodedPath.split('/').filter(Boolean)
        if (segments.length === 0 || segments.some((part) => part === '.' || part === '..' || part.includes('\\'))) {
          return new Response('Not found', { status: 404 })
        }
        const assetName = segments[segments.length - 1]!
        const candidates = resources.filter((resource) => {
          if (resource.uri === grant.resourceUri) return false
          const uriTail = resource.uri.split(/[/?#]/).filter(Boolean).at(-1)
          return resource.name === assetName || uriTail === assetName
        })
        if (candidates.length !== 1) return new Response('Not found', { status: 404 })
        metadata = candidates[0]
      }
      if (!metadata) return new Response('Not found', { status: 404 })
      if (metadata.size !== undefined && metadata.size > this.maxResourceBytes) {
        return new Response('Resource too large', { status: 413 })
      }
      const read = await this.native.readResource(grant.server, metadata.uri)
      const content = read.contents.find((item) => item.uri === metadata!.uri)
      if (!content) return new Response('Resource not found', { status: 404 })
      const mimeType = safeMimeType(content.mimeType ?? metadata.mimeType)
      const isDocument = metadata.uri === grant.resourceUri
      if (!mimeType || (isDocument ? !HTML_MIME.test(mimeType) : !isAllowedAssetMime(mimeType))) {
        return new Response('Unsupported resource type', { status: 415 })
      }
      let bytes: Buffer
      if (typeof content.text === 'string') {
        if (Buffer.byteLength(content.text, 'utf8') > this.maxResourceBytes) {
          return new Response('Resource too large', { status: 413 })
        }
        bytes = Buffer.from(content.text, 'utf8')
      } else if (typeof content.blob === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(content.blob)) {
        if (content.blob.length > Math.ceil(this.maxResourceBytes / 3) * 4 + 4) {
          return new Response('Resource too large', { status: 413 })
        }
        bytes = Buffer.from(content.blob, 'base64')
      } else {
        return new Response('Resource has no HTML content', { status: 502 })
      }
      if (bytes.byteLength > this.maxResourceBytes) return new Response('Resource too large', { status: 413 })
      return buildAppResourceResponse(bytes, mimeType)
    } catch {
      return new Response('Unable to read MCP app resource', { status: 502 })
    }
  }

  private onIpcMessage(event: IpcMainEvent, rawMessage: unknown): void {
    const grant = this.appsByWebContents.get(event.sender.id)
    if (!grant || !isMcpAppsAppMessage(rawMessage)) return
    const frame = event.senderFrame
    if (!frame || frame.parent !== null || !this.isFrameForGrant(frame.url, grant)) return
    switch (rawMessage.type) {
      case 'tool-call-request':
        void this.handleToolCall(grant, rawMessage.requestId, rawMessage.toolName, rawMessage.arguments)
        return
      case 'resize': {
        const appWindow = BrowserWindow.fromWebContents(event.sender)
        if (appWindow && !appWindow.isDestroyed()) appWindow.setSize(rawMessage.width, rawMessage.height)
        try {
          this.onResize?.(grant.appId, { width: rawMessage.width, height: rawMessage.height })
        } catch {
          // Host observers do not affect the app window.
        }
        return
      }
      case 'error':
        try {
          this.onAppError?.(grant.appId, { code: rawMessage.code, message: rawMessage.message })
        } catch {
          // Host observers do not affect the app window.
        }
    }
  }

  private async handleToolCall(
    grant: RegisteredApp,
    requestId: string,
    toolName: string,
    args: McpAppsJsonObject,
  ): Promise<void> {
    const webContentsId = grant.webContentsId
    if (webContentsId === undefined || grant.pendingCalls.size >= MAX_PENDING_CALLS_PER_APP || grant.pendingCalls.has(requestId)) {
      this.sendToolCallError(grant, requestId, 'APP_BUSY', 'The app cannot start another tool call right now.')
      return
    }
    grant.pendingCalls.add(requestId)
    try {
      const server = this.native.getServerState(grant.server)
      if (!server || server.state !== 'connected' || !server.config.enabled) {
        this.sendToolCallError(grant, requestId, 'SERVER_UNAVAILABLE', 'The MCP server is not connected.')
        return
      }
      const tools = await this.native.listTools(grant.server)
      if (!tools.some((tool) => tool.name === toolName)) {
        this.sendToolCallError(grant, requestId, 'TOOL_NOT_FOUND', 'The requested tool is not offered by this server.')
        return
      }
      let authorized = false
      try {
        authorized = await this.authorizeToolCall(grant.server, toolName, grant.appId)
      } catch {
        authorized = false
      }
      if (!authorized) {
        this.sendToolCallError(grant, requestId, 'PERMISSION_DENIED', 'This app is not permitted to call that tool.')
        return
      }
      const result = toBoundedJson(await this.native.callTool(grant.server, toolName, args))
      this.sendToApp(grant, { type: 'tool-call-response', requestId, ok: true, result })
    } catch (error) {
      this.sendToolCallError(
        grant,
        requestId,
        'TOOL_CALL_FAILED',
        error instanceof Error ? error.message.slice(0, 2_048) : 'The native MCP tool call failed.',
      )
    } finally {
      grant.pendingCalls.delete(requestId)
    }
  }

  private sendToolCallError(grant: RegisteredApp, requestId: string, code: string, message: string): void {
    this.sendToApp(grant, {
      type: 'tool-call-response',
      requestId,
      ok: false,
      error: { code, message: message.slice(0, 2_048) },
    })
  }

  private sendToApp(grant: RegisteredApp, message: McpAppsHostMessage): void {
    const id = grant.webContentsId
    if (id === undefined || !isMcpAppsHostMessage(message)) return
    const contents = this.appsByWebContents.has(id) ? grant.webContents : undefined
    if (contents && !contents.isDestroyed()) contents.send(MCP_APPS_CHANNELS.fromHost, message)
  }

  private isFrameForGrant(frameUrl: string, grant: RegisteredApp): boolean {
    try {
      const frame = new URL(frameUrl)
      const expected = new URL(grant.url)
      return frame.origin === expected.origin
        && frame.protocol === `${MCP_APPS_PROTOCOL}:`
        && (frame.pathname === '/index.html' || frame.pathname === '/')
        && !frame.username
        && !frame.password
        && !frame.search
        && !frame.hash
    } catch {
      return false
    }
  }

  private releaseApp(appId: string): void {
    const app = this.apps.get(appId)
    if (!app) return
    this.apps.delete(appId)
    if (app.webContentsId !== undefined) this.appsByWebContents.delete(app.webContentsId)
    app.webContents = undefined
  }
}

/** Main-side viewer factory. Each app gets an ephemeral Electron session and an isolated origin. */
export function createMcpAppsViewerFactory(service: McpAppsResourceService): {
  open(options: {
    readonly server: string
    readonly resourceUri: string
    readonly preloadPath: string
    readonly width?: number
    readonly height?: number
  }): Promise<McpAppsViewerResult>
} {
  return { open: (options) => service.openViewer(options) }
}
