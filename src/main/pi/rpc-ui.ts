import type { RpcRecord } from './rpc-transport.ts'
import type { Stop } from '../../shared/native-pi.ts'
import { hasExactKeys, isPlainRecord } from '../../shared/ipc-contracts.ts'
import { EXTENSION_UI_IPC, type ExtensionUIEvent, type ExtensionUIPromptRequest, type ExtensionUIReplyRequest } from '../../shared/extension-ui.ts'
import type { AuthorizedIpcCaller, CapabilityDefinition, EventDefinition } from '../ipc/register.ts'

export type RpcUiHost = {
  scope: { processGeneration: number }
  subscribeUi(listener: (record: RpcRecord) => void): Stop
  respondUi(response: RpcRecord & { id: string }): boolean
}

type Dialog = 'select' | 'confirm' | 'input' | 'editor'
type Caller = AuthorizedIpcCaller
type Pending = { host: RpcUiHost; generation: number; method: Dialog; request: ExtensionUIPromptRequest; owner?: Caller; ownerKey?: string }
const DIALOGS = new Set<Dialog>(['select', 'confirm', 'input', 'editor'])
const MAX_TEXT = 100_000
const MAX_OPTIONS = 200
const MAX_KEY = 256
const key = (caller: Caller): string => JSON.stringify([caller.windowId, caller.webContentsId, caller.frameUrl])
const string = (value: unknown, max = MAX_TEXT): value is string => typeof value === 'string' && value.length <= max
const optionalTimeout = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2_147_483_647)
const strings = (value: unknown, maxItems = MAX_OPTIONS): value is string[] => {
  if (!Array.isArray(value) || value.length > maxItems) return false
  let total = 0
  for (const item of value) { if (!string(item) || (total += item.length) > MAX_TEXT) return false }
  return true
}
const optionalKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean => hasExactKeys(value, [...required, ...optional.filter(key => Object.hasOwn(value, key))])

function nativeRequest(value: unknown): boolean {
  if (!isPlainRecord(value) || value.type !== 'extension_ui_request' || !string(value.id, 80) || typeof value.method !== 'string') return false
  if (value.method === 'select') return optionalKeys(value, ['type', 'id', 'method', 'title', 'options'], ['timeout']) && string(value.title, 2_000) && strings(value.options) && optionalTimeout(value.timeout)
  if (value.method === 'confirm') return optionalKeys(value, ['type', 'id', 'method', 'title', 'message'], ['timeout']) && string(value.title, 2_000) && string(value.message) && optionalTimeout(value.timeout)
  if (value.method === 'input') return optionalKeys(value, ['type', 'id', 'method', 'title'], ['placeholder', 'timeout']) && string(value.title, 2_000) && (value.placeholder === undefined || string(value.placeholder)) && optionalTimeout(value.timeout)
  if (value.method === 'editor') return optionalKeys(value, ['type', 'id', 'method', 'title'], ['prefill']) && string(value.title, 2_000) && (value.prefill === undefined || string(value.prefill))
  if (value.method === 'notify') return optionalKeys(value, ['type', 'id', 'method', 'message'], ['notifyType']) && string(value.message) && (value.notifyType === undefined || value.notifyType === 'info' || value.notifyType === 'warning' || value.notifyType === 'error')
  if (value.method === 'setStatus') return optionalKeys(value, ['type', 'id', 'method', 'statusKey'], ['statusText']) && string(value.statusKey, MAX_KEY) && (value.statusText === undefined || string(value.statusText))
  if (value.method === 'setWidget') return optionalKeys(value, ['type', 'id', 'method', 'widgetKey'], ['widgetLines', 'widgetPlacement']) && string(value.widgetKey, MAX_KEY) && (value.widgetLines === undefined || strings(value.widgetLines, 500)) && (value.widgetPlacement === undefined || value.widgetPlacement === 'aboveEditor' || value.widgetPlacement === 'belowEditor')
  if (value.method === 'setTitle') return hasExactKeys(value, ['type', 'id', 'method', 'title']) && string(value.title, 2_000)
  return value.method === 'set_editor_text' && hasExactKeys(value, ['type', 'id', 'method', 'text']) && string(value.text)
}

function prompt(value: RpcRecord): ExtensionUIPromptRequest {
  const base = { type: 'prompt' as const, requestId: value.id as string, kind: value.method as Dialog, title: value.title as string }
  if (value.method === 'select') return { ...base, options: value.options as string[], ...(value.timeout === undefined ? {} : { timeout: value.timeout as number }) } as ExtensionUIPromptRequest
  if (value.method === 'confirm') return { ...base, message: value.message as string, ...(value.timeout === undefined ? {} : { timeout: value.timeout as number }) } as ExtensionUIPromptRequest
  if (value.method === 'input') return { ...base, ...(value.placeholder === undefined ? {} : { placeholder: value.placeholder as string }), ...(value.timeout === undefined ? {} : { timeout: value.timeout as number }) } as ExtensionUIPromptRequest
  return { ...base, ...(value.prefill === undefined ? {} : { prefill: value.prefill as string }) } as ExtensionUIPromptRequest
}

function uiEvent(value: unknown): value is ExtensionUIEvent {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'prompt') {
    if (!string(value.requestId, 80) || !string(value.title, 2_000)) return false
    if (value.kind === 'select') return optionalKeys(value, ['type', 'requestId', 'kind', 'title', 'options'], ['timeout']) && strings(value.options) && optionalTimeout(value.timeout)
    if (value.kind === 'confirm') return optionalKeys(value, ['type', 'requestId', 'kind', 'title', 'message'], ['timeout']) && string(value.message) && optionalTimeout(value.timeout)
    if (value.kind === 'input') return optionalKeys(value, ['type', 'requestId', 'kind', 'title'], ['placeholder', 'timeout']) && (value.placeholder === undefined || string(value.placeholder)) && optionalTimeout(value.timeout)
    return value.kind === 'editor' && optionalKeys(value, ['type', 'requestId', 'kind', 'title'], ['prefill']) && (value.prefill === undefined || string(value.prefill))
  }
  if (value.type === 'prompt-cancelled') return hasExactKeys(value, ['type', 'requestId', 'reason']) && string(value.requestId, 80) && value.reason === 'timeout'
  if (value.type === 'notification') return hasExactKeys(value, ['type', 'message', 'level']) && string(value.message) && ['info', 'warning', 'error'].includes(value.level as string)
  if (value.type === 'status') return hasExactKeys(value, ['type', 'key', 'text']) && string(value.key, MAX_KEY) && (value.text === null || string(value.text))
  if (value.type === 'widget') return hasExactKeys(value, ['type', 'key', 'content', 'placement']) && string(value.key, MAX_KEY) && (value.content === null || strings(value.content, 500)) && (value.placement === 'aboveEditor' || value.placement === 'belowEditor')
  return value.type === 'title' && hasExactKeys(value, ['type', 'title']) && string(value.title, 2_000)
}

function replyRequest(value: unknown): value is ExtensionUIReplyRequest {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['requestId', 'result']) || !string(value.requestId, 80) || !isPlainRecord(value.result)) return false
  const result = value.result
  if (!hasExactKeys(result, ['kind', 'value']) || typeof result.kind !== 'string') return false
  return (result.kind === 'confirm' && typeof result.value === 'boolean') || ((result.kind === 'select' || result.kind === 'input' || result.kind === 'editor') && (result.value === null || string(result.value)))
}

export function createRpcUiBridge(getActiveHost: () => RpcUiHost | null, isCallerActive: (caller: AuthorizedIpcCaller) => boolean): {
  capabilities: readonly CapabilityDefinition<any, any>[]
  events: readonly EventDefinition<any>[]
  disposeCaller(webContentsId: number): void
  dispose(): void
} {
  const pending = new Map<string, Pending>()
  const stops = new Set<Stop>()
  let disposed = false
  const current = (entry: Pending): RpcUiHost | null => {
    const host = getActiveHost()
    return host === entry.host && host.scope.processGeneration === entry.generation ? host : null
  }
  const cancel = (entry: Pending): void => {
    const host = current(entry)
    if (host) host.respondUi({ type: 'extension_ui_response', id: entry.request.requestId, cancelled: true })
  }
  const event: EventDefinition<ExtensionUIEvent> = {
    id: EXTENSION_UI_IPC.event,
    scope: 'runtime',
    validatePayload: uiEvent,
    authorize: caller => !disposed && isCallerActive(caller),
    subscribe: (context, publish) => {
      const host = getActiveHost()
      if (!host || context.scope?.generation !== host.scope.processGeneration || !isCallerActive(context.caller)) throw new Error('Pi RPC UI host is unavailable.')
      let stopped = false
      const onRecord = (record: RpcRecord): void => {
        if (stopped || disposed || getActiveHost() !== host || host.scope.processGeneration !== context.scope?.generation || !isCallerActive(context.caller)) return
        if (isPlainRecord(record) && record.type === 'rpc_ui_timeout') {
          const id = record.id
          if (string(id, 80)) {
            const entry = pending.get(id)
            if (entry && entry.host === host && entry.generation === context.scope?.generation) { pending.delete(id); publish({ type: 'prompt-cancelled', requestId: id, reason: 'timeout' }) }
          }
          return
        }
        if (!nativeRequest(record)) {
          if (isPlainRecord(record) && DIALOGS.has(record.method as Dialog) && string(record.id, 80)) host.respondUi({ type: 'extension_ui_response', id: record.id, cancelled: true })
          publish({ type: 'notification', message: 'A native extension UI request was invalid and was cancelled.', level: 'warning' })
          return
        }
        if (record.method === 'set_editor_text') {
          publish({ type: 'notification', message: 'Native extension editor text synchronization is unavailable in the graphical editor.', level: 'warning' })
          return
        }
        if (!DIALOGS.has(record.method as Dialog)) {
          if (record.method === 'notify') publish({ type: 'notification', message: record.message as string, level: (record.notifyType as 'info' | 'warning' | 'error') ?? 'info' })
          else if (record.method === 'setStatus') publish({ type: 'status', key: record.statusKey as string, text: record.statusText === undefined ? null : record.statusText as string })
          else if (record.method === 'setWidget') publish({ type: 'widget', key: record.widgetKey as string, content: record.widgetLines === undefined ? null : record.widgetLines as string[], placement: (record.widgetPlacement as 'aboveEditor' | 'belowEditor') ?? 'aboveEditor' })
          else if (record.method === 'setTitle') publish({ type: 'title', title: record.title as string })
          return
        }
        let entry = pending.get(record.id as string)
        if (entry && entry.host !== host) return
        if (!entry) {
          entry = { host, generation: host.scope.processGeneration, method: record.method as Dialog, request: prompt(record), owner: context.caller, ownerKey: key(context.caller) }
          pending.set(record.id as string, entry)
        }
        if (entry.owner && entry.ownerKey === key(context.caller)) publish(entry.request)
        else if (!entry.owner && isCallerActive(context.caller)) { entry.owner = context.caller; entry.ownerKey = key(context.caller); publish(entry.request) }
        else publish(entry.request)
      }
      const stopHost = host.subscribeUi(onRecord)
      const stop = () => { if (stopped) return; stopped = true; stops.delete(stop); stopHost() }
      stops.add(stop)
      return stop
    },
  }
  const reply: CapabilityDefinition<ExtensionUIReplyRequest, { accepted: true }> = {
    id: EXTENSION_UI_IPC.reply,
    scope: 'runtime',
    validateRequest: replyRequest,
    validateResponse: (value): value is { accepted: true } => isPlainRecord(value) && hasExactKeys(value, ['accepted']) && value.accepted === true,
    authorize: caller => !disposed && isCallerActive(caller),
    handle: (context, request) => {
      const entry = pending.get(request.requestId)
      const host = entry && current(entry)
      if (!entry || !host || entry.ownerKey !== key(context.caller) || !isCallerActive(context.caller) || context.scope?.generation !== entry.generation || entry.method !== request.result.kind
        || (request.result.kind === 'select' && entry.request.kind === 'select' && request.result.value !== null && !entry.request.options.includes(request.result.value))) throw new Error('The extension UI prompt is no longer active.')
      const result = request.result
      const response = result.kind === 'confirm' ? { type: 'extension_ui_response', id: request.requestId, confirmed: result.value } : result.value === null ? { type: 'extension_ui_response', id: request.requestId, cancelled: true } : { type: 'extension_ui_response', id: request.requestId, value: result.value }
      if (!host.respondUi(response)) throw new Error('The native Pi RPC UI response was not accepted.')
      pending.delete(request.requestId)
      return { accepted: true }
    },
  }
  return {
    capabilities: [reply], events: [event],
    disposeCaller(webContentsId) {
      for (const [id, entry] of pending) if (entry.owner?.webContentsId === webContentsId) { cancel(entry); pending.delete(id) }
    },
    dispose() { if (disposed) return; disposed = true; for (const stop of [...stops]) stop(); for (const entry of pending.values()) cancel(entry); pending.clear() },
  }
}
