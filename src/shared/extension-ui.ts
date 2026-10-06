import type { JSONValue, WorkingIndicatorOptions } from '@earendil-works/pi-coding-agent'

export const EXTENSION_UI_IPC = Object.freeze({
  reply: 'extension.ui.reply',
  action: 'extension.ui.action',
  customAction: 'extension.ui.custom-action',
  state: 'extension.ui.state',
  event: 'extension.ui',
})

/** Maximum UTF-16 code units accepted by the transient extension secret prompt. */
export const MAX_EXTENSION_SECRET_INPUT_LENGTH = 16_384

export const NATIVE_CUSTOM_UI_LIMITS = Object.freeze({
  initialColumns: 80,
  initialRows: 24,
  minColumns: 10,
  maxColumns: 500,
  minRows: 4,
  maxRows: 200,
  maxInputUtf8Bytes: 16_384,
  maxBufferedInputBytes: 64 * 1024,
  maxOutputChunkBytes: 64 * 1024,
  maxOutputBytesPerView: 32 * 1024 * 1024,
  maxActiveViews: 8,
})

/** First renderer-supplied action sequence for each native custom UI view. */
export const NATIVE_CUSTOM_UI_FIRST_ACTION_SEQUENCE = 1

export const NATIVE_CUSTOM_UI_CAPABILITIES = Object.freeze({
  ansi: true,
  trueColor: true,
  hyperlinks: false,
  images: false,
  mouse: false,
  kittyKeyboard: false,
})

export type ExtensionUIPromptRequest =
  | {
      readonly type: 'prompt'
      readonly requestId: string
      readonly kind: 'select'
      readonly title: string
      readonly options: readonly string[]
      readonly timeout?: number
    }
  | {
      readonly type: 'prompt'
      readonly requestId: string
      readonly kind: 'confirm'
      readonly title: string
      readonly message: string
      readonly timeout?: number
    }
  | {
      readonly type: 'prompt'
      readonly requestId: string
      readonly kind: 'input'
      readonly title: string
      readonly placeholder?: string
      readonly timeout?: number
    }
  | {
      /** One-shot masked entry; never includes typed/default secret content. */
      readonly type: 'prompt'
      readonly requestId: string
      readonly kind: 'secret-input'
      /** The active native session that owns this one-shot prompt. */
      readonly sessionId: string
      readonly title: string
      readonly placeholder?: string
      readonly timeout?: number
    }
  | {
      readonly type: 'prompt'
      readonly requestId: string
      readonly kind: 'editor'
      readonly title: string
      readonly prefill?: string
    }

export type ExtensionUIPromptResult =
  | { readonly kind: 'select'; readonly value: string | null }
  | { readonly kind: 'confirm'; readonly value: boolean }
  | { readonly kind: 'input'; readonly value: string | null }
  /** Submitted only in the matching owner-bound reply; never re-emitted as an event. */
  | { readonly kind: 'secret-input'; readonly value: string | null }
  | { readonly kind: 'editor'; readonly value: string | null }

export interface ExtensionUIReplyRequest {
  readonly requestId: string
  readonly result: ExtensionUIPromptResult
}

export interface ExtensionUIReplyAck {
  readonly accepted: true
}

export type ExtensionUIStateUpdateRequest =
  | {
      readonly kind: 'editor'
      /** Must match the current session-binding event. */
      readonly sessionId: string
      /** editorRevision from the latest session-binding or editor-text-set event. */
      readonly baseRevision: number
      /** Monotonic per-session renderer sequence, starting at 1; protects coalesced/out-of-order drafts. */
      readonly sequence: number
      readonly text: string
      /** UTF-16 offsets into text, matching JavaScript selectionStart/selectionEnd. */
      readonly selectionStart: number
      readonly selectionEnd: number
    }
  | {
      readonly kind: 'tools-expanded'
      /** Must match the current session-binding event. */
      readonly sessionId: string
      /** toolsExpandedRevision from the latest session-binding or tools-expanded-set event. */
      readonly baseRevision: number
      /** Monotonic per-session renderer sequence, starting at 1. */
      readonly sequence: number
      readonly expanded: boolean
    }

export type ExtensionUIStateUpdateAck =
  | {
      readonly kind: 'editor' | 'tools-expanded'
      readonly accepted: true
      readonly revision: number
      readonly sequence: number
    }
  | {
      readonly kind: 'editor' | 'tools-expanded'
      readonly accepted: false
      readonly revision: number
      readonly sequence: number
      readonly reason: 'session-unbound' | 'session-mismatch' | 'stale-revision' | 'stale-sequence'
    }

export interface SemanticViewActionRequest {
  readonly instanceId: string
  readonly revision: number
  readonly action: JSONValue
}

export type NativeCustomUIAction =
  | {
      /** Raw keyboard or bracketed-paste data; Escape is delivered to the native component. */
      readonly type: 'input'
      readonly data: string
    }
  | { readonly type: 'resize'; readonly columns: number; readonly rows: number }
  | { readonly type: 'render' }

export interface NativeCustomUIActionRequest {
  readonly viewId: string
  readonly sessionId: string
  /** Monotonic for the active view; protects keyboard and resize ordering. */
  readonly sequence: number
  readonly action: NativeCustomUIAction
}

export type NativeCustomUIActionAck =
  | { readonly accepted: true; readonly sequence: number }
  | {
      readonly accepted: false
      readonly expectedSequence: number
      readonly reason:
        | 'closed'
        | 'stale-sequence'
        | 'input-too-large'
        | 'not-ready'
        | 'not-focused'
        | 'view-failed'
    }

export type NativeCustomUIEvent =
  | {
      readonly type: 'native-custom-opened'
      readonly viewId: string
      readonly sessionId: string
      readonly parentViewId: string | null
      /** Virtual screen size at open; the renderer should resize after measuring its panel. */
      readonly columns: number
      readonly rows: number
      /** Renderer must use this value for the view's first action. */
      readonly firstActionSequence: typeof NATIVE_CUSTOM_UI_FIRST_ACTION_SEQUENCE
      readonly capabilities: typeof NATIVE_CUSTOM_UI_CAPABILITIES
    }
  | {
      readonly type: 'native-custom-ready'
      readonly viewId: string
      readonly sessionId: string
      readonly parentViewId: string | null
      readonly visible: boolean
      /** True only when this view owns cross-view native input focus. */
      readonly focused: boolean
      readonly capturesInput: boolean
    }
  | {
      readonly type: 'native-custom-focus'
      readonly viewId: string
      readonly sessionId: string
      readonly visible: boolean
      /** True only when this view owns cross-view native input focus. */
      readonly focused: boolean
      readonly capturesInput: boolean
    }
  | {
      readonly type: 'native-custom-output'
      readonly viewId: string
      readonly sessionId: string
      /** Monotonic output chunk sequence, starting at 1 for each view. */
      readonly sequence: number
      /** Ordered raw ANSI/VT stream; concatenate chunks by sequence before screen interpretation. */
      readonly data: string
    }
  | {
      readonly type: 'native-custom-closed'
      readonly viewId: string
      readonly sessionId: string
      readonly parentViewId: string | null
      readonly reason: 'completed' | 'cancelled' | 'failed' | 'output-overflow'
      readonly error?: 'factory-or-input-failed' | 'output-overflow'
    }

export type SemanticViewActionAck =
  | { readonly accepted: true; readonly revision: number }
  | {
      readonly accepted: false
      readonly revision: number
      readonly reason: 'closed' | 'stale-revision' | 'unsupported-action' | 'view-failed'
    }

export type ExtensionUIUnsupportedOperation =
  | 'onTerminalInput'
  | 'custom'
  | 'setWidget'
  | 'setFooter'
  | 'setHeader'
  | 'pasteToEditor'
  | 'addAutocompleteProvider'
  | 'setEditorComponent'
  | 'getEditorComponent'
  | 'theme'
  | 'getAllThemes'
  | 'getTheme'
  | 'setTheme'

export type ExtensionUIEvent =
  | ExtensionUIPromptRequest
  | NativeCustomUIEvent
  | {
      readonly type: 'prompt-cancelled'
      readonly requestId: string
      readonly reason: 'aborted' | 'timeout' | 'session-disposed' | 'renderer-disconnected'
    }
  | { readonly type: 'notification'; readonly message: string; readonly level: 'info' | 'warning' | 'error' }
  | { readonly type: 'status'; readonly key: string; readonly text: string | null }
  | { readonly type: 'widget'; readonly key: string; readonly content: readonly string[] | null; readonly placement: 'aboveEditor' | 'belowEditor' }
  | { readonly type: 'title'; readonly title: string }
  | { readonly type: 'working-message'; readonly message: string | null }
  | { readonly type: 'working-visible'; readonly visible: boolean }
  | { readonly type: 'working-indicator'; readonly options: WorkingIndicatorOptions | null }
  | { readonly type: 'hidden-thinking-label'; readonly label: string | null }
  | { readonly type: 'unsupported'; readonly operation: ExtensionUIUnsupportedOperation }
  | {
      /** Sent on initial subscription, active-session change, and renderer disconnect. */
      readonly type: 'session-binding'
      readonly sessionId: string | null
      readonly editorRevision: number
      readonly toolsExpandedRevision: number
    }
  | {
      /** Apply only if sessionId, expectedRevision, and the renderer's local sequence still match. */
      readonly type: 'editor-text-set'
      readonly sessionId: string
      readonly expectedRevision: number
      readonly revision: number
      readonly expectedSequence: number
      readonly text: string
      readonly selectionStart: number
      readonly selectionEnd: number
    }
  | {
      /** Apply only if sessionId, expectedRevision, and the renderer's local sequence still match. */
      readonly type: 'tools-expanded-set'
      readonly sessionId: string
      readonly expectedRevision: number
      readonly revision: number
      readonly expectedSequence: number
      readonly expanded: boolean
    }
  | {
      readonly type: 'semantic-view'
      readonly instanceId: string
      readonly viewId: string
      readonly version: number
      readonly revision: number
      readonly state: JSONValue
    }
  | {
      readonly type: 'semantic-view-closed'
      readonly instanceId: string
      readonly revision: number
      readonly reason: 'completed' | 'cancelled' | 'failed'
    }

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts {
    'extension.ui.reply': {
      readonly request: ExtensionUIReplyRequest
      readonly response: ExtensionUIReplyAck
    }
    'extension.ui.action': {
      readonly request: SemanticViewActionRequest
      readonly response: SemanticViewActionAck
    }
    'extension.ui.custom-action': {
      readonly request: NativeCustomUIActionRequest
      readonly response: NativeCustomUIActionAck
    }
    'extension.ui.state': {
      readonly request: ExtensionUIStateUpdateRequest
      readonly response: ExtensionUIStateUpdateAck
    }
  }

  interface IpcEventContracts {
    'extension.ui': { readonly payload: ExtensionUIEvent }
  }
}
