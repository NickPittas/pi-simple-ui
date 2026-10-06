import { randomUUID } from 'node:crypto'
import {
  getCapabilities,
  setCapabilities,
  TuiMainScreen,
  type Component,
  type ExtensionUIContext,
  type KeybindingsManager,
  type OverlayHandle,
  type TerminalCapabilities,
  type TUI,
  type Theme,
} from '@earendil-works/pi-coding-agent'
import type { AuthorizedIpcCaller } from '../../ipc/register.ts'
import { isRuntimeScope, type RuntimeScope } from '../../../shared/ipc-contracts.ts'
import {
  NATIVE_CUSTOM_UI_CAPABILITIES,
  NATIVE_CUSTOM_UI_FIRST_ACTION_SEQUENCE,
  NATIVE_CUSTOM_UI_LIMITS,
} from '../../../shared/extension-ui.ts'
import type {
  NativeCustomUIActionAck,
  NativeCustomUIActionRequest,
  NativeCustomUIEvent,
} from '../../../shared/extension-ui.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const VIRTUAL_TERMINAL_CAPABILITIES: TerminalCapabilities = {
  images: null,
  trueColor: true,
  hyperlinks: false,
}

export interface NativeCustomUIConfiguration {
  readonly theme: Theme
  readonly keybindings: KeybindingsManager
}

type NativeCustomFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => Component & { dispose?(): void } | Promise<Component & { dispose?(): void }>

type NativeCustomOptions = NonNullable<Parameters<ExtensionUIContext['custom']>[1]>

interface ActiveRenderer {
  readonly caller: AuthorizedIpcCaller
}

interface NativeCustomView<T = never> {
  readonly id: string
  readonly sessionId: string
  readonly parentViewId: string | null
  readonly tui: TuiMainScreen
  readonly terminal: VirtualTerminal
  readonly rendererCaller: AuthorizedIpcCaller
  readonly uiGeneration: number
  readonly resolve: (result: T) => void
  readonly reject: (error: Error) => void
  readonly options?: NativeCustomOptions
  component?: Component & { dispose?(): void }
  overlayHandle?: OverlayHandle
  hostSuspendedFocus?: boolean
  hostSuspendingFocus?: boolean
  ready: boolean
  readyPublished: boolean
  visible: boolean
  focused: boolean
  capturesInput: boolean
  actionSequence: number
  outputSequence: number
  outputBytes: number
  closeReason?: 'completed' | 'cancelled' | 'failed' | 'output-overflow'
  settled: boolean
}

interface ActionAuthorization {
  readonly caller: AuthorizedIpcCaller
  readonly sessionId: string
  readonly uiGeneration: number
}

function sameScope(left: RuntimeScope | undefined, right: RuntimeScope): boolean {
  return left?.ownerId === right.ownerId && left.generation === right.generation
}

function sameCaller(left: AuthorizedIpcCaller | undefined, right: AuthorizedIpcCaller): boolean {
  return left?.windowId === right.windowId
    && left.webContentsId === right.webContentsId
    && left.frameUrl === right.frameUrl
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function* splitUtf8(value: string, maxBytes: number): Generator<string> {
  let start = 0
  let end = 0
  let bytes = 0
  while (end < value.length) {
    const codePoint = value.codePointAt(end)!
    const width = codePoint > 0xffff ? 2 : 1
    const codePointBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : width === 1 ? 3 : 4
    if (bytes > 0 && bytes + codePointBytes > maxBytes) {
      yield value.slice(start, end)
      start = end
      bytes = 0
    }
    bytes += codePointBytes
    end += width
  }
  if (end > start) yield value.slice(start, end)
}

function abortError(
  reason: 'session-changed' | 'native-ui-invalidated' | 'renderer-disconnected' | 'runtime-disposed' | 'parent-closed',
): Error {
  const error = new Error(`The native custom UI was cancelled because ${reason}.`)
  error.name = 'AbortError'
  return error
}

/** Hosts original Pi custom components on a virtual terminal, without a child process or real TTY. */
export class NativeCustomUIHost {
  private readonly scope: RuntimeScope
  private readonly publish: (event: NativeCustomUIEvent) => void
  private readonly views = new Map<string, NativeCustomView>()
  private readonly stack: NativeCustomView[] = []
  private readonly actionAuthorizations = new WeakMap<NativeCustomUIActionRequest, ActionAuthorization>()
  private renderer: ActiveRenderer | undefined
  private nativeRuntime: object | undefined
  private activeSessionId: string | undefined
  private configuration: NativeCustomUIConfiguration | undefined
  private previousTerminalCapabilities: TerminalCapabilities | undefined
  private uiGeneration = 0
  private disposed = false

  constructor(options: {
    readonly scope: RuntimeScope
    readonly publish: (event: NativeCustomUIEvent) => void
  }) {
    if (!isRuntimeScope(options.scope)) throw new TypeError('A valid runtime scope is required for native custom UI.')
    this.scope = Object.freeze({ ownerId: options.scope.ownerId, generation: options.scope.generation })
    this.publish = options.publish
  }

  configureNativeRuntime(runtime: object): void {
    if (this.disposed || this.nativeRuntime === runtime) return
    this.cancelAll('runtime-disposed')
    this.advanceUiGeneration()
    this.nativeRuntime = runtime
  }

  configureNativeUI(configuration: NativeCustomUIConfiguration): void {
    if (this.disposed) return
    this.configuration = configuration
  }

  setActiveSession(sessionId: string | undefined): void {
    if (this.disposed || this.activeSessionId === sessionId) return
    this.cancelAll('session-changed')
    this.advanceUiGeneration()
    this.activeSessionId = sessionId
  }

  invalidateNativeUi(): void {
    if (this.disposed) return
    this.cancelAll('native-ui-invalidated')
    this.advanceUiGeneration()
  }

  bindRenderer(caller: AuthorizedIpcCaller): void {
    if (this.disposed) return
    if (this.renderer && !sameCaller(this.renderer.caller, caller)) {
      this.rendererDisconnected(this.renderer.caller)
    }
    this.renderer = { caller }
  }

  rendererDisconnected(caller: AuthorizedIpcCaller): void {
    if (!this.renderer || !sameCaller(this.renderer.caller, caller)) return
    this.renderer = undefined
    this.cancelAll('renderer-disconnected')
    this.advanceUiGeneration()
  }

  authorizeAction(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope | undefined,
    request: NativeCustomUIActionRequest,
  ): boolean {
    const operationAuthorization = this.actionAuthorizations.get(request)
    if (operationAuthorization) {
      this.actionAuthorizations.delete(request)
      return sameScope(scope, this.scope)
        && sameCaller(this.renderer?.caller, caller)
        && sameCaller(operationAuthorization.caller, caller)
        && operationAuthorization.sessionId === request.sessionId
        && operationAuthorization.sessionId === this.activeSessionId
        && operationAuthorization.uiGeneration === this.uiGeneration
    }
    const view = this.views.get(request.viewId)
    if (!view || !this.isViewAuthorized(view, caller, scope, request)) return false
    this.actionAuthorizations.set(request, {
      caller,
      sessionId: view.sessionId,
      uiGeneration: view.uiGeneration,
    })
    return true
  }

  async dispatchAction(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope | undefined,
    request: NativeCustomUIActionRequest,
  ): Promise<NativeCustomUIActionAck> {
    const view = this.views.get(request.viewId)
    if (!view || !this.isViewAuthorized(view, caller, scope, request)) {
      return { accepted: false, expectedSequence: view ? view.actionSequence + 1 : 1, reason: 'closed' }
    }
    if (!view.ready || (request.action.type === 'input' && !view.terminal.canAcceptInput)) {
      return { accepted: false, expectedSequence: view.actionSequence + 1, reason: 'not-ready' }
    }
    if (request.sequence !== view.actionSequence + 1) {
      return { accepted: false, expectedSequence: view.actionSequence + 1, reason: 'stale-sequence' }
    }
    if (request.action.type === 'input'
      && utf8Length(request.action.data) > NATIVE_CUSTOM_UI_LIMITS.maxInputUtf8Bytes) {
      return { accepted: false, expectedSequence: view.actionSequence + 1, reason: 'input-too-large' }
    }
    if (request.action.type === 'input') {
      this.refreshFocusStates()
      if (this.getInputOwner() !== view) {
        return { accepted: false, expectedSequence: view.actionSequence + 1, reason: 'not-focused' }
      }
    }

    view.actionSequence = request.sequence
    try {
      if (request.action.type === 'input') {
        view.terminal.sendInput(request.action.data)
      } else if (request.action.type === 'resize') {
        view.terminal.resize(request.action.columns, request.action.rows)
        view.tui.invalidate()
        view.tui.renderNow(true)
      } else {
        view.tui.invalidate()
        view.tui.renderNow(true)
      }
      this.refreshFocusStates()
      if (view.settled && view.closeReason !== 'completed') {
        return { accepted: false, expectedSequence: view.actionSequence + 1, reason: 'view-failed' }
      }
      return { accepted: true, sequence: view.actionSequence }
    } catch {
      this.finish(view, 'failed', new Error('The native custom component failed while handling terminal input.'))
      return { accepted: false, expectedSequence: view.actionSequence + 1, reason: 'view-failed' }
    }
  }

  open<T>(factory: NativeCustomFactory<T>, options?: NativeCustomOptions): Promise<T> {
    const configuration = this.configuration
    const renderer = this.renderer
    const sessionId = this.activeSessionId
    if (this.disposed || !this.nativeRuntime || !configuration || !renderer || !sessionId) {
      return Promise.reject(new Error('The native custom UI host is not bound to an active runtime renderer and session.'))
    }
    if (this.stack.length >= NATIVE_CUSTOM_UI_LIMITS.maxActiveViews) {
      return Promise.reject(new RangeError('The native custom UI nesting limit was reached.'))
    }

    let resolvePromise!: (result: T) => void
    let rejectPromise!: (error: Error) => void
    const factoryPromise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const id = randomUUID()
    const parentViewId = this.stack.at(-1)?.id ?? null
    const rendererCaller = renderer.caller
    const uiGeneration = this.uiGeneration
    if (this.stack.length === 0) {
      this.previousTerminalCapabilities = getCapabilities()
      setCapabilities(VIRTUAL_TERMINAL_CAPABILITIES)
    }
    const view = {} as NativeCustomView<T>
    const terminal = new VirtualTerminal({
      columns: NATIVE_CUSTOM_UI_LIMITS.initialColumns,
      rows: NATIVE_CUSTOM_UI_LIMITS.initialRows,
      output: (data) => this.forwardOutput(view, data),
      isInputCurrent: () => this.isCurrentInputView(view),
      onInputFailure: () => this.finish(
        view,
        'failed',
        new Error('The native custom component failed while handling terminal input.'),
      ),
    })
    const tui = new TuiMainScreen(terminal, undefined, undefined, { persistRenderContent: false })
    tui.setScheduledRenderErrorHandler(() => {
      this.finish(view, 'failed', new Error('The native custom component failed while rendering.'))
    })
    tui.setHostRenderCompleteHandler(() => this.refreshFocusStates())
    tui.setHostOverlayUnfocusHandler((component) => {
      if (component === view.component && !view.hostSuspendingFocus) {
        view.hostSuspendedFocus = false
      }
    })
    Object.assign(view, {
      id,
      sessionId,
      parentViewId,
      tui,
      terminal,
      rendererCaller,
      uiGeneration,
      resolve: resolvePromise,
      reject: rejectPromise,
      ...(options ? { options } : {}),
      actionSequence: NATIVE_CUSTOM_UI_FIRST_ACTION_SEQUENCE - 1,
      outputSequence: 0,
      outputBytes: 0,
      ready: false,
      readyPublished: false,
      visible: false,
      focused: false,
      capturesInput: false,
      settled: false,
    })
    this.views.set(id, view)
    this.stack.push(view)

    try {
      this.publish({
        type: 'native-custom-opened',
        viewId: id,
        sessionId,
        parentViewId,
        columns: NATIVE_CUSTOM_UI_LIMITS.initialColumns,
        rows: NATIVE_CUSTOM_UI_LIMITS.initialRows,
        firstActionSequence: NATIVE_CUSTOM_UI_FIRST_ACTION_SEQUENCE,
        capabilities: NATIVE_CUSTOM_UI_CAPABILITIES,
      })
      this.refreshFocusStates()
      // TUI start can synchronously write its initial screen; publish opened first on the same event transport.
      tui.start()
      const componentPromise = Promise.resolve(factory(
        tui,
        configuration.theme,
        configuration.keybindings,
        (result) => this.finish(view, 'completed', undefined, result),
      ))
      void componentPromise.then((component) => {
        if (view.settled || this.views.get(view.id) !== view) {
          this.disposeComponent(component)
          return
        }
        try {
          view.component = component
          if (options?.overlay) {
            let overlayOptions = options.overlayOptions
              ? typeof options.overlayOptions === 'function' ? options.overlayOptions() : options.overlayOptions
              : undefined
            if (!options.overlayOptions) {
              const width = (component as Component & { width?: number }).width
              if (typeof width === 'number' && width > 0) overlayOptions = { width }
            }
            const handle = tui.showOverlay(component, overlayOptions)
            view.overlayHandle = handle
            options.onHandle?.(handle)
          } else {
            tui.addChild(component)
            tui.setFocus(component)
          }
          if (view.settled || this.views.get(view.id) !== view) return
          tui.renderNow(true)
          if (view.settled || this.views.get(view.id) !== view) return
          view.ready = true
          this.refreshFocusStates(view)
        } catch {
          this.finish(view, 'failed', new Error('The native custom component could not be mounted.'))
        }
      }, () => {
        this.finish(view, 'failed', new Error('The native custom component factory failed.'))
      })
    } catch {
      this.finish(view, 'failed', new Error('The native custom component could not be started.'))
    }
    return factoryPromise
  }

  dispose(): void {
    if (this.disposed) return
    this.cancelAll('runtime-disposed')
    this.disposed = true
    this.renderer = undefined
    this.nativeRuntime = undefined
    this.activeSessionId = undefined
    this.configuration = undefined
    this.restoreTerminalCapabilities()
  }

  private forwardOutput(view: NativeCustomView, data: string): void {
    if (view.settled || !data) return
    const byteLength = utf8Length(data)
    if (view.outputBytes + byteLength > NATIVE_CUSTOM_UI_LIMITS.maxOutputBytesPerView) {
      this.finish(view, 'output-overflow', new RangeError('Native custom terminal output exceeded its bound.'))
      return
    }
    view.outputBytes += byteLength
    try {
      for (const chunk of splitUtf8(data, NATIVE_CUSTOM_UI_LIMITS.maxOutputChunkBytes)) {
        view.outputSequence += 1
        this.publish({
          type: 'native-custom-output',
          viewId: view.id,
          sessionId: view.sessionId,
          sequence: view.outputSequence,
          data: chunk,
        })
      }
    } catch {
      this.finish(view, 'failed', new Error('Native custom terminal output could not be delivered.'))
    }
    this.refreshFocusStates()
  }

  private finish<T>(
    view: NativeCustomView<T>,
    reason: 'completed' | 'cancelled' | 'failed' | 'output-overflow',
    error?: Error,
    result?: T,
  ): void {
    if (view.settled) return
    const viewIndex = this.stack.indexOf(view)
    if (viewIndex < 0) return
    for (const child of [...this.stack.slice(viewIndex + 1)].reverse()) {
      this.finish(child, 'cancelled', abortError('parent-closed'))
    }

    view.settled = true
    view.closeReason = reason
    this.views.delete(view.id)
    const currentIndex = this.stack.indexOf(view)
    if (currentIndex >= 0) this.stack.splice(currentIndex, 1)
    view.tui.setScheduledRenderErrorHandler(undefined)
    view.tui.setHostRenderCompleteHandler(undefined)
    view.tui.setHostOverlayUnfocusHandler(undefined)
    try {
      view.tui.stop({ preserveScreen: true })
    } catch {
      // TUI teardown is best-effort; the extension promise must still settle.
    }
    view.terminal.release()
    try {
      view.overlayHandle?.hide()
      while (view.tui.hasOverlay()) view.tui.hideOverlay()
      view.tui.clear()
    } catch {
      // Overlay cleanup is best-effort after the virtual terminal has stopped.
    }
    this.disposeComponent(view.component)
    view.component = undefined
    view.overlayHandle = undefined
    this.restoreTerminalCapabilities()

    try {
      this.publish({
        type: 'native-custom-closed',
        viewId: view.id,
        sessionId: view.sessionId,
        parentViewId: view.parentViewId,
        reason,
        ...(reason === 'failed' ? { error: 'factory-or-input-failed' as const } : {}),
        ...(reason === 'output-overflow' ? { error: 'output-overflow' as const } : {}),
      })
    } catch {
      // A disconnect can race cleanup; native completion still has to settle.
    }

    try {
      this.refreshFocusStates()
    } catch {
      // Focus publication is best-effort during teardown.
    }

    if (reason === 'completed') view.resolve(result as T)
    else view.reject(error ?? abortError('runtime-disposed'))
  }

  private cancelAll(
    reason: 'session-changed' | 'native-ui-invalidated' | 'renderer-disconnected' | 'runtime-disposed',
  ): void {
    for (const view of [...this.stack].reverse()) {
      this.finish(view, 'cancelled', abortError(reason))
    }
  }

  private disposeComponent(component: (Component & { dispose?(): void }) | undefined): void {
    try {
      component?.dispose?.()
    } catch {
      // Extension component cleanup must not leak through IPC or runtime teardown.
    }
  }

  private isViewAuthorized(
    view: NativeCustomView,
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope | undefined,
    request: NativeCustomUIActionRequest,
  ): boolean {
    return !this.disposed
      && !view.settled
      && this.views.get(view.id) === view
      && sameScope(scope, this.scope)
      && sameCaller(this.renderer?.caller, caller)
      && sameCaller(view.rendererCaller, caller)
      && view.uiGeneration === this.uiGeneration
      && view.sessionId === this.activeSessionId
      && request.sessionId === view.sessionId
  }

  private isCurrentInputView(view: NativeCustomView): boolean {
    return !this.disposed
      && view.ready
      && this.views.get(view.id) === view
      && view.uiGeneration === this.uiGeneration
      && view.sessionId === this.activeSessionId
      && sameCaller(this.renderer?.caller, view.rendererCaller)
      && this.getInputOwner() === view
  }

  private isViewVisible(view: NativeCustomView): boolean {
    if (view.settled || !view.ready) return false
    if (!view.options?.overlay) return true
    const focusedComponent = view.tui.getFocusedComponent()
    return this.isNativeOverlayVisible(view)
      || (focusedComponent !== null && focusedComponent !== view.component)
  }

  private isNativeOverlayVisible(view: NativeCustomView): boolean {
    const handle = view.overlayHandle
    return !!handle && !handle.isHidden() && handle.getBounds() !== undefined
  }

  private getInputOwner(): NativeCustomView | undefined {
    for (let index = this.stack.length - 1; index >= 0; index--) {
      const view = this.stack[index]!
      if (view.settled) continue
      // An unresolved nested factory suspends its parent until the renderer receives ready/focus.
      if (!view.ready) return undefined
      if (!this.isViewVisible(view)) continue
      if (view.options?.overlay) {
        const focusedComponent = view.tui.getFocusedComponent()
        const backgroundFocused = focusedComponent !== null && focusedComponent !== view.component
        if ((this.isNativeOverlayVisible(view)
          && (view.overlayHandle?.isFocused() || view.hostSuspendedFocus)) || backgroundFocused) return view
        continue
      }
      return view
    }
    return undefined
  }

  private refreshFocusStates(newlyReady?: NativeCustomView): void {
    let inputOwner = this.getInputOwner()
    for (const view of this.stack) {
      const handle = view.overlayHandle
      if (!view.ready || !view.options?.overlay || !handle) continue
      if (inputOwner === view && view.hostSuspendedFocus && this.isNativeOverlayVisible(view)) {
        if (!handle.isFocused()) handle.focus()
        if (handle.isFocused()) view.hostSuspendedFocus = false
      } else if (inputOwner !== view && handle.isFocused()) {
        view.hostSuspendedFocus = true
        view.hostSuspendingFocus = true
        try {
          handle.unfocus()
        } finally {
          view.hostSuspendingFocus = false
        }
      }
    }
    inputOwner = this.getInputOwner()
    for (const view of this.stack) {
      const visible = this.isViewVisible(view)
      const focused = inputOwner === view
      const capturesInput = focused
      view.terminal.setInputActive(focused)
      if (!view.ready) continue
      const firstState = !view.readyPublished
      const changed = firstState
        || view.visible !== visible
        || view.focused !== focused
        || view.capturesInput !== capturesInput
      view.visible = visible
      view.focused = focused
      view.capturesInput = capturesInput
      if (!changed) continue

      if (firstState && view === newlyReady) {
        view.readyPublished = true
        this.publish({
          type: 'native-custom-ready',
          viewId: view.id,
          sessionId: view.sessionId,
          parentViewId: view.parentViewId,
          visible,
          focused,
          capturesInput,
        })
      } else if (!firstState) {
        this.publish({
          type: 'native-custom-focus',
          viewId: view.id,
          sessionId: view.sessionId,
          visible,
          focused,
          capturesInput,
        })
      }
    }
  }

  private advanceUiGeneration(): void {
    this.uiGeneration = this.uiGeneration >= Number.MAX_SAFE_INTEGER ? 1 : this.uiGeneration + 1
  }

  private restoreTerminalCapabilities(): void {
    if (!this.previousTerminalCapabilities || this.views.size > 0) return
    setCapabilities(this.previousTerminalCapabilities)
    this.previousTerminalCapabilities = undefined
  }

}
