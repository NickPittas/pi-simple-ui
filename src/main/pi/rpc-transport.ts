import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
export type RpcRecord = Record<string, unknown>
export type RpcResponse = RpcRecord & { type: 'response'; id: string; command: string; success: boolean; data?: unknown; error?: string }
export type RpcTransport = {
  request(command: RpcRecord & { type: string }): Promise<RpcResponse>
  subscribe(listener: (record: RpcRecord) => void): () => void
  respondExtensionUi(response: RpcRecord & { id: string }): boolean
  forgetUi(id: string): void
  dispose(): Promise<void>
}

const managedPi = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'bin', 'pi')
const PI = (() => {
  try { accessSync(managedPi, constants.X_OK); return managedPi } catch { return 'pi' }
})()
const MAX_LINE = 64 * 1024 * 1024
const MAX_PENDING = 32
const MAX_STDIN_BUFFER = 1024 * 1024
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor'])

// Strip dev-server/launch-shell leftovers so Pi tools and extensions see a clean env rooted at the session cwd.
function childEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    if (upper.startsWith('NPM_') || key.startsWith('ELECTRON_')) delete env[key]
  }
  delete env.INIT_CWD
  delete env.OLDPWD
  delete env.PNPM_SCRIPT_SRC_DIR
  if (env.NODE_ENV === 'development') delete env.NODE_ENV
  // Also drop other pnpm_* vars (except PNPM_HOME) and dev-runner injected NODE_PATH/PATH entries.
  for (const key of Object.keys(env)) if (key.toLowerCase().startsWith('pnpm_') && key !== 'PNPM_HOME') delete env[key]
  if (env.NODE_PATH !== undefined) {
    const kept = env.NODE_PATH.split(':').filter((e) => e && !e.includes('/node_modules/.pnpm/'))
    if (kept.length) env.NODE_PATH = kept.join(':')
    else delete env.NODE_PATH
  }
  if (env.PATH !== undefined) {
    const seen = new Set<string>()
    const kept = env.PATH.split(':').filter((e) => {
      if (!e.startsWith('/') || /\/node_modules\/\.bin\/?$/.test(e) || e.includes('/.npm/_npx/') || /\/@npmcli\/run-script\/lib\/node-gyp-bin\/?$/.test(e) || seen.has(e)) return false
      seen.add(e)
      return true
    })
    if (kept.length) env.PATH = kept.join(':')
  }
  env.PWD = cwd
  return env
}

export function startRpcTransport(options: { cwd: string; sessionFile?: string; onExit: (code: number) => void }): RpcTransport {
  const child = spawn(PI, ['--mode', 'rpc', ...(options.sessionFile ? ['--session', options.sessionFile] : [])], { cwd: options.cwd, env: childEnv(options.cwd), stdio: ['pipe', 'pipe', 'pipe'] })
  const listeners = new Set<(record: RpcRecord) => void>()
  const pending = new Map<string, { command: string; resolve: (r: RpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  const ui = new Map<string, string>()
  let bytes = Buffer.alloc(0), serial = 0, live = true, exited = false, closed = false, disposed: Promise<void> | undefined
  const fail = (reason: string, terminate = true) => {
    if (!live) return
    live = false
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)) }
    pending.clear(); ui.clear()
    if (terminate) child.kill('SIGTERM')
  }
  const notifyExit = (code: number) => { if (exited) return; exited = true; fail('Pi RPC process exited'); try { options.onExit(code) } catch {} }
  const protocolError = (reason: string) => { fail(reason); child.stdout.destroy() }
  const emit = (record: RpcRecord) => { for (const listener of [...listeners]) try { listener(record) } catch {} }
  const emitLine = (line: Buffer) => {
    if (line.length > MAX_LINE) return protocolError('Pi RPC record exceeds 64 MiB')
    if (line.at(-1) === 13) line = line.subarray(0, -1)
    let record: unknown
    try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)) } catch { return protocolError('Malformed Pi RPC JSONL record') }
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof (record as RpcRecord).type !== 'string') return protocolError('Invalid Pi RPC record')
    const r = record as RpcRecord
    if (r.type === 'response') {
      if (typeof r.id !== 'string' || typeof r.command !== 'string' || typeof r.success !== 'boolean') return protocolError('Invalid correlated Pi RPC response')
      const p = pending.get(r.id)
      if (p && r.command !== p.command) return protocolError('Mismatched Pi RPC response command')
      emit(r)
      if (!p) return // Stale responses cannot match a future, monotonically unique request id.
      pending.delete(r.id); clearTimeout(p.timer); p.resolve(r as RpcResponse); return
    }
    if (r.type === 'extension_ui_request' && typeof r.id === 'string' && DIALOGS.has(String(r.method))) ui.set(r.id, String(r.method))
    emit(r)
  }
  const onData = (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk])
    if (bytes.length > MAX_LINE && bytes.indexOf(10) < 0) return protocolError('Pi RPC record exceeds 64 MiB')
    let lf: number
    while ((lf = bytes.indexOf(10)) >= 0) { const line = bytes.subarray(0, lf); bytes = bytes.subarray(lf + 1); emitLine(line); if (!live) return }
    if (bytes.length > MAX_LINE) protocolError('Pi RPC record exceeds 64 MiB')
  }
  child.stdout.on('data', onData)
  child.stdout.on('end', () => { if (bytes.length) protocolError('Pi RPC stdout ended mid-record'); else if (live) protocolError('Pi RPC stdout ended') })
  child.stderr.on('data', () => {}) // Drain diagnostics without retaining or exposing them.
  child.stdin.on('error', e => fail(`Pi RPC stdin failed: ${e.message}`))
  child.stdout.on('error', e => fail(`Pi RPC stdout failed: ${e.message}`))
  child.on('error', e => { fail(`Pi RPC spawn failed: ${e.message}`, false); notifyExit(-1) })
  child.on('exit', code => notifyExit(code ?? -1))
  child.on('close', () => {
    closed = true
    bytes = Buffer.alloc(0); child.stdin.removeAllListeners(); child.stdout.removeAllListeners(); child.stderr.removeAllListeners()
    child.removeAllListeners('error'); child.removeAllListeners('exit')
  })

  const enqueue = (record: RpcRecord): boolean => {
    if (!live) return false
    let line: string
    try { line = `${JSON.stringify(record)}\n` } catch { return false }
    const size = Buffer.byteLength(line)
    if (size > MAX_STDIN_BUFFER || child.stdin.writableLength + size > MAX_STDIN_BUFFER) return false
    try { child.stdin.write(line); return true } catch { return false }
  }
  return {
    request(command) {
      if (!live) return Promise.reject(new Error('Pi RPC transport is not active'))
      if (pending.size >= MAX_PENDING) return Promise.reject(new Error('Pi RPC request limit reached'))
      if (typeof command.type !== 'string') return Promise.reject(new Error('Pi RPC command type is required'))
      const id = `rpc-${++serial}`, type = command.type
      return new Promise<RpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Pi RPC ${type} timed out`)) }, 30_000)
        pending.set(id, { command: type, resolve, reject, timer })
        if (!enqueue({ ...command, id })) { pending.delete(id); clearTimeout(timer); reject(new Error('Pi RPC stdin admission failed')) }
      })
    },
    subscribe(listener) { if (!live) return () => {}; listeners.add(listener); return () => { listeners.delete(listener) } },
    forgetUi(id) { ui.delete(id) },
    respondExtensionUi(response) {
      const method = ui.get(response.id)
      if (!live || typeof response.id !== 'string' || !method) return false
      const cancelled = response.cancelled === true && response.confirmed === undefined && response.value === undefined
      const confirmed = method === 'confirm' && typeof response.confirmed === 'boolean' && response.cancelled === undefined && response.value === undefined
      const value = method !== 'confirm' && typeof response.value === 'string' && response.cancelled === undefined && response.confirmed === undefined
      if (!(cancelled || confirmed || value)) return false
      const wire = cancelled ? { type: 'extension_ui_response', id: response.id, cancelled: true }
        : confirmed ? { type: 'extension_ui_response', id: response.id, confirmed: response.confirmed }
          : { type: 'extension_ui_response', id: response.id, value: response.value }
      if (!enqueue(wire)) return false
      ui.delete(response.id); return true
    },
    dispose() {
      if (disposed) return disposed
      disposed = (async () => {
        fail('Pi RPC transport disposed', false); listeners.clear()
        try {
          if (closed) return
          const closedEvent = new Promise<void>(resolve => child.once('close', () => resolve()))
          child.stdin.end()
          const wait = async (ms: number) => {
            let timer: NodeJS.Timeout | undefined
            const result = await Promise.race([closedEvent.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms) })])
            if (timer) clearTimeout(timer)
            return result
          }
          if (!await wait(2000)) {
            child.kill('SIGTERM')
            if (!await wait(2000)) {
              child.kill('SIGKILL')
              if (!await wait(2000)) throw new Error('Pi RPC process did not close after SIGKILL')
            }
          }
        } finally { bytes = Buffer.alloc(0); ui.clear(); listeners.clear() }
      })()
      return disposed
    },
  }
}
