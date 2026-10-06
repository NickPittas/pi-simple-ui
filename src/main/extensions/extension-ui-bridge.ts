import { randomUUID } from 'node:crypto'
import type { AgentSession, ExtensionUIContext, ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent'
import type { AuthorizedIpcCaller, CapabilityDefinition, EventDefinition } from '../ipc/register.ts'
import { createDefaultSemanticViewAdapterRegistry } from './adapters/registry.ts'
import { CustomViewHost } from './custom-view-host.ts'
import { NativeCustomUIHost, type NativeCustomUIConfiguration } from './native-custom-ui/native-custom-ui-host.ts'
import {
  hasExactKeys,
  isPlainRecord,
  isRuntimeScope,
  type RuntimeScope,
} from '../../shared/ipc-contracts.ts'
import {
  EXTENSION_UI_IPC,
  type ExtensionUIEvent,
  type SemanticViewActionAck,
  type SemanticViewActionRequest,
  type ExtensionUIReplyAck,
  type ExtensionUIReplyRequest,
  type NativeCustomUIActionAck,
  type NativeCustomUIActionRequest,
  type NativeCustomUIEvent,
  type ExtensionUIStateUpdateAck,
  type ExtensionUIStateUpdateRequest,
  type ExtensionUIPromptRequest,
  type ExtensionUIPromptResult,
  type ExtensionUIUnsupportedOperation,
  NATIVE_CUSTOM_UI_CAPABILITIES,
  NATIVE_CUSTOM_UI_FIRST_ACTION_SEQUENCE,
  NATIVE_CUSTOM_UI_LIMITS,
  MAX_EXTENSION_SECRET_INPUT_LENGTH,
} from '../../shared/extension-ui.ts'

const MAX_TEXT_LENGTH = 100_000
const MAX_SESSION_ID_LENGTH = 256
const MAX_OPTIONS = 200
const MAX_TIMER_DELAY = 2_147_483_647
const MAX_CACHED_UI_STATE = 512
const MAX_CACHED_TRANSIENT_EVENTS = 128
const MAX_PENDING_PROMPTS = 64

type Bindings = Pick<Parameters<AgentSession['bindExtensions']>[0], 'mode' | 'uiContext'>
type PromptCancelReason = 'aborted' | 'timeout' | 'session-disposed' | 'renderer-disconnected'
type AppExtensionUIContext = ExtensionUIContext & {
  inputSecret(title: string, placeholder?: string, options?: ExtensionUIDialogOptions): Promise<string | undefined>
}

interface ActiveRenderer {
  readonly caller: AuthorizedIpcCaller
  readonly publish: (event: ExtensionUIEvent) => void
}

interface PendingPrompt {
  readonly request: ExtensionUIPromptRequest
  readonly sessionId: string | undefined
  readonly uiGeneration: number
  caller?: AuthorizedIpcCaller
  readonly resolve: (result: ExtensionUIPromptResult | undefined) => void
  timer?: NodeJS.Timeout
  replyTimer?: NodeJS.Timeout
  readonly deadline?: number
  readonly signal?: AbortSignal
  onAbort?: () => void
}

interface ReplyOperationAuthorization {
  readonly caller: AuthorizedIpcCaller
  readonly sessionId: string | undefined
  readonly uiGeneration: number
  handled: boolean
}

interface MirroredEditorState {
  readonly sessionId: string
  readonly sequence: number
  readonly text: string
  readonly selectionStart: number
  readonly selectionEnd: number
}

interface MirroredToolsExpandedState {
  readonly sessionId: string
  readonly sequence: number
  readonly expanded: boolean
}

function isString(value: unknown, maxLength = MAX_TEXT_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function isSessionId(value: unknown): value is string {
  return isString(value, MAX_SESSION_ID_LENGTH) && value.trim().length > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isOptionalTimeout(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isStringArray(value: unknown, maxItems = MAX_OPTIONS): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false
  let totalLength = 0
  for (const item of value) {
    if (!isString(item)) return false
    totalLength += item.length
    if (totalLength > MAX_TEXT_LENGTH) return false
  }
  return true
}

function isPromptRequest(value: unknown): value is ExtensionUIPromptRequest {
  if (!isPlainRecord(value) || value.type !== 'prompt' || !isString(value.requestId, 80)) return false
  if (value.kind === 'select') {
    const keys = Object.hasOwn(value, 'timeout')
      ? ['type', 'requestId', 'kind', 'title', 'options', 'timeout']
      : ['type', 'requestId', 'kind', 'title', 'options']
    return hasExactKeys(value, keys)
      && isString(value.title, 2_000)
      && isStringArray(value.options)
      && isOptionalTimeout(value.timeout)
  }
  if (value.kind === 'confirm') {
    const keys = Object.hasOwn(value, 'timeout')
      ? ['type', 'requestId', 'kind', 'title', 'message', 'timeout']
      : ['type', 'requestId', 'kind', 'title', 'message']
    return hasExactKeys(value, keys)
      && isString(value.title, 2_000)
      && isString(value.message)
      && isOptionalTimeout(value.timeout)
  }
  if (value.kind === 'input') {
    const keys = [
      'type', 'requestId', 'kind', 'title',
      ...(Object.hasOwn(value, 'placeholder') ? ['placeholder'] : []),
      ...(Object.hasOwn(value, 'timeout') ? ['timeout'] : []),
    ]
    return hasExactKeys(value, keys)
      && isString(value.title, 2_000)
      && (value.placeholder === undefined || isString(value.placeholder))
      && isOptionalTimeout(value.timeout)
  }
  if (value.kind === 'secret-input') {
    const keys = [
      'type', 'requestId', 'kind', 'sessionId', 'title',
      ...(Object.hasOwn(value, 'placeholder') ? ['placeholder'] : []),
      ...(Object.hasOwn(value, 'timeout') ? ['timeout'] : []),
    ]
    return hasExactKeys(value, keys)
      && isSessionId(value.sessionId)
      && isString(value.title, 2_000)
      && (value.placeholder === undefined || isString(value.placeholder))
      && isOptionalTimeout(value.timeout)
  }
  if (value.kind === 'editor') {
    const keys = Object.hasOwn(value, 'prefill')
      ? ['type', 'requestId', 'kind', 'title', 'prefill']
      : ['type', 'requestId', 'kind', 'title']
    return hasExactKeys(value, keys)
      && isString(value.title, 2_000)
      && (value.prefill === undefined || isString(value.prefill))
  }
  return false
}

function isPromptResult(value: unknown): value is ExtensionUIPromptResult {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'secret-input') {
    return hasExactKeys(value, ['kind', 'value'])
      && (value.value === null || isString(value.value, MAX_EXTENSION_SECRET_INPUT_LENGTH))
  }
  if (value.kind === 'select' || value.kind === 'input' || value.kind === 'editor') {
    return hasExactKeys(value, ['kind', 'value']) && (value.value === null || isString(value.value))
  }
  if (value.kind === 'confirm') {
    return hasExactKeys(value, ['kind', 'value']) && typeof value.value === 'boolean'
  }
  return false
}

function isReplyRequest(value: unknown): value is ExtensionUIReplyRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['requestId', 'result'])
    && isString(value.requestId, 80)
    && isPromptResult(value.result)
}

function isReplyAck(value: unknown): value is ExtensionUIReplyAck {
  return isPlainRecord(value) && hasExactKeys(value, ['accepted']) && value.accepted === true
}

function isStateUpdateRequest(value: unknown): value is ExtensionUIStateUpdateRequest {
  if (!isPlainRecord(value) || !isSessionId(value.sessionId)
    || !isNonNegativeSafeInteger(value.baseRevision)
    || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return false
  if (value.kind === 'editor') {
    return hasExactKeys(value, [
      'kind', 'sessionId', 'baseRevision', 'sequence', 'text', 'selectionStart', 'selectionEnd',
    ])
      && isString(value.text)
      && Number.isSafeInteger(value.selectionStart)
      && (value.selectionStart as number) >= 0
      && (value.selectionStart as number) <= value.text.length
      && Number.isSafeInteger(value.selectionEnd)
      && (value.selectionEnd as number) >= (value.selectionStart as number)
      && (value.selectionEnd as number) <= value.text.length
  }
  return value.kind === 'tools-expanded'
    && hasExactKeys(value, ['kind', 'sessionId', 'baseRevision', 'sequence', 'expanded'])
    && typeof value.expanded === 'boolean'
}

function isStateUpdateAck(value: unknown): value is ExtensionUIStateUpdateAck {
  if (!isPlainRecord(value) || (value.kind !== 'editor' && value.kind !== 'tools-expanded')
    || !isNonNegativeSafeInteger(value.revision)
    || !isNonNegativeSafeInteger(value.sequence)) return false
  if (value.accepted === true) return hasExactKeys(value, ['kind', 'accepted', 'revision', 'sequence'])
  return value.accepted === false
    && hasExactKeys(value, ['kind', 'accepted', 'revision', 'sequence', 'reason'])
    && (value.reason === 'session-unbound'
      || value.reason === 'session-mismatch'
      || value.reason === 'stale-revision'
      || value.reason === 'stale-sequence')
}

function isSemanticViewActionRequest(value: unknown): value is SemanticViewActionRequest {
  return isPlainRecord(value)
    && hasExactKeys(value, ['instanceId', 'revision', 'action'])
    && isString(value.instanceId, 80)
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) >= 1
    && isPlainRecord(value.action)
    && typeof value.action.type === 'string'
    && value.action.type.length > 0
}

function isSemanticViewActionAck(value: unknown): value is SemanticViewActionAck {
  if (!isPlainRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return false
  if (value.accepted === true) return hasExactKeys(value, ['accepted', 'revision'])
  return value.accepted === false
    && hasExactKeys(value, ['accepted', 'revision', 'reason'])
    && (value.reason === 'closed'
      || value.reason === 'stale-revision'
      || value.reason === 'unsupported-action'
      || value.reason === 'view-failed')
}

function isNativeCustomUIActionRequest(value: unknown): value is NativeCustomUIActionRequest {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['viewId', 'sessionId', 'sequence', 'action'])
    || !isString(value.viewId, 80)
    || !isSessionId(value.sessionId)
    || !Number.isSafeInteger(value.sequence)
    || (value.sequence as number) < 1
    || !isPlainRecord(value.action)
    || typeof value.action.type !== 'string') return false
  if (value.action.type === 'input') {
    return hasExactKeys(value.action, ['type', 'data']) && isString(value.action.data)
  }
  if (value.action.type === 'resize') {
    return hasExactKeys(value.action, ['type', 'columns', 'rows'])
      && Number.isSafeInteger(value.action.columns)
      && (value.action.columns as number) >= NATIVE_CUSTOM_UI_LIMITS.minColumns
      && (value.action.columns as number) <= NATIVE_CUSTOM_UI_LIMITS.maxColumns
      && Number.isSafeInteger(value.action.rows)
      && (value.action.rows as number) >= NATIVE_CUSTOM_UI_LIMITS.minRows
      && (value.action.rows as number) <= NATIVE_CUSTOM_UI_LIMITS.maxRows
  }
  return value.action.type === 'render' && hasExactKeys(value.action, ['type'])
}

function isNativeCustomUIActionAck(value: unknown): value is NativeCustomUIActionAck {
  if (!isPlainRecord(value)) return false
  if (value.accepted === true) {
    return hasExactKeys(value, ['accepted', 'sequence']) && isNonNegativeSafeInteger(value.sequence)
  }
  return value.accepted === false
    && hasExactKeys(value, ['accepted', 'expectedSequence', 'reason'])
    && isNonNegativeSafeInteger(value.expectedSequence)
    && (value.reason === 'closed'
      || value.reason === 'stale-sequence'
      || value.reason === 'input-too-large'
      || value.reason === 'not-ready'
      || value.reason === 'not-focused'
      || value.reason === 'view-failed')
}

function isNativeCustomUIEvent(value: unknown): value is NativeCustomUIEvent {
  if (!isPlainRecord(value)) return false
  if (value.type === 'native-custom-ready') {
    return hasExactKeys(value, [
      'type', 'viewId', 'sessionId', 'parentViewId', 'visible', 'focused', 'capturesInput',
    ])
      && isString(value.viewId, 80)
      && isSessionId(value.sessionId)
      && (value.parentViewId === null || isString(value.parentViewId, 80))
      && typeof value.visible === 'boolean'
      && typeof value.focused === 'boolean'
      && typeof value.capturesInput === 'boolean'
      && value.focused === value.capturesInput
  }
  if (value.type === 'native-custom-focus') {
    return hasExactKeys(value, ['type', 'viewId', 'sessionId', 'visible', 'focused', 'capturesInput'])
      && isString(value.viewId, 80)
      && isSessionId(value.sessionId)
      && typeof value.visible === 'boolean'
      && typeof value.focused === 'boolean'
      && typeof value.capturesInput === 'boolean'
      && value.focused === value.capturesInput
  }
  if (value.type === 'native-custom-opened') {
    return hasExactKeys(value, [
      'type', 'viewId', 'sessionId', 'parentViewId', 'columns', 'rows', 'firstActionSequence', 'capabilities',
    ])
      && isString(value.viewId, 80)
      && isSessionId(value.sessionId)
      && (value.parentViewId === null || isString(value.parentViewId, 80))
      && Number.isSafeInteger(value.columns)
      && (value.columns as number) >= NATIVE_CUSTOM_UI_LIMITS.minColumns
      && (value.columns as number) <= NATIVE_CUSTOM_UI_LIMITS.maxColumns
      && Number.isSafeInteger(value.rows)
      && (value.rows as number) >= NATIVE_CUSTOM_UI_LIMITS.minRows
      && (value.rows as number) <= NATIVE_CUSTOM_UI_LIMITS.maxRows
      && value.firstActionSequence === NATIVE_CUSTOM_UI_FIRST_ACTION_SEQUENCE
      && isPlainRecord(value.capabilities)
      && hasExactKeys(value.capabilities, [
        'ansi', 'trueColor', 'hyperlinks', 'images', 'mouse', 'kittyKeyboard',
      ])
      && value.capabilities.ansi === NATIVE_CUSTOM_UI_CAPABILITIES.ansi
      && value.capabilities.trueColor === NATIVE_CUSTOM_UI_CAPABILITIES.trueColor
      && value.capabilities.hyperlinks === NATIVE_CUSTOM_UI_CAPABILITIES.hyperlinks
      && value.capabilities.images === NATIVE_CUSTOM_UI_CAPABILITIES.images
      && value.capabilities.mouse === NATIVE_CUSTOM_UI_CAPABILITIES.mouse
      && value.capabilities.kittyKeyboard === NATIVE_CUSTOM_UI_CAPABILITIES.kittyKeyboard
  }
  if (value.type === 'native-custom-output') {
    return hasExactKeys(value, ['type', 'viewId', 'sessionId', 'sequence', 'data'])
      && isString(value.viewId, 80)
      && isSessionId(value.sessionId)
      && Number.isSafeInteger(value.sequence)
      && (value.sequence as number) >= 1
      && isString(value.data, NATIVE_CUSTOM_UI_LIMITS.maxOutputChunkBytes)
      && Buffer.byteLength(value.data, 'utf8') <= NATIVE_CUSTOM_UI_LIMITS.maxOutputChunkBytes
  }
  if (value.type === 'native-custom-closed') {
    if (!isString(value.viewId, 80)
      || !isSessionId(value.sessionId)
      || (value.parentViewId !== null && !isString(value.parentViewId, 80))) return false
    if (value.reason === 'failed') {
      return hasExactKeys(value, ['type', 'viewId', 'sessionId', 'parentViewId', 'reason', 'error'])
        && value.error === 'factory-or-input-failed'
    }
    if (value.reason === 'output-overflow') {
      return hasExactKeys(value, ['type', 'viewId', 'sessionId', 'parentViewId', 'reason', 'error'])
        && value.error === 'output-overflow'
    }
    return hasExactKeys(value, ['type', 'viewId', 'sessionId', 'parentViewId', 'reason'])
      && (value.reason === 'completed' || value.reason === 'cancelled')
  }
  return false
}

function isUnsupportedOperation(value: unknown): value is ExtensionUIUnsupportedOperation {
  return value === 'onTerminalInput'
    || value === 'custom'
    || value === 'setWidget'
    || value === 'setFooter'
    || value === 'setHeader'
    || value === 'pasteToEditor'
    || value === 'addAutocompleteProvider'
    || value === 'setEditorComponent'
    || value === 'getEditorComponent'
    || value === 'theme'
    || value === 'getAllThemes'
    || value === 'getTheme'
    || value === 'setTheme'
}

function isExtensionUIEvent(value: unknown): value is ExtensionUIEvent {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'prompt') return isPromptRequest(value)
  if (value.type === 'native-custom-opened'
    || value.type === 'native-custom-output'
    || value.type === 'native-custom-ready'
    || value.type === 'native-custom-focus'
    || value.type === 'native-custom-closed') return isNativeCustomUIEvent(value)
  if (value.type === 'prompt-cancelled') {
    return hasExactKeys(value, ['type', 'requestId', 'reason'])
      && isString(value.requestId, 80)
      && (value.reason === 'aborted'
        || value.reason === 'timeout'
        || value.reason === 'session-disposed'
        || value.reason === 'renderer-disconnected')
  }
  if (value.type === 'notification') {
    return hasExactKeys(value, ['type', 'message', 'level'])
      && isString(value.message)
      && (value.level === 'info' || value.level === 'warning' || value.level === 'error')
  }
  if (value.type === 'status') {
    return hasExactKeys(value, ['type', 'key', 'text']) && isString(value.key, 256)
      && (value.text === null || isString(value.text))
  }
  if (value.type === 'widget') {
    return hasExactKeys(value, ['type', 'key', 'content', 'placement'])
      && isString(value.key, 256)
      && (value.content === null || isStringArray(value.content, 500))
      && (value.placement === 'aboveEditor' || value.placement === 'belowEditor')
  }
  if (value.type === 'title') {
    return hasExactKeys(value, ['type', 'title']) && isString(value.title, 2_000)
  }
  if (value.type === 'working-message') {
    return hasExactKeys(value, ['type', 'message']) && (value.message === null || isString(value.message))
  }
  if (value.type === 'working-visible') {
    return hasExactKeys(value, ['type', 'visible']) && typeof value.visible === 'boolean'
  }
  if (value.type === 'working-indicator') {
    if (!hasExactKeys(value, ['type', 'options'])) return false
    if (value.options === null) return true
    if (!isPlainRecord(value.options)) return false
    const hasFrames = Object.hasOwn(value.options, 'frames')
    const hasInterval = Object.hasOwn(value.options, 'intervalMs')
    if (!hasExactKeys(value.options, [
      ...(hasFrames ? ['frames'] : []),
      ...(hasInterval ? ['intervalMs'] : []),
    ])) return false
    return (!hasFrames || isStringArray(value.options.frames, 500))
      && (!hasInterval || (typeof value.options.intervalMs === 'number' && Number.isFinite(value.options.intervalMs)))
  }
  if (value.type === 'hidden-thinking-label') {
    return hasExactKeys(value, ['type', 'label']) && (value.label === null || isString(value.label))
  }
  if (value.type === 'session-binding') {
    return hasExactKeys(value, ['type', 'sessionId', 'editorRevision', 'toolsExpandedRevision'])
      && (value.sessionId === null || isSessionId(value.sessionId))
      && isNonNegativeSafeInteger(value.editorRevision)
      && isNonNegativeSafeInteger(value.toolsExpandedRevision)
  }
  if (value.type === 'editor-text-set') {
    return hasExactKeys(value, [
      'type', 'sessionId', 'expectedRevision', 'revision', 'expectedSequence',
      'text', 'selectionStart', 'selectionEnd',
    ])
      && isSessionId(value.sessionId)
      && isNonNegativeSafeInteger(value.expectedRevision)
      && isNonNegativeSafeInteger(value.revision)
      && value.revision === value.expectedRevision + 1
      && isNonNegativeSafeInteger(value.expectedSequence)
      && isString(value.text)
      && Number.isSafeInteger(value.selectionStart)
      && (value.selectionStart as number) >= 0
      && (value.selectionStart as number) <= value.text.length
      && Number.isSafeInteger(value.selectionEnd)
      && (value.selectionEnd as number) >= (value.selectionStart as number)
      && (value.selectionEnd as number) <= value.text.length
  }
  if (value.type === 'tools-expanded-set') {
    return hasExactKeys(value, [
      'type', 'sessionId', 'expectedRevision', 'revision', 'expectedSequence', 'expanded',
    ])
      && isSessionId(value.sessionId)
      && isNonNegativeSafeInteger(value.expectedRevision)
      && isNonNegativeSafeInteger(value.revision)
      && value.revision === value.expectedRevision + 1
      && isNonNegativeSafeInteger(value.expectedSequence)
      && typeof value.expanded === 'boolean'
  }
  if (value.type === 'unsupported') {
    return hasExactKeys(value, ['type', 'operation']) && isUnsupportedOperation(value.operation)
  }
  if (value.type === 'semantic-view') {
    if (!hasExactKeys(value, ['type', 'instanceId', 'viewId', 'version', 'revision', 'state'])
      || !isString(value.instanceId, 80)
      || !isString(value.viewId, 256)
      || !Number.isSafeInteger(value.version)
      || (value.version as number) < 1
      || !Number.isSafeInteger(value.revision)
      || (value.revision as number) < 1) return false
    try {
      const serialized = JSON.stringify(value.state)
      return serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= 64 * 1024
    } catch {
      return false
    }
  }
  if (value.type === 'semantic-view-closed') {
    return hasExactKeys(value, ['type', 'instanceId', 'revision', 'reason'])
      && isString(value.instanceId, 80)
      && Number.isSafeInteger(value.revision)
      && (value.revision as number) >= 0
      && (value.reason === 'completed' || value.reason === 'cancelled' || value.reason === 'failed')
  }
  return false
}

function sameScope(left: RuntimeScope | undefined, right: RuntimeScope): boolean {
  return left?.ownerId === right.ownerId && left.generation === right.generation
}

function sameCaller(left: AuthorizedIpcCaller, right: AuthorizedIpcCaller): boolean {
  return left.windowId === right.windowId
    && left.webContentsId === right.webContentsId
    && left.frameUrl === right.frameUrl
}

function replyMatches(request: ExtensionUIPromptRequest, result: ExtensionUIPromptResult): boolean {
  if (result.kind === 'select') {
    return request.kind === 'select'
      && (result.value === null || request.options.includes(result.value))
  }
  return request.kind === result.kind
}

class ExtensionCustomViewHost extends CustomViewHost {
  readonly nativeCustomUIHost: NativeCustomUIHost

  constructor(options: {
    readonly scope: RuntimeScope
    readonly registry: ReturnType<typeof createDefaultSemanticViewAdapterRegistry>
    readonly publish: (event: ExtensionUIEvent) => void
  }) {
    super(options)
    this.nativeCustomUIHost = new NativeCustomUIHost({
      scope: options.scope,
      publish: options.publish,
    })
  }

  configureNativeRuntime(runtime: object): void {
    super.configureNativeRuntime(runtime)
    this.nativeCustomUIHost.configureNativeRuntime(runtime)
  }

  configureNativeUI(configuration: NativeCustomUIConfiguration): void {
    this.nativeCustomUIHost.configureNativeUI(configuration)
  }

  setActiveSession(sessionId: string | undefined): void {
    this.nativeCustomUIHost.setActiveSession(sessionId)
  }

  invalidateNativeUi(): void {
    this.nativeCustomUIHost.invalidateNativeUi()
  }

  override bindRenderer(caller: AuthorizedIpcCaller): void {
    super.bindRenderer(caller)
    this.nativeCustomUIHost.bindRenderer(caller)
  }

  override rendererDisconnected(caller: AuthorizedIpcCaller): void {
    super.rendererDisconnected(caller)
    this.nativeCustomUIHost.rendererDisconnected(caller)
  }

  override dispose(): void {
    this.nativeCustomUIHost.dispose()
    super.dispose()
  }
}

/**
 * Build descriptors for the existing IPC registry plus the native Pi binding.
 * A bridge instance belongs to one runtime generation and one renderer subscription;
 * dispose it with that host to cancel every outstanding native extension wait.
 */
export function createExtensionUIBridge(scope: RuntimeScope): {
  readonly scope: RuntimeScope
  readonly mode: 'rpc'
  readonly uiContext: AppExtensionUIContext
  readonly extensionBindings: Bindings
  readonly capabilities: readonly (CapabilityDefinition<ExtensionUIReplyRequest, ExtensionUIReplyAck>
    | CapabilityDefinition<SemanticViewActionRequest, SemanticViewActionAck>
    | CapabilityDefinition<NativeCustomUIActionRequest, NativeCustomUIActionAck>
    | CapabilityDefinition<ExtensionUIStateUpdateRequest, ExtensionUIStateUpdateAck>)[]
  readonly events: readonly EventDefinition<ExtensionUIEvent>[]
  readonly customViewHost: ExtensionCustomViewHost
  setActiveSession(sessionId: string | undefined): void
  invalidateNativeUi(): void
  dispose(): void
} {
  if (!isRuntimeScope(scope)) throw new TypeError('A valid runtime scope is required for the extension UI bridge.')
  const boundScope = Object.freeze({ ownerId: scope.ownerId, generation: scope.generation })
  let renderer: ActiveRenderer | undefined
  let disposed = false
  let terminalInputUnsupportedReported = false
  let terminalInputUnsupportedPending = false
  const pending = new Map<string, PendingPrompt>()
  const replyOperationAuthorizations = new WeakMap<ExtensionUIReplyRequest, ReplyOperationAuthorization>()
  const latestState = new Map<string, ExtensionUIEvent>()
  const transientEvents: ExtensionUIEvent[] = []
  let activeSessionId: string | undefined
  let nativeUiGeneration = 0
  let editorRevision = 0
  let toolsExpandedRevision = 0
  let mirroredEditor: MirroredEditorState | undefined
  let mirroredToolsExpanded: MirroredToolsExpandedState | undefined
  const customViewHost = new ExtensionCustomViewHost({
    scope: boundScope,
    registry: createDefaultSemanticViewAdapterRegistry(),
    publish: (event) => publish(event),
  })

  const advanceNativeUiGeneration = (): void => {
    nativeUiGeneration = nativeUiGeneration >= Number.MAX_SAFE_INTEGER ? 1 : nativeUiGeneration + 1
  }

  const promptIsCurrent = (prompt: PendingPrompt): boolean => !disposed
    && prompt.uiGeneration === nativeUiGeneration
    && prompt.sessionId === activeSessionId
    && !!prompt.caller
    && !!renderer
    && sameCaller(renderer.caller, prompt.caller)

  const publish = (event: ExtensionUIEvent): void => {
    if (disposed) return
    if (!isExtensionUIEvent(event)) throw new TypeError('The extension UI event exceeds the supported IPC contract.')
    if (renderer) {
      renderer.publish(event)
      return
    }
    if (event.type === 'notification' || event.type === 'unsupported') {
      if (transientEvents.length >= MAX_CACHED_TRANSIENT_EVENTS) {
        throw new RangeError('The extension UI transient event limit was reached.')
      }
      transientEvents.push(event)
    }
  }

  const settle = (
    requestId: string,
    result: ExtensionUIPromptResult | undefined,
    reason?: PromptCancelReason,
  ): void => {
    const active = pending.get(requestId)
    if (!active) return
    pending.delete(requestId)
    if (active.timer) clearTimeout(active.timer)
    if (active.replyTimer) clearTimeout(active.replyTimer)
    if (active.signal && active.onAbort) active.signal.removeEventListener('abort', active.onAbort)
    if (reason) {
      if (renderer && active.caller && sameCaller(renderer.caller, active.caller)) {
        publish({ type: 'prompt-cancelled', requestId, reason })
      }
    }
    active.resolve(result)
  }

  const cancelOwned = (reason: 'session-disposed' | 'renderer-disconnected'): void => {
    for (const id of pending.keys()) settle(id, undefined, reason)
  }

  const requestPrompt = <T>(
    request: ExtensionUIPromptRequest,
    options: ExtensionUIDialogOptions | undefined,
    fallback: T,
    decode: (result: ExtensionUIPromptResult | undefined) => T,
  ): Promise<T> => {
    if (disposed) return Promise.resolve(fallback)
    if (!isPromptRequest(request)) return Promise.reject(new TypeError('The extension UI prompt exceeds the supported IPC contract.'))
    if (request.kind === 'secret-input'
      && (!renderer || request.sessionId !== activeSessionId)) return Promise.resolve(fallback)
    const owner = renderer
    if (options?.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0)) {
      return Promise.reject(new TypeError('Extension UI timeout must be a non-negative finite number.'))
    }
    if (options?.signal?.aborted) return Promise.resolve(fallback)
    if (pending.size >= MAX_PENDING_PROMPTS) {
      return Promise.reject(new RangeError('The extension UI pending prompt limit was reached.'))
    }

    const signal = options?.signal
    const timeout = options?.timeout
    return new Promise<T>((resolve) => {
      const pendingPrompt: PendingPrompt = {
        request,
        sessionId: activeSessionId,
        uiGeneration: nativeUiGeneration,
        ...(owner ? { caller: owner.caller } : {}),
        ...(timeout && timeout > 0 ? { deadline: Date.now() + timeout } : {}),
        ...(signal ? { signal } : {}),
        resolve: (result) => resolve(decode(result)),
      }
      pending.set(request.requestId, pendingPrompt)

      if (signal) {
        const onAbort = (): void => settle(request.requestId, undefined, 'aborted')
        pendingPrompt.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) {
          onAbort()
          return
        }
      }

      if (pendingPrompt.deadline !== undefined) {
        const armTimeout = (): void => {
          const remaining = pendingPrompt.deadline! - Date.now()
          if (remaining <= 0) {
            settle(request.requestId, undefined, 'timeout')
            return
          }
          pendingPrompt.timer = setTimeout(armTimeout, Math.min(remaining, MAX_TIMER_DELAY))
        }
        armTimeout()
      }
      if (pending.has(request.requestId) && owner) owner.publish(request)
    })
  }

  const emitPersistent = (key: string, event: ExtensionUIEvent): void => {
    if (disposed) return
    if (!isExtensionUIEvent(event)) throw new TypeError('The extension UI event exceeds the supported IPC contract.')
    if (!latestState.has(key) && latestState.size >= MAX_CACHED_UI_STATE) {
      throw new RangeError('The extension UI state limit was reached.')
    }
    latestState.set(key, event)
    publish(event)
  }

  const sessionBindingEvent = (): ExtensionUIEvent => ({
    type: 'session-binding',
    sessionId: activeSessionId ?? null,
    editorRevision,
    toolsExpandedRevision,
  })

  const rememberSessionBinding = (event: ExtensionUIEvent): void => {
    if (!latestState.has('session-binding') && latestState.size >= MAX_CACHED_UI_STATE) {
      const oldestKey = [...latestState.keys()].find((key) => key !== 'session-binding')
      if (oldestKey !== undefined) latestState.delete(oldestKey)
    }
    latestState.set('session-binding', event)
  }

  const publishSessionBinding = (): void => {
    const event = sessionBindingEvent()
    rememberSessionBinding(event)
    publish(event)
  }

  const requireActiveSession = (): string => {
    if (disposed) throw new Error('The extension UI host has been disposed.')
    if (!activeSessionId) throw new Error('The extension UI session is not bound to an active session.')
    if (!renderer) throw new Error('The extension UI renderer is not connected.')
    return activeSessionId
  }

  const incrementRevision = (revision: number): number => {
    if (revision >= Number.MAX_SAFE_INTEGER) throw new RangeError('The extension UI state revision limit was reached.')
    return revision + 1
  }

  const mirrorEditorState = (request: Extract<ExtensionUIStateUpdateRequest, { readonly kind: 'editor' }>): ExtensionUIStateUpdateAck => {
    if (!activeSessionId) {
      return {
        kind: request.kind,
        accepted: false,
        revision: editorRevision,
        sequence: mirroredEditor?.sequence ?? 0,
        reason: 'session-unbound',
      }
    }
    if (request.sessionId !== activeSessionId) {
      return {
        kind: request.kind,
        accepted: false,
        revision: editorRevision,
        sequence: mirroredEditor?.sequence ?? 0,
        reason: 'session-mismatch',
      }
    }
    const lastSequence = mirroredEditor?.sequence ?? 0
    if (request.baseRevision !== editorRevision) {
      return {
        kind: request.kind,
        accepted: false,
        revision: editorRevision,
        sequence: lastSequence,
        reason: 'stale-revision',
      }
    }
    if (request.sequence <= lastSequence) {
      return {
        kind: request.kind,
        accepted: false,
        revision: editorRevision,
        sequence: lastSequence,
        reason: 'stale-sequence',
      }
    }
    mirroredEditor = {
      sessionId: activeSessionId,
      sequence: request.sequence,
      text: request.text,
      selectionStart: request.selectionStart,
      selectionEnd: request.selectionEnd,
    }
    return { kind: request.kind, accepted: true, revision: editorRevision, sequence: request.sequence }
  }

  const mirrorToolsExpandedState = (
    request: Extract<ExtensionUIStateUpdateRequest, { readonly kind: 'tools-expanded' }>,
  ): ExtensionUIStateUpdateAck => {
    if (!activeSessionId) {
      return {
        kind: request.kind,
        accepted: false,
        revision: toolsExpandedRevision,
        sequence: mirroredToolsExpanded?.sequence ?? 0,
        reason: 'session-unbound',
      }
    }
    if (request.sessionId !== activeSessionId) {
      return {
        kind: request.kind,
        accepted: false,
        revision: toolsExpandedRevision,
        sequence: mirroredToolsExpanded?.sequence ?? 0,
        reason: 'session-mismatch',
      }
    }
    const lastSequence = mirroredToolsExpanded?.sequence ?? 0
    if (request.baseRevision !== toolsExpandedRevision) {
      return {
        kind: request.kind,
        accepted: false,
        revision: toolsExpandedRevision,
        sequence: lastSequence,
        reason: 'stale-revision',
      }
    }
    if (request.sequence <= lastSequence) {
      return {
        kind: request.kind,
        accepted: false,
        revision: toolsExpandedRevision,
        sequence: lastSequence,
        reason: 'stale-sequence',
      }
    }
    mirroredToolsExpanded = {
      sessionId: activeSessionId,
      sequence: request.sequence,
      expanded: request.expanded,
    }
    return { kind: request.kind, accepted: true, revision: toolsExpandedRevision, sequence: request.sequence }
  }

  const unsupported = (operation: ExtensionUIUnsupportedOperation): never => {
    publish({ type: 'unsupported', operation })
    throw new Error(`Extension UI operation "${operation}" requires a native terminal or semantic custom-view adapter.`)
  }
  const unsupportedTheme = new Proxy(Object.create(null) as ExtensionUIContext['theme'], {
    get: () => unsupported('theme'),
  })
  const custom: ExtensionUIContext['custom'] = async (factory, options) => {
    return customViewHost.nativeCustomUIHost.open(factory, options)
  }

  const uiContext: AppExtensionUIContext = {
    supportsSemanticView: (handle) => customViewHost.supports(handle),
    select: (title, options, dialogOptions) => {
      const request: ExtensionUIPromptRequest = {
        type: 'prompt', requestId: randomUUID(), kind: 'select', title, options: [...options],
        ...(dialogOptions?.timeout !== undefined ? { timeout: dialogOptions.timeout } : {}),
      }
      return requestPrompt(request, dialogOptions, undefined, (result) =>
        result?.kind === 'select' ? result.value ?? undefined : undefined)
    },
    confirm: (title, message, dialogOptions) => {
      const request: ExtensionUIPromptRequest = {
        type: 'prompt', requestId: randomUUID(), kind: 'confirm', title, message,
        ...(dialogOptions?.timeout !== undefined ? { timeout: dialogOptions.timeout } : {}),
      }
      return requestPrompt(request, dialogOptions, false, (result) =>
        result?.kind === 'confirm' ? result.value : false)
    },
    input: (title, placeholder, dialogOptions) => {
      const request: ExtensionUIPromptRequest = {
        type: 'prompt', requestId: randomUUID(), kind: 'input', title,
        ...(placeholder !== undefined ? { placeholder } : {}),
        ...(dialogOptions?.timeout !== undefined ? { timeout: dialogOptions.timeout } : {}),
      }
      return requestPrompt(request, dialogOptions, undefined, (result) =>
        result?.kind === 'input' ? result.value ?? undefined : undefined)
    },
    inputSecret: (title, placeholder, dialogOptions) => {
      const sessionId = activeSessionId
      if (disposed || !renderer || !sessionId) return Promise.resolve(undefined)
      const request: ExtensionUIPromptRequest = {
        type: 'prompt', requestId: randomUUID(), kind: 'secret-input', sessionId, title,
        ...(placeholder !== undefined ? { placeholder } : {}),
        ...(dialogOptions?.timeout !== undefined ? { timeout: dialogOptions.timeout } : {}),
      }
      return requestPrompt(request, dialogOptions, undefined, (result) =>
        result?.kind === 'secret-input' ? result.value ?? undefined : undefined)
    },
    editor: (title, prefill) => {
      const request: ExtensionUIPromptRequest = {
        type: 'prompt', requestId: randomUUID(), kind: 'editor', title,
        ...(prefill !== undefined ? { prefill } : {}),
      }
      return requestPrompt(request, undefined, undefined, (result) =>
        result?.kind === 'editor' ? result.value ?? undefined : undefined)
    },
    notify: (message, type = 'info') => publish({ type: 'notification', message, level: type }),
    onTerminalInput: () => {
      if (!terminalInputUnsupportedReported) {
        terminalInputUnsupportedReported = true
        const event: ExtensionUIEvent = { type: 'unsupported', operation: 'onTerminalInput' }
        if (renderer) publish(event)
        else terminalInputUnsupportedPending = true
      }
      return () => {}
    },
    setStatus: (key, text) => emitPersistent(`status:${key}`, { type: 'status', key, text: text ?? null }),
    setWorkingMessage: (message) => emitPersistent('working-message', { type: 'working-message', message: message ?? null }),
    setWorkingVisible: (visible) => emitPersistent('working-visible', { type: 'working-visible', visible }),
    setWorkingIndicator: (options) => emitPersistent('working-indicator', {
      type: 'working-indicator',
      options: options ? {
        ...(options.frames !== undefined ? { frames: [...options.frames] } : {}),
        ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
      } : null,
    }),
    setHiddenThinkingLabel: (label) => emitPersistent('hidden-thinking-label', {
      type: 'hidden-thinking-label', label: label ?? null,
    }),
    setWidget: (key, content: Parameters<ExtensionUIContext['setWidget']>[1] | string[], options) => {
      const placement = options?.placement ?? 'aboveEditor'
      if (options?.semantic && content === undefined) {
        customViewHost.clearWidget(key, options.semantic)
        return
      }
      if (options?.semantic && typeof content === 'function') {
        if (customViewHost.openWidget(key, options.semantic)) return
        unsupported('setWidget')
      }
      if (content !== undefined && typeof content !== 'function') {
        emitPersistent(`widget:${key}`, {
          type: 'widget', key, content: [...content], placement,
        })
        return
      }
      if (content === undefined) {
        emitPersistent(`widget:${key}`, { type: 'widget', key, content: null, placement })
        return
      }
      unsupported('setWidget')
    },
    setFooter: () => unsupported('setFooter'),
    setHeader: () => unsupported('setHeader'),
    setTitle: (title) => emitPersistent('title', { type: 'title', title }),
    custom,
    pasteToEditor: () => unsupported('pasteToEditor'),
    setEditorText: (text) => {
      if (!isString(text)) throw new RangeError('The extension editor text exceeds the supported size limit.')
      const sessionId = requireActiveSession()
      const current = mirroredEditor
      if (!current || current.sessionId !== sessionId) {
        throw new Error('The active renderer has not mirrored the current editor draft.')
      }
      const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '    ')
      if (!isString(normalizedText)) throw new RangeError('The normalized extension editor text exceeds the supported size limit.')
      const expectedRevision = editorRevision
      const revision = incrementRevision(expectedRevision)
      const selectionStart = normalizedText.length
      const event: ExtensionUIEvent = {
        type: 'editor-text-set',
        sessionId,
        expectedRevision,
        revision,
        expectedSequence: current.sequence,
        text: normalizedText,
        selectionStart,
        selectionEnd: selectionStart,
      }
      editorRevision = revision
      publish(event)
    },
    getEditorText: () => {
      const sessionId = requireActiveSession()
      const current = mirroredEditor
      if (!current || current.sessionId !== sessionId) {
        throw new Error('The active renderer has not mirrored the current editor draft.')
      }
      return current.text
    },
    addAutocompleteProvider: () => unsupported('addAutocompleteProvider'),
    setEditorComponent: () => unsupported('setEditorComponent'),
    getEditorComponent: () => unsupported('getEditorComponent'),
    get theme() { return unsupportedTheme },
    getAllThemes: () => unsupported('getAllThemes'),
    getTheme: () => unsupported('getTheme'),
    setTheme: () => unsupported('setTheme'),
    getToolsExpanded: () => {
      const sessionId = requireActiveSession()
      const current = mirroredToolsExpanded
      if (!current || current.sessionId !== sessionId) {
        throw new Error('The active renderer has not mirrored the current tool expansion state.')
      }
      return current.expanded
    },
    setToolsExpanded: (expanded) => {
      if (typeof expanded !== 'boolean') throw new TypeError('Tool expansion state must be a boolean.')
      const sessionId = requireActiveSession()
      const current = mirroredToolsExpanded
      if (!current || current.sessionId !== sessionId) {
        throw new Error('The active renderer has not mirrored the current tool expansion state.')
      }
      const expectedRevision = toolsExpandedRevision
      const revision = incrementRevision(expectedRevision)
      toolsExpandedRevision = revision
      publish({
        type: 'tools-expanded-set',
        sessionId,
        expectedRevision,
        revision,
        expectedSequence: current.sequence,
        expanded,
      })
    },
  }

  const replyCapability: CapabilityDefinition<ExtensionUIReplyRequest, ExtensionUIReplyAck> = {
    id: EXTENSION_UI_IPC.reply,
    scope: 'runtime',
    validateRequest: isReplyRequest,
    validateResponse: isReplyAck,
    authorize: (caller, request) => {
      const operation = replyOperationAuthorizations.get(request)
      if (operation?.handled) {
        const active = pending.get(request.requestId)
        const authorized = !!active
          && promptIsCurrent(active)
          && sameCaller(operation.caller, caller)
          && operation.sessionId === active.sessionId
          && operation.uiGeneration === active.uiGeneration
          && replyMatches(active.request, request.result)
          && !!renderer
          && sameCaller(renderer.caller, caller)
        if (!authorized) return false
        if (active.replyTimer) clearTimeout(active.replyTimer)
        active.replyTimer = undefined
        replyOperationAuthorizations.delete(request)
        settle(request.requestId, request.result)
        return true
      }
      const active = pending.get(request.requestId)
      const authorized = !disposed
        && !!active
        && !!active.caller
        && sameCaller(caller, active.caller)
        && promptIsCurrent(active)
        && replyMatches(active.request, request.result)
        && !!renderer
        && sameCaller(renderer.caller, caller)
      if (authorized && active) {
        replyOperationAuthorizations.set(request, {
          caller,
          sessionId: active.sessionId,
          uiGeneration: active.uiGeneration,
          handled: false,
        })
      }
      return authorized
    },
    handle: (context, request) => {
      const active = pending.get(request.requestId)
      const operation = replyOperationAuthorizations.get(request)
      if (!active || disposed || !sameScope(context.scope, boundScope)
        || !operation || operation.handled
        || !active.caller
        || !sameCaller(context.caller, active.caller)
        || !promptIsCurrent(active)
        || !sameCaller(operation.caller, context.caller)
        || operation.sessionId !== active.sessionId
        || operation.uiGeneration !== active.uiGeneration
        || !replyMatches(active.request, request.result)) {
        throw new Error('The extension UI prompt is no longer active.')
      }
      const timer = setTimeout(() => {
        const activePrompt = pending.get(request.requestId)
        if (replyOperationAuthorizations.get(request) !== operation || !activePrompt) return
        replyOperationAuthorizations.delete(request)
        if (activePrompt.replyTimer === timer) activePrompt.replyTimer = undefined
        settle(request.requestId, undefined, promptIsCurrent(activePrompt) ? 'renderer-disconnected' : 'session-disposed')
      }, 0)
      operation.handled = true
      active.replyTimer = timer
      return { accepted: true }
    },
  }

  const actionCapability: CapabilityDefinition<SemanticViewActionRequest, SemanticViewActionAck> = {
    id: EXTENSION_UI_IPC.action,
    scope: 'runtime',
    validateRequest: isSemanticViewActionRequest,
    validateResponse: isSemanticViewActionAck,
    authorize: (caller, request) => customViewHost.authorizeAction(caller, boundScope, request),
    handle: (context, request) => customViewHost.dispatchAction(context.caller, context.scope, request),
  }

  const customActionCapability: CapabilityDefinition<NativeCustomUIActionRequest, NativeCustomUIActionAck> = {
    id: EXTENSION_UI_IPC.customAction,
    scope: 'runtime',
    validateRequest: isNativeCustomUIActionRequest,
    validateResponse: isNativeCustomUIActionAck,
    authorize: (caller, request) => customViewHost.nativeCustomUIHost.authorizeAction(caller, boundScope, request),
    handle: (context, request) => customViewHost.nativeCustomUIHost.dispatchAction(
      context.caller,
      context.scope,
      request,
    ),
  }

  const stateCapability: CapabilityDefinition<ExtensionUIStateUpdateRequest, ExtensionUIStateUpdateAck> = {
    id: EXTENSION_UI_IPC.state,
    scope: 'runtime',
    validateRequest: isStateUpdateRequest,
    validateResponse: isStateUpdateAck,
    authorize: (caller) => !disposed && !!renderer && sameCaller(renderer.caller, caller),
    handle: (context, request) => {
      if (disposed || !sameScope(context.scope, boundScope)
        || !renderer || !sameCaller(renderer.caller, context.caller)) {
        throw new Error('The extension UI renderer is no longer bound to this runtime.')
      }
      return request.kind === 'editor'
        ? mirrorEditorState(request)
        : mirrorToolsExpandedState(request)
    },
  }

  const setActiveSession = (sessionId: string | undefined): void => {
    if (disposed) throw new Error('The extension UI host has been disposed.')
    if (sessionId !== undefined && !isSessionId(sessionId)) {
      throw new TypeError('A valid native session id is required for the extension UI binding.')
    }
    if (sessionId === activeSessionId) return
    const nextEditorRevision = incrementRevision(editorRevision)
    const nextToolsExpandedRevision = incrementRevision(toolsExpandedRevision)
    advanceNativeUiGeneration()
    for (const requestId of pending.keys()) settle(requestId, undefined, 'session-disposed')
    customViewHost.setActiveSession(sessionId)
    activeSessionId = sessionId
    mirroredEditor = undefined
    mirroredToolsExpanded = undefined
    editorRevision = nextEditorRevision
    toolsExpandedRevision = nextToolsExpandedRevision
    publishSessionBinding()
  }

  const invalidateNativeUi = (): void => {
    if (disposed) throw new Error('The extension UI host has been disposed.')
    const nextEditorRevision = incrementRevision(editorRevision)
    const nextToolsExpandedRevision = incrementRevision(toolsExpandedRevision)
    advanceNativeUiGeneration()
    for (const requestId of pending.keys()) settle(requestId, undefined, 'session-disposed')
    customViewHost.invalidateNativeUi()
    mirroredEditor = undefined
    mirroredToolsExpanded = undefined
    editorRevision = nextEditorRevision
    toolsExpandedRevision = nextToolsExpandedRevision
    publishSessionBinding()
  }

  const uiEvent: EventDefinition<ExtensionUIEvent> = {
    id: EXTENSION_UI_IPC.event,
    scope: 'runtime',
    validatePayload: isExtensionUIEvent,
    subscribe: (context, eventPublish) => {
      if (!sameScope(context.scope, boundScope)) throw new Error('The extension UI runtime scope is unavailable.')
      if (disposed) throw new Error('The extension UI host has been disposed.')
      if (renderer) throw new Error('An extension UI renderer is already bound to this runtime scope.')
      const active: ActiveRenderer = {
        caller: context.caller,
        publish: eventPublish,
      }
      renderer = active
      customViewHost.bindRenderer(context.caller)
      for (const event of latestState.values()) eventPublish(event)
      if (!latestState.has('session-binding')) {
        const event = sessionBindingEvent()
        rememberSessionBinding(event)
        eventPublish(event)
      }
      for (const event of transientEvents) eventPublish(event)
      transientEvents.length = 0
      if (terminalInputUnsupportedPending) {
        eventPublish({ type: 'unsupported', operation: 'onTerminalInput' })
        terminalInputUnsupportedPending = false
      }
      for (const prompt of pending.values()) {
        prompt.caller = context.caller
        eventPublish(prompt.request)
      }
      return () => {
        if (renderer !== active) return
        advanceNativeUiGeneration()
        cancelOwned('renderer-disconnected')
        customViewHost.rendererDisconnected(context.caller)
        renderer = undefined
        mirroredEditor = undefined
        mirroredToolsExpanded = undefined
        editorRevision = incrementRevision(editorRevision)
        toolsExpandedRevision = incrementRevision(toolsExpandedRevision)
        publishSessionBinding()
      }
    },
  }

  const bindings: Bindings = { mode: 'rpc', uiContext }
  return {
    scope: boundScope,
    mode: 'rpc',
    uiContext,
    extensionBindings: bindings,
    capabilities: [replyCapability, actionCapability, customActionCapability, stateCapability],
    events: [uiEvent],
    customViewHost,
    setActiveSession,
    invalidateNativeUi,
    dispose() {
      if (disposed) return
      advanceNativeUiGeneration()
      cancelOwned('session-disposed')
      customViewHost.dispose()
      disposed = true
      renderer = undefined
      activeSessionId = undefined
      mirroredEditor = undefined
      mirroredToolsExpanded = undefined
      latestState.clear()
      transientEvents.length = 0
    },
  }
}

export type ExtensionUIBridge = ReturnType<typeof createExtensionUIBridge>
