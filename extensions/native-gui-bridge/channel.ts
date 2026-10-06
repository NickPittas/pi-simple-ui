import { Buffer } from 'node:buffer'
import { connect, type Socket } from 'node:net'
import { createFrameDecoder, encodeFrame, QUEUE_MAX_BYTES } from '../../src/shared/native-pi-frame.ts'
import type { NativeBridgeRequest, NativeModelStateResult, NativePiAck, NativePiEnvelope, NativePiSnapshot, NativeSessionsResult, SetModelRequest, SetThinkingRequest, SnapshotRequest, SubmitRequest } from '../../src/shared/native-pi.ts'
import { isNativePiAck, isNativePiControlReply, isNativePiControlRequest, isNativePiEnvelope, isNativePiSnapshot, isSnapshotRequest, isSubmitRequest } from '../../src/shared/native-pi-validation.ts'
import { hasExactKeys, isPlainRecord } from '../../src/shared/ipc-contracts.ts'

type Decoder = ReturnType<typeof createFrameDecoder>
export type DesktopChannelHandlers = {
  onSnapshotRequest(payload: SnapshotRequest): Promise<NativePiSnapshot>
  onSubmitRequest(payload: SubmitRequest): Promise<NativePiAck>
  onModelStateRequest?(payload: Record<string, never>): Promise<NativeModelStateResult>
  onSetModelRequest?(payload: SetModelRequest): Promise<NativePiAck>
  onSetThinkingRequest?(payload: SetThinkingRequest): Promise<NativePiAck>
  onSessionsListRequest?(payload: Record<string, never>): Promise<NativeSessionsResult>
}
export type DesktopChannel = { publish(event: NativePiEnvelope): void; close(): void }

export function connectDesktopChannel(
  env: Record<string, string | undefined>, handlers: DesktopChannelHandlers,
  onLoss: (reason: string) => void,
): Promise<DesktopChannel | null> {
  const path = env.PI_GUI_SOCKET, capability = env.PI_GUI_CAPABILITY, rawGeneration = env.PI_GUI_PROCESS_GENERATION
  if (!path || !capability || !rawGeneration || !/^(0|[1-9]\d*)$/.test(rawGeneration)) return Promise.resolve(null)
  const generation = Number(rawGeneration)
  if (!Number.isSafeInteger(generation) || !/^[A-Za-z0-9_-]{43}$/.test(capability)) return Promise.resolve(null)
  let decoded: Buffer
  try { decoded = Buffer.from(capability, 'base64url') } catch { return Promise.resolve(null) }
  if (decoded.length !== 32 || decoded.toString('base64url') !== capability) return Promise.resolve(null)

  return new Promise(resolve => {
    let socket: Socket | undefined, decoder: Decoder | undefined
    let handshake: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined
    let closed = false, settled = false, ready = false, retries = 0, inboundBytes = 0, work = 0
    const report = (reason: string) => { try { onLoss(reason) } catch {} }
    const clearTimers = () => { if (handshake) clearTimeout(handshake); if (retry) clearTimeout(retry); handshake = retry = undefined }
    const finishInitial = (channel: DesktopChannel | null) => { if (!settled) { settled = true; resolve(channel) } }
    const stopSocket = (s: Socket) => { if (decoder) decoder.reset(); decoder = undefined; s.destroy() }
    const shutdown = () => { if (closed) return; closed = true; clearTimers(); ready = false; const s = socket; socket = undefined; if (s) stopSocket(s) }
    const lose = (reason: string) => { report(reason); shutdown(); finishInitial(null) }
    const send = (s: Socket, value: unknown): boolean => {
      try {
        const frame = encodeFrame(value)
        if (s.destroyed || s.writableLength + frame.byteLength > QUEUE_MAX_BYTES) return false
        s.write(frame); return true
      } catch { return false }
    }
    const retryConnect = () => {
      if (closed) return
      if (retries >= 5) { closed = true; finishInitial(null); return }
      retries++
      retry = setTimeout(open, 1_000)
      ;(retry as unknown as { unref?: () => void }).unref?.()
    }
    const protocolFailure = (s: Socket, reason: string) => {
      if (s !== socket || closed) return
      if (ready) { ready = false; report(reason); socket = undefined; stopSocket(s); retryConnect() }
      else lose(reason)
    }
    const failure = (operation: unknown, payload: unknown, reason: string): NativePiAck | NativeModelStateResult | NativeSessionsResult => {
      if (operation === 'model-state') return { state: null, error: reason }
      if (operation === 'sessions-list') return { sessions: [], error: reason }
      return { requestId: (payload as { requestId: string }).requestId, outcome: 'rejected', reason }
    }
    const snapshotFailure = (reason: string): NativePiSnapshot => {
      const generation = Number(env.PI_GUI_PROCESS_GENERATION)
      return { snapshotId: 'error', processGeneration: Number.isSafeInteger(generation) && generation >= 0 ? generation : 0, sequence: 0, state: 'gap', rootSessionId: null, sessions: [], nextCursor: null, error: reason }
    }
    const dispatch = async (s: Socket, value: Record<string, unknown>) => {
      const submit = value.operation === 'submit'
      const control = isNativePiControlRequest(value)
      const payload = value.payload
      if (!isPlainRecord(value) || !hasExactKeys(value, ['requestId', 'operation', 'payload'])
        || typeof value.requestId !== 'string' || !value.requestId
        || (value.operation === 'snapshot' ? !isSnapshotRequest(payload) : submit ? !isSubmitRequest(payload) : !control)) {
        protocolFailure(s, 'invalid native request'); return
      }
      const requestId = value.requestId
      if (work >= 16) {
        if (submit || control) reply(s, requestId, failure(value.operation, payload, 'handler capacity exceeded'))
        else reply(s, requestId, snapshotFailure('handler capacity exceeded'))
        return
      }
      work++
      try {
        const result = value.operation === 'snapshot' ? await handlers.onSnapshotRequest(payload as SnapshotRequest)
          : submit ? await handlers.onSubmitRequest(payload as SubmitRequest)
            : value.operation === 'model-state' ? await (handlers.onModelStateRequest?.(payload as Record<string, never>) ?? Promise.resolve(failure(value.operation, payload, 'handler unavailable') as NativeModelStateResult))
              : value.operation === 'set-model' ? await (handlers.onSetModelRequest?.(payload as SetModelRequest) ?? Promise.resolve(failure(value.operation, payload, 'handler unavailable')))
                : value.operation === 'set-thinking' ? await (handlers.onSetThinkingRequest?.(payload as SetThinkingRequest) ?? Promise.resolve(failure(value.operation, payload, 'handler unavailable')))
                  : await (handlers.onSessionsListRequest?.(payload as Record<string, never>) ?? Promise.resolve(failure(value.operation, payload, 'handler unavailable') as NativeSessionsResult))
        if (s !== socket || closed || !ready) return
        const valid = value.operation === 'snapshot' ? isNativePiSnapshot(result)
          : submit ? isNativePiAck(result) && result.requestId === (payload as SubmitRequest).requestId
            : isNativePiControlReply(value as Extract<NativeBridgeRequest, { operation: 'model-state' | 'set-model' | 'set-thinking' | 'sessions-list' }>, result)
        if (!valid) {
          if (submit || control) reply(s, requestId, failure(value.operation, payload, 'invalid handler result'))
          else reply(s, requestId, snapshotFailure('invalid snapshot handler result'))
        } else reply(s, requestId, result)
      } catch {
        if (s === socket && ready) {
          if (submit || control) reply(s, requestId, failure(value.operation, payload, 'handler failed'))
          else reply(s, requestId, snapshotFailure('snapshot handler failed'))
        }
      } finally { work-- }
    }
    const reply = (s: Socket, requestId: string, value: NativePiAck | NativePiSnapshot | NativeModelStateResult | NativeSessionsResult) => {
      if (!send(s, { requestId, value })) protocolFailure(s, 'native reply write failed')
    }
    function open() {
      if (closed) return
      inboundBytes = 0; ready = false
      const s = socket = connect(path)
      decoder = createFrameDecoder(value => {
        if (s !== socket || closed) return
        if (!ready) {
          if (!isPlainRecord(value) || !hasExactKeys(value, ['version', 'processGeneration', 'ready'])
            || value.version !== 1 || value.processGeneration !== generation || value.ready !== true) return protocolFailure(s, 'invalid native handshake')
          ready = true; if (handshake) clearTimeout(handshake); handshake = undefined
          if (retries === 0) finishInitial(channel)
          return
        }
        if (!isPlainRecord(value) || !hasExactKeys(value, ['requestId', 'operation', 'payload'])) return protocolFailure(s, 'invalid native request')
        void dispatch(s, value)
      }, () => protocolFailure(s, 'native frame decoding failed'))
      s.on('connect', () => {
        if (s !== socket || closed) return
        handshake = setTimeout(() => protocolFailure(s, 'native handshake timed out'), 5_000)
        ;(handshake as unknown as { unref?: () => void }).unref?.()
        if (!send(s, { version: 1, capability, processGeneration: generation })) protocolFailure(s, 'native hello write failed')
      })
      s.on('data', bytes => {
        if (s !== socket || closed) return
        if (!ready && (inboundBytes += bytes.byteLength) > 4096) return protocolFailure(s, 'native handshake byte limit exceeded')
        try { decoder?.push(bytes) } catch { protocolFailure(s, 'native frame decoding failed') }
      })
      s.on('error', () => protocolFailure(s, 'native socket error'))
      s.on('close', () => {
        if (s !== socket || closed) return
        if (ready) { ready = false; report('native channel disconnected'); socket = undefined; if (decoder) decoder.reset(); decoder = undefined; retryConnect() }
        else protocolFailure(s, 'native handshake closed')
      })
    }
    const channel: DesktopChannel = {
      publish(event) {
        try {
          if (closed || !ready || !socket || !isNativePiEnvelope(event) || event.processGeneration !== generation) return
          if (!send(socket, event)) protocolFailure(socket, 'native event write failed')
        } catch { if (socket) protocolFailure(socket, 'native event write failed') }
      },
      close: shutdown,
    }
    open()
  })
}
