import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

export const MCP_APPS_CHANNELS = Object.freeze({
  toHost: 'piDesktop:mcpApps:toHost',
  fromHost: 'piDesktop:mcpApps:fromHost',
})

export type McpAppsJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly McpAppsJsonValue[]
  | McpAppsJsonObject

export interface McpAppsJsonObject {
  readonly [key: string]: McpAppsJsonValue
}

export interface McpAppsToolDescription {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly inputSchema: McpAppsJsonObject
}

export type McpAppsHostMessage =
  | {
      readonly type: 'init'
      readonly appId: string
      readonly server: string
      readonly resourceUri: string
      readonly tools: readonly McpAppsToolDescription[]
    }
  | {
      readonly type: 'tool-call-response'
      readonly requestId: string
      readonly ok: true
      readonly result: McpAppsJsonValue
    }
  | {
      readonly type: 'tool-call-response'
      readonly requestId: string
      readonly ok: false
      readonly error: { readonly code: string; readonly message: string }
    }
  | {
      readonly type: 'error'
      readonly code: string
      readonly message: string
    }

export type McpAppsAppMessage =
  | {
      readonly type: 'tool-call-request'
      readonly requestId: string
      readonly toolName: string
      readonly arguments: McpAppsJsonObject
    }
  | {
      readonly type: 'resize'
      readonly width: number
      readonly height: number
    }
  | {
      readonly type: 'error'
      readonly code: string
      readonly message: string
    }

export interface McpAppsBridge {
  postMessage(message: McpAppsAppMessage): boolean
  onMessage(listener: (message: McpAppsHostMessage) => void): () => void
}

const MAX_JSON_NODES = 2_048
const MAX_JSON_STRING_LENGTH = 64 * 1024
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,256}$/
const SAFE_TOOL_NAME = /^[^\u0000-\u001f\u007f]{1,256}$/

function validJsonValue(value: unknown): value is McpAppsJsonValue {
  let nodes = 0
  let remainingCharacters = 256 * 1024
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1
    if (nodes > MAX_JSON_NODES || depth > 8) return false
    if (candidate === null || typeof candidate === 'boolean') return true
    if (typeof candidate === 'string') {
      remainingCharacters -= candidate.length
      return candidate.length <= MAX_JSON_STRING_LENGTH && remainingCharacters >= 0
    }
    if (typeof candidate === 'number') return Number.isFinite(candidate)
    if (Array.isArray(candidate)) return candidate.length <= 256 && candidate.every((item) => visit(item, depth + 1))
    if (!isPlainRecord(candidate)) return false
    const entries = Object.entries(candidate)
    return entries.length <= 256
      && entries.every(([key, item]) => {
        remainingCharacters -= key.length
        return key.length <= 256
          && key !== '__proto__'
          && key !== 'constructor'
          && remainingCharacters >= 0
          && visit(item, depth + 1)
      })
  }
  try {
    return visit(value, 0)
  } catch {
    return false
  }
}

function isRecordWithKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false
  const actual = Object.keys(value)
  return required.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => required.includes(key) || optional.includes(key))
}

function validError(value: unknown): value is { readonly code: string; readonly message: string } {
  return isPlainRecord(value)
    && hasExactKeys(value, ['code', 'message'])
    && typeof value.code === 'string'
    && value.code.length > 0
    && value.code.length <= 80
    && typeof value.message === 'string'
    && value.message.length <= 2_048
}

function validToolDescription(value: unknown): value is McpAppsToolDescription {
  if (!isRecordWithKeys(value, ['name', 'inputSchema'], ['title', 'description'])) return false
  return typeof value.name === 'string'
    && SAFE_TOOL_NAME.test(value.name)
    && (value.title === undefined || (typeof value.title === 'string' && value.title.length <= 256))
    && (value.description === undefined || (typeof value.description === 'string' && value.description.length <= 2_048))
    && isPlainRecord(value.inputSchema)
    && validJsonValue(value.inputSchema)
}

export function isMcpAppsJsonValue(value: unknown): value is McpAppsJsonValue {
  return validJsonValue(value)
}

export function isMcpAppsJsonObject(value: unknown): value is McpAppsJsonObject {
  return isPlainRecord(value) && validJsonValue(value)
}

export function isMcpAppsAppMessage(value: unknown): value is McpAppsAppMessage {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'tool-call-request':
      return hasExactKeys(value, ['type', 'requestId', 'toolName', 'arguments'])
        && typeof value.requestId === 'string'
        && REQUEST_ID.test(value.requestId)
        && typeof value.toolName === 'string'
        && SAFE_TOOL_NAME.test(value.toolName)
        && isMcpAppsJsonObject(value.arguments)
    case 'resize':
      return hasExactKeys(value, ['type', 'width', 'height'])
        && Number.isFinite(value.width)
        && Number.isFinite(value.height)
        && (value.width as number) >= 200
        && (value.width as number) <= 1_920
        && (value.height as number) >= 120
        && (value.height as number) <= 1_440
    case 'error':
      return hasExactKeys(value, ['type', 'code', 'message'])
        && typeof value.code === 'string'
        && value.code.length > 0
        && value.code.length <= 80
        && typeof value.message === 'string'
        && value.message.length <= 2_048
    default:
      return false
  }
}

export function isMcpAppsHostMessage(value: unknown): value is McpAppsHostMessage {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'init':
      return hasExactKeys(value, ['type', 'appId', 'server', 'resourceUri', 'tools'])
        && typeof value.appId === 'string'
        && /^[a-f0-9-]{36}$/.test(value.appId)
        && typeof value.server === 'string'
        && SAFE_NAME.test(value.server)
        && typeof value.resourceUri === 'string'
        && value.resourceUri.length <= 4_096
        && Array.isArray(value.tools)
        && value.tools.length <= 128
        && value.tools.every(validToolDescription)
        && JSON.stringify(value.tools).length <= 128 * 1024
    case 'tool-call-response':
      if (typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId) || typeof value.ok !== 'boolean') return false
      if (value.ok) {
        return hasExactKeys(value, ['type', 'requestId', 'ok', 'result']) && validJsonValue(value.result)
      }
      return hasExactKeys(value, ['type', 'requestId', 'ok', 'error']) && validError(value.error)
    case 'error':
      return hasExactKeys(value, ['type', 'code', 'message'])
        && typeof value.code === 'string'
        && value.code.length > 0
        && value.code.length <= 80
        && typeof value.message === 'string'
        && value.message.length <= 2_048
    default:
      return false
  }
}
