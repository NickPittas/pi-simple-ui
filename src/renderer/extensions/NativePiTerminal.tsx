import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts'
import type { TerminalOutput } from '../../shared/native-pi'

const MAX_QUEUED_CHUNKS = 256
const MAX_QUEUED_BYTES = 1024 * 1024

const THEME = {
  background: '#11111b', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70',
  black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
  brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
}

export function NativePiTerminal({ bridge, scope }: {
  readonly bridge?: Pick<DesktopBridge, 'subscribe' | 'invoke'>
  readonly scope?: RuntimeScope
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const queue = useRef<{ data: string; bytes: number }[]>([])
  const queuedBytes = useRef(0)
  const inputQueue = useRef<string[]>([])
  const frame = useRef<number | null>(null)
  const resizeFrame = useRef<number | null>(null)
  const expectedSequence = useRef(0)
  const [waiting, setWaiting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inputError, setInputError] = useState<string | null>(null)
  const [inputLost, setInputLost] = useState(false)
  const [outputLost, setOutputLost] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let raf: number | null = null
    const terminal = new Terminal({
      scrollback: 1000, cursorBlink: false, convertEol: false, fontSize: 13,
      fontFamily: "'JetBrainsMono Nerd Font', 'JetBrainsMono NF', monospace", theme: THEME,
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    const safeFit = () => {
      if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return
      try { fit.fit() } catch { /* Wait for measurable layout. */ }
    }
    const resize = new ResizeObserver(safeFit)
    resize.observe(host)
    raf = requestAnimationFrame(() => { raf = null; safeFit() })
    return () => {
      disposed = true
      if (raf !== null) cancelAnimationFrame(raf)
      raf = null
      resize.disconnect()
      terminalRef.current = null
      terminal.dispose()
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    // Generation changes reset the emulator and discard all buffered prior-process output.
    terminal.clear()
    terminal.reset()
    queue.current = []
    queuedBytes.current = 0
    expectedSequence.current = 0
    setWaiting(true)
    setError(null)
    setInputError(null)
    setInputLost(false)
    setOutputLost(false)
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    if (!bridge || !scope) return
    let live = true
    let unsubscribe: (() => void) | undefined
    let draining = false
    const drainInput = async () => {
      if (draining) return
      draining = true
      try {
        while (live && inputQueue.current.length) {
          const data = inputQueue.current.shift()!
          const requestId = crypto.randomUUID()
          try {
            const result = await bridge.invoke('native.pi.terminal-input', { requestId, data }, scope)
            if (!live) break
            if (!result.ok) setInputError('delivery unknown: ' + result.error.message)
            else if (result.value.requestId !== requestId || result.value.outcome === 'unknown') {
              setInputError('delivery unknown' + (result.value.reason ? ': ' + result.value.reason : ''))
            } else if (result.value.outcome === 'rejected') {
              setInputError('Terminal input rejected: ' + (result.value.reason ?? 'rejected'))
            } else setInputError(null)
          } catch {
            if (live) setInputError('delivery unknown')
          }
        }
      } finally { draining = false }
    }
    const input = terminal.onData((data) => {
      if (!live || !hostRef.current?.contains(document.activeElement)) return
      inputQueue.current.push(data)
      while (inputQueue.current.length > 64) { inputQueue.current.shift(); setInputLost(true) }
      void drainInput()
    })
    const terminalResize = terminal.onResize(({ cols, rows }) => {
      if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current)
      resizeFrame.current = requestAnimationFrame(() => {
        resizeFrame.current = null
        if (!live) return
        void bridge.invoke('native.pi.terminal-resize', { columns: cols, rows }, scope)
          .then((result) => { if (!result.ok && live) setError(result.error.message) })
          .catch((reason: unknown) => { if (live) setError(reason instanceof Error ? reason.message : 'Terminal resize failed.') })
      })
    })
    const flush = () => {
      frame.current = null
      if (!live) return
      for (const chunk of queue.current) terminal.write(chunk.data)
      queue.current = []
      queuedBytes.current = 0
    }
    const onOutput = (output: TerminalOutput) => {
      if (!live || output.processGeneration !== scope.generation) return
      if (output.gap || output.sequence !== expectedSequence.current) setOutputLost(true)
      expectedSequence.current = output.sequence + 1
      setWaiting(false)
      const bytes = new TextEncoder().encode(output.data).byteLength
      if (bytes > MAX_QUEUED_BYTES) { setOutputLost(true); return }
      queue.current.push({ data: output.data, bytes })
      queuedBytes.current += bytes
      while (queue.current.length > MAX_QUEUED_CHUNKS || queuedBytes.current > MAX_QUEUED_BYTES) {
        queuedBytes.current -= queue.current.shift()!.bytes
        setOutputLost(true)
      }
      if (frame.current === null) frame.current = requestAnimationFrame(flush)
    }
    void bridge.subscribe('native.pi.terminal-output', scope, onOutput).then((result) => {
      if (!live) { if (result.ok) result.value(); return }
      if (result.ok) unsubscribe = result.value
      else setError(result.error.message)
    }).catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : 'Terminal subscription failed.')
    })
    return () => {
      live = false
      unsubscribe?.()
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      queue.current = []
      queuedBytes.current = 0
      inputQueue.current = []
      input.dispose()
      terminalResize.dispose()
      if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current)
      resizeFrame.current = null
    }
  }, [bridge, scope?.ownerId, scope?.generation])

  return <section className="native-custom-panel" role="region" aria-label="Terminal — shell in workspace">
    <div ref={hostRef} className="native-custom-terminal" />
    {waiting && <p className="native-custom-hint" role="status">Starting terminal — shell in workspace…</p>}
    {outputLost && <p className="native-custom-error" role="status">Some terminal output was lost.</p>}
    {inputLost && <p className="native-custom-error" role="status">Some terminal input was lost (oldest queued input dropped).</p>}
    {inputError && <p className="native-custom-error" role="alert">{inputError}</p>}
    {error && <p className="native-custom-error" role="alert">Terminal output unavailable: {error}</p>}
    {/* Relay bytes only; Pi owns menu keys, back/cancel/nesting, and trust prompts remain unobstructed. Unknown input delivery is dropped, never retried, to avoid duplicate bytes. */}
  </section>
}
