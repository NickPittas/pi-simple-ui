import {
  MCP_APPS_CHANNELS,
  isMcpAppsAppMessage,
  isMcpAppsHostMessage,
  type McpAppsAppMessage,
  type McpAppsBridge,
  type McpAppsHostMessage,
} from '../shared/mcp-apps.ts'
import type * as ElectronModule from 'electron'

// This preload is separate from the desktop preload and exposes no generic IPC operation.
const { contextBridge, ipcRenderer } = require('electron') as typeof ElectronModule

const listeners = new Set<(message: McpAppsHostMessage) => void>()
const pendingMessages: McpAppsHostMessage[] = []
const MAX_PENDING_MESSAGES = 32

function receiveHostMessage(_event: Electron.IpcRendererEvent, value: unknown): void {
  if (!isMcpAppsHostMessage(value)) return
  if (listeners.size === 0) {
    if (pendingMessages.length === MAX_PENDING_MESSAGES) pendingMessages.shift()
    pendingMessages.push(value)
    return
  }
  for (const listener of listeners) {
    try {
      listener(value)
    } catch {
      // One app listener cannot prevent delivery to the others.
    }
  }
}

ipcRenderer.on(MCP_APPS_CHANNELS.fromHost, receiveHostMessage)

const bridge: McpAppsBridge = Object.freeze({
  postMessage(message: McpAppsAppMessage): boolean {
    if (!isMcpAppsAppMessage(message)) return false
    ipcRenderer.send(MCP_APPS_CHANNELS.toHost, message)
    return true
  },
  onMessage(listener: (message: McpAppsHostMessage) => void): () => void {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    if (pendingMessages.length > 0) {
      const queued = pendingMessages.splice(0, pendingMessages.length)
      for (const message of queued) {
        try {
          listener(message)
        } catch {
          // App callbacks are isolated from the preload bridge.
        }
      }
    }
    return () => listeners.delete(listener)
  },
})

contextBridge.exposeInMainWorld('mcpApps', bridge)
