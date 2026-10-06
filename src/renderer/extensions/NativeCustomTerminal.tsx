import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { DesktopBridge, IpcResult, RuntimeScope } from '../../shared/ipc-contracts'
import { EXTENSION_UI_IPC, NATIVE_CUSTOM_UI_LIMITS, type NativeCustomUIAction, type NativeCustomUIActionAck, type NativeCustomUIEvent } from '../../shared/extension-ui'

export type NativeCustomOpened = Extract<NativeCustomUIEvent, { readonly type: 'native-custom-opened' }>
export type NativeCustomOutput = Extract<NativeCustomUIEvent, { readonly type: 'native-custom-output' }>
export interface NativeCustomTerminalView {
  readonly opened: NativeCustomOpened
  readonly chunks: readonly NativeCustomOutput[]
}
type QueuedAction = { readonly action: NativeCustomUIAction; readonly inputBytes: number }

function boundedDimension(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}

export function NativeCustomTerminal({
  view,
  active,
  ready,
  focused,
  capturesInput,
  focusRevision,
  bridge,
  scope,
  onFocus,
  onFeedback,
}: {
  readonly view: NativeCustomTerminalView
  readonly active: boolean
  readonly ready: boolean
  readonly focused: boolean
  readonly capturesInput: boolean
  readonly focusRevision: number
  readonly bridge?: Pick<DesktopBridge, 'invoke' | 'subscribe'>
  readonly scope?: RuntimeScope
  readonly onFocus?: () => void
  readonly onFeedback?: (message: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sizeRef = useRef({ columns: view.opened.columns, rows: view.opened.rows })
  const nextSequence = useRef<number>(view.opened.firstActionSequence)
  const actionQueue = useRef<QueuedAction[]>([])
  const bufferedInputBytes = useRef(0)
  const pumping = useRef(false)
  const wakeAfterPump = useRef(false)
  const actionPaused = useRef(false)
  const live = useRef(true)
  const activeRef = useRef(active)
  const readyRef = useRef(ready)
  const focusedRef = useRef(focused)
  const capturesInputRef = useRef(capturesInput)
  const focusRevisionRef = useRef(focusRevision)
  const [queuedInputBytes, setQueuedInputBytes] = useState(0)
  const writtenChunks = useRef(0)
  const outputChain = useRef(Promise.resolve())
  const [actionError, setActionError] = useState<string | null>(null)
  activeRef.current = active
  readyRef.current = ready
  focusedRef.current = focused
  capturesInputRef.current = capturesInput
  focusRevisionRef.current = focusRevision

  const pumpActions = useCallback(async () => {
    if (pumping.current) { wakeAfterPump.current = true; return }
    if (!live.current || actionPaused.current || !bridge || !scope) return
    pumping.current = true
    try {
      while (live.current && !actionPaused.current && actionQueue.current.length > 0) {
        const head = actionQueue.current[0]!
        if (!readyRef.current || (head.action.type === 'input' && (!focusedRef.current || !capturesInputRef.current))) break
        const beforeFocusRevision = focusRevisionRef.current
        let response: IpcResult<NativeCustomUIActionAck>
        try {
          response = await bridge.invoke(EXTENSION_UI_IPC.customAction, {
            viewId: view.opened.viewId,
            sessionId: view.opened.sessionId,
            sequence: nextSequence.current,
            action: head.action,
          }, scope)
        } catch {
          if (!live.current) break
          actionPaused.current = true
          const message = 'The native terminal action acknowledgement was lost. Input is paused to avoid duplicate actions.'
          setActionError(message); onFeedback?.(message)
          break
        }
        if (!live.current) break
        if (!response.ok) {
          actionPaused.current = true
          const message = `Native terminal input stopped: ${response.error.message}`
          setActionError(message); onFeedback?.(message)
          break
        }
        if (response.value.accepted) {
          actionQueue.current.shift()
          bufferedInputBytes.current -= head.inputBytes
          setQueuedInputBytes(bufferedInputBytes.current)
          nextSequence.current = response.value.sequence + 1
          continue
        }
        const { reason, expectedSequence } = response.value
        if (reason === 'not-ready' || reason === 'not-focused') {
          if (expectedSequence !== nextSequence.current) {
            actionPaused.current = true
            const message = `Native terminal expected sequence ${expectedSequence}; queued input was not retried.`
            setActionError(message); onFeedback?.(message)
            break
          }
          if (focusRevisionRef.current > beforeFocusRevision) continue
          break
        }
        actionPaused.current = true
        const message = reason === 'stale-sequence'
          ? `Native terminal sequence was rejected (expected ${expectedSequence}). Input is paused; no retry was sent.`
          : reason === 'input-too-large'
            ? 'Native terminal input was rejected because it exceeded the host limit. No retry was sent.'
            : `Native terminal action ended: ${reason}.`
        setActionError(message); onFeedback?.(message)
        break
      }
    } finally {
      pumping.current = false
      if (wakeAfterPump.current) {
        wakeAfterPump.current = false
        queueMicrotask(() => void pumpActions())
      }
    }
  }, [bridge, scope, view.opened.sessionId, view.opened.viewId, onFeedback])
  const enqueueAction = useCallback((action: NativeCustomUIAction) => {
    if (!live.current || !activeRef.current || actionPaused.current) return
    const inputBytes = action.type === 'input' ? new TextEncoder().encode(action.data).byteLength : 0
    if (inputBytes > NATIVE_CUSTOM_UI_LIMITS.maxInputUtf8Bytes || bufferedInputBytes.current + inputBytes > NATIVE_CUSTOM_UI_LIMITS.maxBufferedInputBytes) {
      const message = `Native terminal input buffer reached its ${NATIVE_CUSTOM_UI_LIMITS.maxBufferedInputBytes}-byte limit; additional input was not queued.`
      setActionError(message); onFeedback?.(message)
      return
    }
    actionQueue.current.push({ action, inputBytes })
    bufferedInputBytes.current += inputBytes
    setQueuedInputBytes(bufferedInputBytes.current)
    void pumpActions()
  }, [onFeedback, pumpActions])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !view.opened.capabilities.ansi) {
      setActionError('This native custom view requires ANSI terminal support, which is not available.')
      return
    }
    live.current = true
    const terminal = new Terminal({
      cols: boundedDimension(view.opened.columns, NATIVE_CUSTOM_UI_LIMITS.minColumns, NATIVE_CUSTOM_UI_LIMITS.maxColumns),
      rows: boundedDimension(view.opened.rows, NATIVE_CUSTOM_UI_LIMITS.minRows, NATIVE_CUSTOM_UI_LIMITS.maxRows),
      scrollback: 1000,
      cursorBlink: false,
      convertEol: false,
      allowProposedApi: false,
      allowTransparency: false,
      linkHandler: { activate: () => {} },
      theme: { background: '#141815', foreground: '#e7e9e4', cursor: '#d6dfd0', selectionBackground: '#526451' },
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
      fontSize: 13,
      lineHeight: 1.35,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fit
    sizeRef.current = { columns: terminal.cols, rows: terminal.rows }

    // The native contract advertises no mouse support. Prevent pointer input from
    // being translated by the emulator while leaving scroll-wheel viewport access.
    const blockPointer = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
    for (const name of ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu']) host.addEventListener(name, blockPointer, true)

    const dataSubscription = terminal.onData((data) => {
      if (!activeRef.current || !live.current || !focusedRef.current || !capturesInputRef.current) return
      const bytes = new TextEncoder().encode(data).byteLength
      if (bytes > NATIVE_CUSTOM_UI_LIMITS.maxInputUtf8Bytes) {
        const message = `Terminal input exceeds the ${NATIVE_CUSTOM_UI_LIMITS.maxInputUtf8Bytes}-byte native limit and was not sent.`
        setActionError(message); onFeedback?.(message)
        return
      }
      enqueueAction({ type: 'input', data })
    })

    const observer = new ResizeObserver(() => {
      if (!live.current || !activeRef.current) return
      try {
        fit.fit()
        const columns = boundedDimension(terminal.cols, NATIVE_CUSTOM_UI_LIMITS.minColumns, NATIVE_CUSTOM_UI_LIMITS.maxColumns)
        const rows = boundedDimension(terminal.rows, NATIVE_CUSTOM_UI_LIMITS.minRows, NATIVE_CUSTOM_UI_LIMITS.maxRows)
        if (terminal.cols !== columns || terminal.rows !== rows) terminal.resize(columns, rows)
        if (columns === sizeRef.current.columns && rows === sizeRef.current.rows) return
        sizeRef.current = { columns, rows }
        enqueueAction({ type: 'resize', columns, rows })
      } catch { /* The host may be hidden while another custom screen is active. */ }
    })
    observer.observe(host)
    requestAnimationFrame(() => {
      if (!live.current) return
      try {
        fit.fit()
        const columns = boundedDimension(terminal.cols, NATIVE_CUSTOM_UI_LIMITS.minColumns, NATIVE_CUSTOM_UI_LIMITS.maxColumns)
        const rows = boundedDimension(terminal.rows, NATIVE_CUSTOM_UI_LIMITS.minRows, NATIVE_CUSTOM_UI_LIMITS.maxRows)
        if (terminal.cols !== columns || terminal.rows !== rows) terminal.resize(columns, rows)
        if (columns !== sizeRef.current.columns || rows !== sizeRef.current.rows) {
          sizeRef.current = { columns, rows }
          enqueueAction({ type: 'resize', columns, rows })
        }
      } catch { /* Initial layout can be measured on the next resize. */ }
      if (activeRef.current && readyRef.current && focusedRef.current && capturesInputRef.current) terminal.focus()
    })

    return () => {
      live.current = false
      observer.disconnect()
      dataSubscription.dispose()
      for (const name of ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu']) host.removeEventListener(name, blockPointer, true)
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      actionPaused.current = true
    }
  }, [view.opened.viewId, view.opened.sessionId, view.opened.columns, view.opened.rows, view.opened.capabilities.ansi, enqueueAction, onFeedback])

  useEffect(() => {
    if (!active || !ready || !focused || !capturesInput) { terminalRef.current?.blur(); return }
    const terminal = terminalRef.current
    const fit = fitRef.current
    if (!terminal || !fit) return
    try {
      fit.fit()
      const columns = boundedDimension(terminal.cols, NATIVE_CUSTOM_UI_LIMITS.minColumns, NATIVE_CUSTOM_UI_LIMITS.maxColumns)
      const rows = boundedDimension(terminal.rows, NATIVE_CUSTOM_UI_LIMITS.minRows, NATIVE_CUSTOM_UI_LIMITS.maxRows)
      if (terminal.cols !== columns || terminal.rows !== rows) terminal.resize(columns, rows)
      if (columns !== sizeRef.current.columns || rows !== sizeRef.current.rows) {
        sizeRef.current = { columns, rows }
        enqueueAction({ type: 'resize', columns, rows })
      }
    } catch { /* Wait for the native screen to become measurable. */ }
    terminal.focus()
  }, [active, ready, focused, capturesInput, focusRevision, enqueueAction])

  useEffect(() => { void pumpActions() }, [ready, focused, capturesInput, focusRevision, pumpActions])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    const suffix = view.chunks.slice(writtenChunks.current)
    writtenChunks.current = view.chunks.length
    for (const chunk of suffix) {
      outputChain.current = outputChain.current.then(() => new Promise<void>((resolve) => terminal.write(chunk.data, resolve)))
    }
  }, [view.chunks])

  useEffect(() => {
    if (!active || !ready || !focused || !capturesInput) return
    requestAnimationFrame(() => {
      if (!activeRef.current) return
      try { fitRef.current?.fit() } catch { /* Wait for a visible layout. */ }
      terminalRef.current?.focus()
      onFocus?.()
    })
  }, [active, ready, focused, capturesInput, onFocus])

  return <div className={`native-custom-screen${active ? ' is-active' : ''}`} aria-hidden={!active}>
    <div className="native-custom-panel" role="region" aria-label="Native extension terminal">
      <header className="native-custom-header"><div><span className="extension-dialog-kicker">PI EXTENSION · NATIVE CUSTOM UI</span><h2>Terminal interaction</h2></div><span className="native-custom-capabilities">ANSI {view.opened.capabilities.ansi ? 'on' : 'off'} · True color {view.opened.capabilities.trueColor ? 'on' : 'off'} · Mouse, images, links and Kitty keyboard unavailable</span></header>
      <div className="native-custom-terminal" ref={hostRef} onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }} />
      {!ready && <p className="native-custom-hint" role="status">Preparing the native terminal screen…</p>}
      {ready && (!focused || !capturesInput) && <p className="native-custom-hint" role="status">This native screen is visible but does not currently own keyboard input.</p>}
      {queuedInputBytes > 0 && <p className="native-custom-hint" role="status">Waiting to send {queuedInputBytes} bytes of queued native input.</p>}
      {actionError && <p className="native-custom-error" role="alert">{actionError}</p>}
      {!view.opened.capabilities.mouse && <p className="native-custom-hint">Use the native component’s keyboard controls. Pointer input is not sent to the extension.</p>}
    </div>
  </div>
}
