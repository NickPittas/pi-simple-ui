import { Buffer } from 'node:buffer'
import type { Json } from './native-pi.ts'
import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

export const FRAME_CHUNK_BYTES = 64 * 1024
export const FRAME_MAX_BYTES = 128 * 1024
export const MESSAGE_MAX_BYTES = 64 * 1024 * 1024
export const QUEUE_MAX_BYTES = 96 * 1024 * 1024
export const FRAME_IDLE_TIMEOUT_MS = 30_000

let nextMessageId = 1

export function encodeFrame(value: unknown): Uint8Array {
  let text: string | undefined
  try { text = JSON.stringify(value) } catch { throw new Error('value is not JSON serializable') }
  if (text === undefined) throw new Error('value is not JSON serializable')
  const source = Buffer.from(text, 'utf8')
  if (source.length === 0 || source.length > MESSAGE_MAX_BYTES) throw new Error('logical message exceeds limit')
  if (nextMessageId > Number.MAX_SAFE_INTEGER) throw new Error('message id exhausted')
  const id = nextMessageId
  nextMessageId = id + 1
  const frames: Buffer[] = []
  let total = 0
  let index = 0
  for (let offset = 0; offset < source.length; offset += FRAME_CHUNK_BYTES) {
    const end = Math.min(offset + FRAME_CHUNK_BYTES, source.length)
    const body = Buffer.from(JSON.stringify({
      id, index, final: end === source.length, data: source.subarray(offset, end).toString('base64'),
    }), 'utf8')
    if (body.length > FRAME_MAX_BYTES) throw new Error('frame body exceeds limit')
    total += body.length + 4
    if (total > QUEUE_MAX_BYTES) throw new Error('framed message exceeds limit')
    const frame = Buffer.alloc(body.length + 4)
    frame.writeUInt32BE(body.length, 0)
    body.copy(frame, 4)
    frames.push(frame)
    index++
  }
  return Buffer.concat(frames, total)
}

export function createFrameDecoder(
  onValue: (value: Json) => void,
  onError: (reason: string) => void,
): { push(bytes: Uint8Array): void; reset(): void } {
  let prefix = Buffer.alloc(4)
  let prefixBytes = 0
  let body: Buffer | null = null
  let bodyBytes = 0
  let fragments: Buffer[] = []
  let fragmentBytes = 0
  let messageId: number | undefined
  let nextIndex = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let failed = false

  const clearTimer = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined } }
  const clearAssembly = () => {
    prefix = Buffer.alloc(4); prefixBytes = 0; body = null; bodyBytes = 0
    fragments = []; fragmentBytes = 0; messageId = undefined; nextIndex = 0
  }
  const report = (reason: string) => { try { onError(reason) } catch {} }
  const fault = (reason: string) => {
    if (failed) return
    failed = true; clearTimer(); clearAssembly(); report(reason)
  }
  const armTimer = () => {
    clearTimer(); timer = setTimeout(() => fault('frame assembly timed out'), FRAME_IDLE_TIMEOUT_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }
  const finiteJson = (value: unknown): boolean => {
    const pending: unknown[] = [value]
    while (pending.length) {
      const current = pending.pop()
      if (typeof current === 'number' && !Number.isFinite(current)) return false
      if (Array.isArray(current)) for (const item of current) pending.push(item)
      else if (isPlainRecord(current)) for (const item of Object.values(current)) pending.push(item)
    }
    return true
  }
  const consumeFrame = (payload: Buffer) => {
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) }
    catch { fault('invalid frame JSON'); return }
    if (!isPlainRecord(parsed) || !hasExactKeys(parsed, ['id', 'index', 'final', 'data'])) { fault('invalid frame schema'); return }
    const id = parsed.id
    const index = parsed.index
    if (!Number.isSafeInteger(id) || (id as number) <= 0 || !Number.isSafeInteger(index) || (index as number) < 0
      || typeof parsed.final !== 'boolean' || typeof parsed.data !== 'string') {
      fault('invalid frame fields'); return
    }
    let chunk: Buffer
    try { chunk = Buffer.from(parsed.data, 'base64') } catch { fault('invalid base64'); return }
    if (chunk.length === 0 || chunk.toString('base64') !== parsed.data || chunk.length > FRAME_CHUNK_BYTES
      || (!parsed.final && chunk.length !== FRAME_CHUNK_BYTES)) {
      fault('invalid frame chunk'); return
    }
    if (messageId === undefined) {
      if (index !== 0) { fault('invalid frame order'); return }
      messageId = id as number
    } else if (id !== messageId || index !== nextIndex) {
      fault('interleaved or out-of-order frame'); return
    }
    if (fragmentBytes + chunk.length > MESSAGE_MAX_BYTES) { fault('logical message exceeds limit'); return }
    fragments.push(chunk); fragmentBytes += chunk.length; nextIndex++
    if (!parsed.final) return
    let value: unknown; try {
      const source = Buffer.concat(fragments, fragmentBytes); clearTimer(); clearAssembly()
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source))
      if (!finiteJson(value)) throw new Error('non-finite JSON number')
    } catch { fault('invalid logical JSON'); return }
    try { onValue(value as Json) } catch { fault('value callback failed') }
  }
  const push = (bytes: Uint8Array) => {
    if (failed || bytes.length === 0) return
    let offset = 0
    while (offset < bytes.length && !failed) {
      if (body === null) {
        const take = Math.min(4 - prefixBytes, bytes.length - offset)
        prefix.set(bytes.subarray(offset, offset + take), prefixBytes)
        prefixBytes += take; offset += take
        if (prefixBytes < 4) continue
        const length = prefix[0] * 0x1000000 + prefix[1] * 0x10000 + prefix[2] * 0x100 + prefix[3]
        if (length > FRAME_MAX_BYTES) { fault('frame body exceeds limit'); return }
        body = Buffer.alloc(length); bodyBytes = 0
      }
      const take = Math.min(body.length - bodyBytes, bytes.length - offset)
      body.set(bytes.subarray(offset, offset + take), bodyBytes)
      bodyBytes += take; offset += take
      if (bodyBytes === body.length) {
        const complete = body; body = null; bodyBytes = 0; prefixBytes = 0; consumeFrame(complete)
      }
    }
    if (!failed && (prefixBytes > 0 || body !== null || fragments.length > 0)) armTimer()
  }
  const reset = () => { clearTimer(); clearAssembly(); failed = false }
  return { push, reset }
}
