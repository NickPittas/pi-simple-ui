import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFrameDecoder, encodeFrame, QUEUE_MAX_BYTES } from '../../shared/native-pi-frame.ts'
import type { NativeBridgeCommand, NativeBridgeReply, NativeBridgeRequest, NativePiEnvelope, NativeTransportStatus, Stop } from '../../shared/native-pi.ts'
import { isNativePiAck, isNativePiControlCommand, isNativePiControlReply, isNativePiEnvelope, isNativePiSnapshot, isSnapshotRequest, isSubmitRequest } from '../../shared/native-pi-validation.ts'
import { hasExactKeys, isPlainRecord } from '../../shared/ipc-contracts.ts'

type Decoder = ReturnType<typeof createFrameDecoder>
type Peer = {
  socket: Socket
  decoder: Decoder
  authenticated: boolean
  handshake: ReturnType<typeof setTimeout>
  bytes: number
  closed: boolean
}

export type NativeChannel = {
  readonly environment: Readonly<Record<string, string>>
  subscribe(listener: (event: NativePiEnvelope) => void): Stop
  onStatus(listener: (status: NativeTransportStatus) => void): Stop
  request(command: NativeBridgeCommand): Promise<NativeBridgeReply>
  dispose(): Promise<void>
}

export async function createNativeChannel(processGeneration: number): Promise<NativeChannel> {
  if (!Number.isSafeInteger(processGeneration) || processGeneration < 0) throw new RangeError('invalid process generation')
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-'))
  let server: Server | undefined
  const peers = new Set<Peer>()
  const listeners = new Set<(event: NativePiEnvelope) => void>()
  const statusListeners = new Set<(status: NativeTransportStatus) => void>()
  const pending = new Map<string, { peer: Peer; request: NativeBridgeRequest; timer: ReturnType<typeof setTimeout>; resolve: (reply: NativeBridgeReply) => void; reject: (error: Error) => void }>()
  let active: Peer | undefined
  let disposed = false
  let transportState: NativeTransportStatus['state'] = 'waiting'
  const emitStatus = (state: NativeTransportStatus['state'], reason: string | null) => {
    transportState = state
    const status = { processGeneration, state, reason }
    for (const listener of [...statusListeners]) try { listener(status) } catch {}
  }
  const capability = randomBytes(32).toString('base64url')
  const capabilityBytes = Buffer.from(capability, 'utf8')
  const environment = Object.freeze({
    PI_GUI_SOCKET: join(directory, 'bridge.sock'),
    PI_GUI_CAPABILITY: capability,
    PI_GUI_PROCESS_GENERATION: String(processGeneration),
  })
  const closePeer = (peer: Peer) => {
    if (peer.closed) return
    peer.closed = true
    clearTimeout(peer.handshake)
    peer.decoder.reset()
    peers.delete(peer)
    for (const [requestId, entry] of pending) if (entry.peer === peer) {
      clearTimeout(entry.timer); pending.delete(requestId); entry.reject(new Error('native request lost: peer disconnected'))
    }
    if (active === peer) { active = undefined; if (!disposed) emitStatus('disconnected', 'peer closed') }
  }
  const rejectPeer = (peer: Peer) => { peer.socket.destroy() }
  const writeFrame = (peer: Peer, frame: Uint8Array) => {
    if (peer.socket.writableLength + frame.byteLength <= QUEUE_MAX_BYTES) { peer.socket.write(frame); return true }
    rejectPeer(peer); return false
  }
  const onValue = (peer: Peer, value: unknown) => {
    if (disposed || peer.closed) return rejectPeer(peer)
    if (peer.authenticated && isPlainRecord(value) && ('requestId' in value || 'value' in value)) {
      if (!hasExactKeys(value, ['requestId', 'value']) || typeof value.requestId !== 'string' || value.requestId.length === 0) return rejectPeer(peer)
      const entry = pending.get(value.requestId)
      if (!entry || entry.peer !== peer) return rejectPeer(peer)
      const valid = entry.request.operation === 'snapshot' ? isNativePiSnapshot(value.value)
        : entry.request.operation === 'submit' ? isNativePiAck(value.value) && value.value.requestId === entry.request.payload.requestId
          : isNativePiControlReply(entry.request as Extract<NativeBridgeRequest, { operation: 'model-state' | 'set-model' | 'set-thinking' | 'sessions-list' | 'commands-list' | 'abort' }>, value.value)
      if (!valid) return rejectPeer(peer)
      clearTimeout(entry.timer); pending.delete(value.requestId); entry.resolve({ requestId: value.requestId, value: value.value as NativeBridgeReply['value'] })
      return
    }
    if (!peer.authenticated) {
      if (!isPlainRecord(value) || !hasExactKeys(value, ['version', 'capability', 'processGeneration'])
        || value.version !== 1 || typeof value.capability !== 'string' || value.processGeneration !== processGeneration) return rejectPeer(peer)
      const incoming = Buffer.from(value.capability, 'utf8')
      if (incoming.length !== capabilityBytes.length || !timingSafeEqual(incoming, capabilityBytes)) return rejectPeer(peer)
      if (active && active !== peer) return rejectPeer(peer)
      const ready = encodeFrame({ version: 1, processGeneration, ready: true })
      if (!writeFrame(peer, ready)) return
      clearTimeout(peer.handshake)
      peer.authenticated = true
      active = peer
      emitStatus('connected', null)
      return
    }
    if (!isNativePiEnvelope(value) || value.processGeneration !== processGeneration) return rejectPeer(peer)
    for (const listener of [...listeners]) try { listener(value) } catch {}
  }
  const accept = (socket: Socket) => {
    if (disposed || peers.size >= 4) return socket.destroy()
    const peer = { socket, decoder: undefined as unknown as Decoder, authenticated: false, handshake: undefined as unknown as ReturnType<typeof setTimeout>, bytes: 0, closed: false }
    peer.decoder = createFrameDecoder(value => onValue(peer, value), () => rejectPeer(peer))
    peer.handshake = setTimeout(() => rejectPeer(peer), 5_000)
    ;(peer.handshake as unknown as { unref?: () => void }).unref?.()
    peers.add(peer)
    socket.on('data', bytes => {
      if (disposed || peer.closed) return rejectPeer(peer)
      if (!peer.authenticated && (peer.bytes += bytes.byteLength) > 4096) return rejectPeer(peer)
      try { peer.decoder.push(bytes) } catch { rejectPeer(peer) }
    })
    socket.on('error', () => { closePeer(peer); rejectPeer(peer) })
    socket.on('close', () => closePeer(peer))
  }
  const closeServer = async () => {
    if (!server || !server.listening) return
    await new Promise<void>(resolve => server!.close(() => resolve()))
  }
  const cleanup = async () => {
    disposed = true
    emitStatus('disposed', null)
    statusListeners.clear()
    listeners.clear()
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timer); pending.delete(requestId); entry.reject(new Error('native channel disposed'))
    }
    for (const peer of [...peers]) { closePeer(peer); peer.socket.destroy() }
    await closeServer()
    await rm(directory, { recursive: true, force: true })
  }
  try {
    await chmod(directory, 0o700)
    server = createServer(accept)
    server.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      const listening = () => { server!.off('error', failed); resolve() }
      const failed = (error: Error) => { server!.off('listening', listening); reject(error) }
      server!.once('listening', listening)
      server!.once('error', failed)
      server!.listen(environment.PI_GUI_SOCKET)
    })
    await chmod(environment.PI_GUI_SOCKET, 0o600)
  } catch (error) {
    try { await cleanup() } catch {}
    throw error
  }
  let disposePromise: Promise<void> | undefined
  return {
    environment,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onStatus(listener) {
      if (disposed) return () => {}
      statusListeners.add(listener)
      try { listener({ processGeneration, state: transportState, reason: transportState === 'disconnected' ? 'peer closed' : null }) } catch {}
      return () => { statusListeners.delete(listener) }
    },
    request(command) {
      if (disposed) return Promise.reject(new Error('native channel disposed'))
      const peer = active
      if (!peer || peer.closed || !peer.authenticated) return Promise.reject(new Error('native channel not connected'))
      if (pending.size >= 32) return Promise.reject(new Error('native request limit exceeded'))
      const valid = command?.operation === 'snapshot' ? isSnapshotRequest(command.payload)
        : command?.operation === 'submit' ? isSubmitRequest(command.payload) : isNativePiControlCommand(command)
      if (!valid) return Promise.reject(new Error('invalid native request'))
      const requestId = randomUUID()
      // Plan rule: new mutations preserve payload requestId; only submit substitutes the transport ID.
      const payload = command.operation === 'submit' ? { ...command.payload, requestId } : command.payload
      const request = { requestId, operation: command.operation, payload } as NativeBridgeRequest
      let frame: Uint8Array
      try { frame = encodeFrame(request) }
      catch (error) { return Promise.reject(error) }
      return new Promise<NativeBridgeReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId); reject(new Error('native request timed out'))
        }, 30_000)
        ;(timer as unknown as { unref?: () => void }).unref?.()
        pending.set(requestId, { peer, request, timer, resolve, reject })
        if (!writeFrame(peer, frame)) {
          const entry = pending.get(requestId)
          if (entry) { clearTimeout(timer); pending.delete(requestId); reject(new Error('native request lost: peer disconnected')) }
        }
      })
    },
    dispose() {
      if (!disposePromise) disposePromise = cleanup()
      return disposePromise
    },
  }
}
