import type { CapabilityContext, CapabilityDefinition, AuthorizedIpcCaller } from '../ipc/register.ts'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { McpIpcRuntimeBinding } from '../ipc/mcp.ts'
import {
  isMcpResourceTemplatesListRequest,
  isMcpResourceTemplatesListResponse,
  isMcpServerInstructionsRequest,
  isMcpServerInstructionsResponse,
  isMcpToolExposureReadRequest,
  isMcpToolExposureReadResponse,
  isMcpToolExposureUpdateRequest,
  isMcpToolExposureUpdateResponse,
  isMcpToolsListRequest,
  isMcpToolsListResponse,
  MCP_IPC,
  type McpCapabilities,
  type McpJsonObject,
  type McpJsonValue,
  type McpNativeToolView,
  type McpToolExposureResolution,
  type McpResourceTemplatesListRequest,
  type McpResourceTemplatesListResponse,
  type McpServerInstructionsRequest,
  type McpServerInstructionsResponse,
  type McpToolExposureReadRequest,
  type McpToolExposureReadResponse,
  type McpToolExposureUpdateRequest,
  type McpToolExposureUpdateResponse,
  type McpToolsListRequest,
  type McpToolsListResponse,
} from '../../shared/mcp.ts'
import type { McpExposureContext, McpExposureService } from './exposure-service.ts'
import type { NativeMcpFacade, NativeMcpServerState, NativeMcpTool } from './native-facade.ts'

export type McpBackendOperation = 'read' | 'update-exposure'

/** Services must be resolved from the authorized caller and exact runtime generation. */
export interface McpBackendRuntimeBinding extends Pick<McpIpcRuntimeBinding, 'config' | 'cwd' | 'isProjectTrusted'> {
  readonly scope: RuntimeScope
  readonly native: NativeMcpFacade
  readonly exposure: McpExposureService
  /** Main-process authorization tied to the current caller, exact runtime, and trust state. */
  readonly authorize: (
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    operation: McpBackendOperation,
    server: string,
  ) => boolean
}

export type McpBackendRuntimeResolver = (
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope,
) => McpBackendRuntimeBinding | undefined

/** These are main-owned app settings, never values supplied by the renderer. */
interface JsonBudget {
  nodes: number
  bytes: number
}

type McpBackendCapabilityIds = Pick<McpCapabilities,
  | 'mcp.tools.list'
  | 'mcp.resource-templates.list'
  | 'mcp.server.instructions'
  | 'mcp.exposure.read'
  | 'mcp.exposure.update'
>

type McpBackendCapabilityDefinition = {
  [K in keyof McpBackendCapabilityIds]: CapabilityDefinition<
    McpBackendCapabilityIds[K]['request'],
    McpBackendCapabilityIds[K]['response']
  >
}[keyof McpBackendCapabilityIds]

const MAX_TOOLS = 512
const MAX_TEMPLATES = 512
const MAX_TOOL_CATALOG_BYTES = 1024 * 1024
const TOOL_CATALOG_BUDGET: JsonBudget = { nodes: 32_768, bytes: MAX_TOOL_CATALOG_BYTES }

function sameScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return left.ownerId === right.ownerId && left.generation === right.generation
}

function runtimeBinding(
  resolver: McpBackendRuntimeResolver,
  context: CapabilityContext,
): McpBackendRuntimeBinding | undefined {
  if (!context.scope) return undefined
  try {
    const binding = resolver(context.caller, context.scope)
    return binding
      && sameScope(binding.scope, context.scope)
      && binding.exposure.usesNativeFacade(binding.native)
      ? binding
      : undefined
  } catch {
    return undefined
  }
}

function sameBackendOwner(
  resolver: McpBackendRuntimeResolver,
  context: CapabilityContext,
  expected: McpBackendRuntimeBinding,
): boolean {
  const current = runtimeBinding(resolver, context)
  return current !== undefined
    && current.native === expected.native
    && current.exposure === expected.exposure
    && current.config === expected.config
    && current.authorize === expected.authorize
}

function isTrustedAndAllowed(
  runtime: McpBackendRuntimeBinding,
  caller: AuthorizedIpcCaller,
  operation: McpBackendOperation,
  server: string,
): boolean {
  try {
    return runtime.isProjectTrusted() === true
      && runtime.authorize(caller, runtime.scope, operation, server) === true
  } catch {
    return false
  }
}

function getEnabledServer(runtime: McpBackendRuntimeBinding, server: string): NativeMcpServerState | undefined {
  try {
    if (!runtime.native.available) return undefined
    const state = runtime.native.getServerState(server)
    return state?.config.enabled ? state : undefined
  } catch {
    return undefined
  }
}

function toJsonValue(value: unknown, budget: JsonBudget, depth = 0): McpJsonValue {
  budget.nodes -= 1
  if (budget.nodes < 0 || depth > 24) throw new TypeError('MCP tool schema exceeds its structural limit.')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('MCP tool schema contains an invalid number.')
    return value
  }
  if (typeof value === 'string') {
    budget.bytes -= Buffer.byteLength(value, 'utf8')
    if (value.length > 65_536 || budget.bytes < 0) throw new TypeError('MCP tool schema exceeds its size limit.')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 4_096) throw new TypeError('MCP tool schema contains too many items.')
    return value.map((item) => toJsonValue(item, budget, depth + 1))
  }
  if (value === null || typeof value !== 'object') throw new TypeError('MCP tool schema is not JSON data.')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('MCP tool schema is not a plain JSON object.')
  const entries = Object.entries(value)
  if (entries.length > 2_048) throw new TypeError('MCP tool schema contains too many properties.')
  const result: Record<string, McpJsonValue> = Object.create(null) as Record<string, McpJsonValue>
  for (const [key, child] of entries) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new TypeError('MCP tool schema contains an unsafe property.')
    }
    budget.bytes -= Buffer.byteLength(key, 'utf8')
    if (budget.bytes < 0) throw new TypeError('MCP tool schema exceeds its size limit.')
    result[key] = toJsonValue(child, budget, depth + 1)
  }
  return result
}

function toJsonObject(value: unknown, budget: JsonBudget): McpJsonObject {
  const projected = toJsonValue(value, budget)
  const prototype = Object.getPrototypeOf(projected)
  if (projected === null || Array.isArray(projected) || typeof projected !== 'object'
    || (prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError('MCP tool schema must be a JSON object.')
  }
  return projected as McpJsonObject
}

function boundedText(value: string | undefined, maxLength: number): string | null {
  return value === undefined ? null : value.slice(0, maxLength)
}

function projectNativeTool(
  tool: NativeMcpTool,
  budget: JsonBudget,
  exposure: McpToolExposureResolution,
): McpNativeToolView {
  const annotations = tool.annotations
  return {
    name: tool.name.slice(0, 256),
    title: boundedText(tool.title, 256),
    description: boundedText(tool.description, 8_192),
    inputSchema: toJsonObject(tool.inputSchema, budget),
    outputSchema: tool.outputSchema === undefined ? null : toJsonObject(tool.outputSchema, budget),
    annotations: {
      title: boundedText(annotations?.title, 256),
      readOnlyHint: typeof annotations?.readOnlyHint === 'boolean' ? annotations.readOnlyHint : null,
      destructiveHint: typeof annotations?.destructiveHint === 'boolean' ? annotations.destructiveHint : null,
      idempotentHint: typeof annotations?.idempotentHint === 'boolean' ? annotations.idempotentHint : null,
      openWorldHint: typeof annotations?.openWorldHint === 'boolean' ? annotations.openWorldHint : null,
    },
    taskSupport: tool.execution?.taskSupport === 'forbidden'
      || tool.execution?.taskSupport === 'optional'
      || tool.execution?.taskSupport === 'required'
      ? tool.execution.taskSupport
      : null,
    exposure,
  }
}

function unavailableTools(server: string, outcome: 'denied' | 'unavailable'): McpToolsListResponse {
  return { outcome, server, tools: [], truncated: false }
}

function unavailableTemplates(server: string, outcome: 'denied' | 'unavailable'): McpResourceTemplatesListResponse {
  return { outcome, server, templates: [], truncated: false }
}

function unavailableInstructions(server: string, outcome: 'denied' | 'unavailable'): McpServerInstructionsResponse {
  return { outcome, server, instructions: null, state: null }
}

function unavailableExposure(
  server: string,
  tool: string,
  outcome: 'denied' | 'unavailable',
): McpToolExposureReadResponse {
  return { outcome, server, tool, resolution: null, userRevision: null, projectRevision: null }
}

function unavailableExposureUpdate(
  request: McpToolExposureUpdateRequest,
  outcome: 'denied' | 'unavailable',
): McpToolExposureUpdateResponse {
  return {
    outcome,
    scope: request.scope,
    server: request.server,
    tool: request.tool,
    resolution: null,
    userRevision: null,
    projectRevision: null,
  }
}

function makeExposureContext(
  resolver: McpBackendRuntimeResolver,
  capabilityContext: CapabilityContext,
  runtime: McpBackendRuntimeBinding,
  caller: AuthorizedIpcCaller,
  operation: McpBackendOperation,
  server: string,
): McpExposureContext | undefined {
  try {
    if (runtime.isProjectTrusted() !== true) return undefined
    const nativeToolExposureConfigs: Record<string, Readonly<Record<string, 'codemode' | 'deferred' | 'direct' | 'hidden'>>> = Object.create(null) as Record<
      string,
      Readonly<Record<string, 'codemode' | 'deferred' | 'direct' | 'hidden'>>
    >
    for (const serverEntry of runtime.config.list(runtime.cwd, true).servers) {
      if (serverEntry.toolExposure) nativeToolExposureConfigs[serverEntry.name] = serverEntry.toolExposure
    }
    return {
      cwd: runtime.cwd,
      projectTrusted: true,
      nativeToolExposureConfigs,
      reauthorize: () => sameBackendOwner(resolver, capabilityContext, runtime)
        && isTrustedAndAllowed(runtime, caller, operation, server),
    }
  } catch {
    return undefined
  }
}

/** Registers catalog and exposure operations against the already-instantiated Pi MCP owner. */
export function registerMcpBackendCapabilities(
  resolveRuntime: McpBackendRuntimeResolver,
): readonly McpBackendCapabilityDefinition[] {
  const toolsList: CapabilityDefinition<McpToolsListRequest, McpToolsListResponse> = {
    id: MCP_IPC.toolsList,
    scope: 'runtime',
    validateRequest: isMcpToolsListRequest,
    validateResponse: isMcpToolsListResponse,
    handle: async (context, request) => {
      const runtime = runtimeBinding(resolveRuntime, context)
      if (!runtime || !isTrustedAndAllowed(runtime, context.caller, 'read', request.server)) {
        return unavailableTools(request.server, 'denied')
      }
      const server = getEnabledServer(runtime, request.server)
      if (!server) return unavailableTools(request.server, 'unavailable')
      const exposureContext = makeExposureContext(resolveRuntime, context, runtime, context.caller, 'read', request.server)
      if (!exposureContext) return unavailableTools(request.server, 'denied')
      let nativeTools: NativeMcpTool[]
      try {
        nativeTools = await runtime.native.listTools(request.server)
      } catch {
        return unavailableTools(request.server, 'unavailable')
      }
      if (!isTrustedAndAllowed(runtime, context.caller, 'read', request.server)) {
        return unavailableTools(request.server, 'denied')
      }
      let exposures: readonly McpToolExposureResolution[]
      try {
        exposures = await runtime.exposure.resolveTools(
          request.server,
          nativeTools.slice(0, MAX_TOOLS).map((tool) => tool.name),
          exposureContext,
        )
      } catch {
        return unavailableTools(request.server, 'unavailable')
      }
      const tools: McpNativeToolView[] = []
      const budget = { ...TOOL_CATALOG_BUDGET }
      let catalogBytes = 0
      let truncated = nativeTools.length > MAX_TOOLS
      for (const [index, tool] of nativeTools.slice(0, MAX_TOOLS).entries()) {
        if (typeof tool.name !== 'string' || !tool.name || tool.name.length > 256 || tool.name.includes('\0')
          || ['__proto__', 'constructor', 'prototype'].includes(tool.name)) {
          truncated = true
          break
        }
        const candidateBudget = { ...budget }
        try {
          const projected = projectNativeTool(tool, candidateBudget, exposures[index]!)
          const projectedBytes = Buffer.byteLength(JSON.stringify(projected), 'utf8')
          if (catalogBytes + projectedBytes > MAX_TOOL_CATALOG_BYTES) {
            truncated = true
            break
          }
          tools.push(projected)
          catalogBytes += projectedBytes
          budget.nodes = candidateBudget.nodes
          budget.bytes = candidateBudget.bytes
        } catch {
          truncated = true
          break
        }
      }
      if (!isTrustedAndAllowed(runtime, context.caller, 'read', request.server)) {
        return unavailableTools(request.server, 'denied')
      }
      if (!sameBackendOwner(resolveRuntime, context, runtime)) return unavailableTools(request.server, 'unavailable')
      return { outcome: 'listed', server: request.server, tools, truncated }
    },
  }

  const resourceTemplates: CapabilityDefinition<McpResourceTemplatesListRequest, McpResourceTemplatesListResponse> = {
    id: MCP_IPC.resourceTemplatesList,
    scope: 'runtime',
    validateRequest: isMcpResourceTemplatesListRequest,
    validateResponse: isMcpResourceTemplatesListResponse,
    handle: async (context, request) => {
      const runtime = runtimeBinding(resolveRuntime, context)
      if (!runtime || !isTrustedAndAllowed(runtime, context.caller, 'read', request.server)) {
        return unavailableTemplates(request.server, 'denied')
      }
      if (!getEnabledServer(runtime, request.server)) return unavailableTemplates(request.server, 'unavailable')
      try {
        const templates = await runtime.native.listTemplates(request.server)
        if (!isTrustedAndAllowed(runtime, context.caller, 'read', request.server)) {
          return unavailableTemplates(request.server, 'denied')
        }
        if (!sameBackendOwner(resolveRuntime, context, runtime)) return unavailableTemplates(request.server, 'unavailable')
        const mapped = templates.slice(0, MAX_TEMPLATES).flatMap((template) => {
          if (typeof template.uriTemplate !== 'string' || !template.uriTemplate
            || typeof template.name !== 'string' || !template.name) return []
          return [{
            uriTemplate: template.uriTemplate.slice(0, 4_096),
            name: template.name.slice(0, 512),
            title: boundedText(template.title, 1_024),
            description: boundedText(template.description, 8_192),
            mimeType: boundedText(template.mimeType, 256),
          }]
        })
        return {
          outcome: 'listed',
          server: request.server,
          templates: mapped,
          truncated: templates.length > MAX_TEMPLATES || mapped.length !== Math.min(templates.length, MAX_TEMPLATES),
        }
      } catch {
        return unavailableTemplates(request.server, 'unavailable')
      }
    },
  }

  const instructions: CapabilityDefinition<McpServerInstructionsRequest, McpServerInstructionsResponse> = {
    id: MCP_IPC.serverInstructions,
    scope: 'runtime',
    validateRequest: isMcpServerInstructionsRequest,
    validateResponse: isMcpServerInstructionsResponse,
    handle: (context, request) => {
      const runtime = runtimeBinding(resolveRuntime, context)
      if (!runtime || !isTrustedAndAllowed(runtime, context.caller, 'read', request.server)) {
        return unavailableInstructions(request.server, 'denied')
      }
      const server = getEnabledServer(runtime, request.server)
      if (!server) return unavailableInstructions(request.server, 'unavailable')
      if (!isTrustedAndAllowed(runtime, context.caller, 'read', request.server)) {
        return unavailableInstructions(request.server, 'denied')
      }
      return {
        outcome: 'available',
        server: request.server,
        instructions: typeof server.instructions === 'string' ? server.instructions.slice(0, 4_096) : null,
        state: server.state,
      }
    },
  }

  const exposureRead: CapabilityDefinition<McpToolExposureReadRequest, McpToolExposureReadResponse> = {
    id: MCP_IPC.exposureRead,
    scope: 'runtime',
    validateRequest: isMcpToolExposureReadRequest,
    validateResponse: isMcpToolExposureReadResponse,
    handle: async (context, request) => {
      const runtime = runtimeBinding(resolveRuntime, context)
      if (!runtime || !isTrustedAndAllowed(runtime, context.caller, 'read', request.server)) {
        return unavailableExposure(request.server, request.tool, 'denied')
      }
      if (!getEnabledServer(runtime, request.server)) return unavailableExposure(request.server, request.tool, 'unavailable')
      const exposureContext = makeExposureContext(resolveRuntime, context, runtime, context.caller, 'read', request.server)
      if (!exposureContext) return unavailableExposure(request.server, request.tool, 'denied')
      let result
      try {
        result = await runtime.exposure.readToolExposure(request.server, request.tool, exposureContext)
      } catch {
        return unavailableExposure(request.server, request.tool, 'unavailable')
      }
      if (!sameBackendOwner(resolveRuntime, context, runtime)) {
        return unavailableExposure(request.server, request.tool, 'unavailable')
      }
      return { ...result, server: request.server, tool: request.tool }
    },
  }

  const exposureUpdate: CapabilityDefinition<McpToolExposureUpdateRequest, McpToolExposureUpdateResponse> = {
    id: MCP_IPC.exposureUpdate,
    scope: 'runtime',
    validateRequest: isMcpToolExposureUpdateRequest,
    validateResponse: isMcpToolExposureUpdateResponse,
    handle: async (context, request) => {
      const runtime = runtimeBinding(resolveRuntime, context)
      if (!runtime || !isTrustedAndAllowed(runtime, context.caller, 'update-exposure', request.server)) {
        return unavailableExposureUpdate(request, 'denied')
      }
      if (!getEnabledServer(runtime, request.server)) return unavailableExposureUpdate(request, 'unavailable')
      const exposureContext = makeExposureContext(resolveRuntime, context, runtime, context.caller, 'update-exposure', request.server)
      if (!exposureContext) return unavailableExposureUpdate(request, 'denied')
      let result
      try {
        result = await runtime.exposure.updateToolExposure({
          scope: request.scope,
          expectedRevision: request.expectedRevision,
          server: request.server,
          tool: request.tool,
          exposure: request.exposure,
        }, exposureContext)
      } catch {
        return unavailableExposureUpdate(request, 'unavailable')
      }
      if (!sameBackendOwner(resolveRuntime, context, runtime)) {
        return unavailableExposureUpdate(request, 'unavailable')
      }
      return { ...result, scope: request.scope, server: request.server, tool: request.tool }
    },
  }

  return [toolsList, resourceTemplates, instructions, exposureRead, exposureUpdate]
}
