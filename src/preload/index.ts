import {
  IPC_CHANNELS,
  isCapabilityId,
  isIpcResult,
  isMatchingEventEnvelope,
  isPlainRecord,
  isRuntimeScope,
  type DesktopBridge,
  type IpcResult,
  type RuntimeScope,
} from '../shared/ipc-contracts.ts'

// Electron's sandboxed preload runner executes a script, not an ESM module. Keep the
// only external dependency on its restricted sandbox require allowlist.
const { contextBridge, ipcRenderer, webUtils } = require('electron') as typeof import('electron')

declare const __APP_NAME__: string
declare const __APP_VERSION__: string

const appInfo = Object.freeze({
  name: __APP_NAME__,
  version: __APP_VERSION__,
})

interface LocalSubscription {
  readonly event: string
  readonly scope?: RuntimeScope
  readonly listener: (payload: unknown) => void
}

const subscriptions = new Map<string, LocalSubscription>()
let nextSubscriptionId = 0

function onHostEvent(_event: Electron.IpcRendererEvent, message: unknown): void {
  if (!isPlainRecord(message) || typeof message.subscriptionId !== 'string') return
  const subscription = subscriptions.get(message.subscriptionId)
  if (!subscription || !isMatchingEventEnvelope(message, {
    event: subscription.event,
    subscriptionId: message.subscriptionId,
    scope: subscription.scope,
  })) return
  try {
    subscription.listener(message.payload)
  } catch {
    // Renderer callbacks are isolated so one listener cannot disrupt the preload bridge.
  }
}

ipcRenderer.on(IPC_CHANNELS.event, onHostEvent)

const invoke: DesktopBridge['invoke'] = async (capability, payload, scope) => {
  if (!isCapabilityId(capability) || (scope !== undefined && !isRuntimeScope(scope))) {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'The IPC request is invalid.' } }
  }
  try {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.invoke, {
      capability,
      payload,
      ...(scope ? { scope } : {}),
    })
    return isIpcResult(result)
      ? result as IpcResult<never>
      : { ok: false, error: { code: 'INTERNAL', message: 'The host could not complete the request.' } }
  } catch {
    return { ok: false, error: { code: 'INTERNAL', message: 'The host could not complete the request.' } }
  }
}

const subscribe: DesktopBridge['subscribe'] = async (event, scope, listener) => {
  if (!isCapabilityId(event) || typeof listener !== 'function'
    || (scope !== undefined && !isRuntimeScope(scope))) {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'The IPC request is invalid.' } }
  }

  const subscriptionId = `${Date.now().toString(36)}-${(++nextSubscriptionId).toString(36)}`
  const local: LocalSubscription = { event, scope, listener: listener as (payload: unknown) => void }
  subscriptions.set(subscriptionId, local)
  let active = true
  const unsubscribe = (): void => {
    if (!active) return
    active = false
    subscriptions.delete(subscriptionId)
    void ipcRenderer.invoke(IPC_CHANNELS.unsubscribe, { subscriptionId }).catch(() => undefined)
  }

  try {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.subscribe, {
      event,
      subscriptionId,
      ...(scope ? { scope } : {}),
    })
    if (!isIpcResult(result)) {
      unsubscribe()
      return { ok: false, error: { code: 'INTERNAL', message: 'The host could not complete the request.' } }
    }
    if (!result.ok) {
      active = false
      subscriptions.delete(subscriptionId)
      return result as IpcResult<never>
    }
    if (!active) return { ok: true, value: () => undefined }
    return { ok: true, value: unsubscribe }
  } catch {
    unsubscribe()
    return { ok: false, error: { code: 'INTERNAL', message: 'The host could not complete the request.' } }
  }
}

window.addEventListener('pagehide', () => {
  ipcRenderer.removeListener(IPC_CHANNELS.event, onHostEvent)
  for (const subscriptionId of subscriptions.keys()) {
    void ipcRenderer.invoke(IPC_CHANNELS.unsubscribe, { subscriptionId }).catch(() => undefined)
  }
  subscriptions.clear()
})

const bridge: DesktopBridge = Object.freeze({
  appInfo,
  invoke,
  subscribe,
  pathForFile: (file: File): string => { try { return webUtils.getPathForFile(file) } catch { return '' } },
})

contextBridge.exposeInMainWorld(
  'piDesktop',
  bridge,
)
