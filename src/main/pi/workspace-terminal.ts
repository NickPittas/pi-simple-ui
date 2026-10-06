import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

// A workspace shell, fully separate from the Pi RPC child. It is spawned lazily on the first
// subscriber and torn down by dispose().
const MAX_BUFFER = 64 * 1024

type PtyProcess = {
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}
type PtyModule = { spawn(file: string, args: string[], options: Record<string, unknown>): PtyProcess }

export type WorkspaceTerminal = {
  subscribe(listener: (data: string) => void): () => void
  write(data: string): boolean
  resize(cols: number, rows: number): void
  dispose(): Promise<void>
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value) : min))

export function resolveShell(): string {
  const candidate = process.env.SHELL
  if (candidate && isAbsolute(candidate)) {
    try {
      if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate }
    } catch { /* fall through */ }
  }
  return '/bin/bash'
}

export function createWorkspaceTerminal(options: { cwd: string; cols?: number; rows?: number }): WorkspaceTerminal {
  const listeners = new Set<(data: string) => void>()
  let buffer = ''
  let pty: PtyProcess | undefined
  let starting = false
  let disposed = false
  let cols = clamp(options.cols ?? 80, 2, 500)
  let rows = clamp(options.rows ?? 24, 1, 200)

  const emit = (data: string): void => {
    buffer += data
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(buffer.length - MAX_BUFFER)
    for (const listener of [...listeners]) { try { listener(data) } catch { /* isolate listeners */ } }
  }

  const start = async (): Promise<void> => {
    if (starting || pty || disposed) return
    starting = true
    try {
      let mod: PtyModule
      try {
        const loaded = await import('node-pty') as unknown as PtyModule & { default?: PtyModule }
        mod = typeof loaded.spawn === 'function' ? loaded : loaded.default as PtyModule
        if (!mod || typeof mod.spawn !== 'function') throw new Error('node-pty exports no spawn()')
      } catch (error) {
        emit(`\r\n[terminal unavailable: ${error instanceof Error ? error.message.split('\n')[0] : 'node-pty failed to load'}]\r\n`)
        return
      }
      if (disposed) return
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined || key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('ELECTRON_')) continue
        env[key] = value
      }
      env.TERM = 'xterm-256color'
      env.COLORTERM = 'truecolor'
      let child: PtyProcess
      try {
        child = mod.spawn(resolveShell(), [], { name: 'xterm-256color', cols, rows, cwd: options.cwd, env })
      } catch (error) {
        emit(`\r\n[terminal unavailable: ${error instanceof Error ? error.message : 'failed to start shell'}]\r\n`)
        return
      }
      pty = child
      child.onData(emit)
      child.onExit(({ exitCode }) => {
        if (pty !== child) return
        pty = undefined
        if (!disposed) emit(`\r\n[shell exited with code ${exitCode} — reopen the terminal to start a new one]\r\n`)
      })
    } finally { starting = false }
  }

  return {
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      if (buffer) { try { listener(buffer) } catch { /* ignore */ } }
      void start()
      return () => {
        listeners.delete(listener)
        // Closing the drawer unmounts the last subscriber; the next subscribe starts a new shell only after exit.
      }
    },
    write(data) {
      if (!pty) return false
      try { pty.write(data); return true } catch { return false }
    },
    resize(nextCols, nextRows) {
      cols = clamp(nextCols, 2, 500)
      rows = clamp(nextRows, 1, 200)
      try { pty?.resize(cols, rows) } catch { /* pty may have just exited */ }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      const child = pty
      pty = undefined
      if (!child) return
      try { child.kill('SIGHUP') } catch { return }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } resolve() }, 1000)
        try { child.onExit(() => { clearTimeout(timer); resolve() }) } catch { clearTimeout(timer); resolve() }
      })
    },
  }
}
