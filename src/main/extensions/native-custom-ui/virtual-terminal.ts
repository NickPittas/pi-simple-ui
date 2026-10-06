import { StdinBuffer, type Terminal } from '@earendil-works/pi-coding-agent'
import { NATIVE_CUSTOM_UI_LIMITS } from '../../../shared/extension-ui.ts'

export type TerminalOutput = (data: string) => void

/** Terminal adapter for a TuiMainScreen whose VT output is transported to the renderer. */
export class VirtualTerminal implements Terminal {
  private inputHandler: ((data: string) => void) | undefined
  private resizeHandler: (() => void) | undefined
  private inputBuffer: StdinBuffer | undefined
  private inputActive = false
  private columnCount: number
  private rowCount: number
  private output: TerminalOutput | undefined
  private isInputCurrent: (() => boolean) | undefined
  private onInputFailure: (() => void) | undefined

  constructor(options: {
    readonly columns: number
    readonly rows: number
    readonly output: TerminalOutput
    readonly isInputCurrent: () => boolean
    readonly onInputFailure: () => void
  }) {
    this.columnCount = options.columns
    this.rowCount = options.rows
    this.output = options.output
    this.isInputCurrent = options.isInputCurrent
    this.onInputFailure = options.onInputFailure
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput
    this.resizeHandler = onResize
    const inputBuffer = new StdinBuffer({ maxBufferedBytes: NATIVE_CUSTOM_UI_LIMITS.maxBufferedInputBytes })
    inputBuffer.on('data', (sequence) => this.deliverInput(sequence))
    inputBuffer.on('paste', (content) => this.deliverInput(`\x1b[200~${content}\x1b[201~`))
    inputBuffer.on('overflow', () => this.failInput())
    this.inputBuffer = inputBuffer
  }

  stop(): void {
    this.inputActive = false
    this.inputBuffer?.destroy()
    this.inputBuffer = undefined
    this.inputHandler = undefined
    this.resizeHandler = undefined
  }

  release(): void {
    this.stop()
    this.output = undefined
    this.isInputCurrent = undefined
    this.onInputFailure = undefined
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.output?.(data)
  }

  get columns(): number {
    return this.columnCount
  }

  get rows(): number {
    return this.rowCount
  }

  get kittyProtocolActive(): boolean {
    return false
  }

  get canAcceptInput(): boolean {
    return this.inputBuffer !== undefined
  }

  moveBy(lines: number): void {
    if (lines > 0) this.write(`\x1b[${lines}B`)
    else if (lines < 0) this.write(`\x1b[${-lines}A`)
  }

  hideCursor(): void {
    this.write('\x1b[?25l')
  }

  showCursor(): void {
    this.write('\x1b[?25h')
  }

  clearLine(): void {
    this.write('\x1b[K')
  }

  clearFromCursor(): void {
    this.write('\x1b[J')
  }

  clearScreen(): void {
    this.write('\x1b[2J\x1b[H')
  }

  setTitle(title: string): void {
    this.write(`\x1b]0;${title}\x07`)
  }

  setProgress(active: boolean): void {
    this.write(active ? '\x1b]9;4;3\x07' : '\x1b]9;4;0\x07')
  }

  sendInput(data: string): void {
    if (!this.inputActive || !this.inputBuffer) return
    try {
      this.inputBuffer.process(data)
    } catch {
      this.failInput()
    }
  }

  setInputActive(active: boolean): void {
    if (this.inputActive === active) return
    this.inputActive = active
    if (!active) this.inputBuffer?.clear()
  }

  private deliverInput(data: string): void {
    try {
      const isInputCurrent = this.isInputCurrent
      if (!this.inputActive || !isInputCurrent || !isInputCurrent()) {
        this.inputBuffer?.clear()
        return
      }
      const handler = this.inputHandler
      if (!handler) return
      handler(data)
    } catch {
      this.failInput()
    }
  }

  private failInput(): void {
    this.inputActive = false
    try {
      this.inputBuffer?.clear()
    } catch {
      // Decoder cleanup must not escape a timer or input event callback.
    }
    try {
      this.onInputFailure?.()
    } catch {
      // Keep asynchronous decoder failures local to the owning native view.
    }
  }

  resize(columns: number, rows: number): void {
    if (columns === this.columnCount && rows === this.rowCount) return
    this.columnCount = columns
    this.rowCount = rows
    this.resizeHandler?.()
  }
}
