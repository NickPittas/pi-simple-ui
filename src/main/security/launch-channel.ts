import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isLaunchExchangeRequest,
  isLaunchExchangeResponse,
  isLaunchScopeDescriptor,
  type LaunchExchangeResponse,
  type LaunchScopeDescriptor,
} from '../../shared/launch.ts'

const TOKEN_VERSION = 'v1'
const MAX_REQUEST_BYTES = 2_048
const MAX_RESPONSE_BYTES = 32 * 1024
const EXCHANGE_TIMEOUT_MS = 5_000
const MAX_ACTIVE_TOKENS = 4_096

interface IssuedLaunch {
  readonly signature: Buffer
  readonly serializedDescriptor: string
  readonly expiresAt: number
  readonly isRevoked: () => boolean
  used: boolean
}

export interface IssuedLaunchToken {
  readonly token: string
  readonly endpoint: string
  revoke(): void
}

export interface LaunchChannel {
  readonly endpoint: string
  issue(descriptor: LaunchScopeDescriptor, isRevoked?: () => boolean): IssuedLaunchToken
  close(): Promise<void>
}

function endpointFor(platform: NodeJS.Platform, directory: string): string {
  if (platform === 'win32') return `\\\\.\\pipe\\pi-desktop-launch-${randomBytes(18).toString('hex')}`
  return join(directory, 'launch.sock')
}

function copyDescriptor(descriptor: LaunchScopeDescriptor): LaunchScopeDescriptor {
  const copy = JSON.parse(JSON.stringify(descriptor)) as LaunchScopeDescriptor
  Object.freeze(copy.runtimeScope)
  Object.freeze(copy.resourceConstraints)
  if (copy.herdr) Object.freeze(copy.herdr)
  return Object.freeze(copy)
}

function isLocalEndpoint(endpoint: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return endpoint.startsWith('\\\\.\\pipe\\')
  return endpoint.startsWith('/') && !endpoint.includes('\0')
}

function exchangeResponse(
  token: string,
  key: Buffer,
  issued: Map<string, IssuedLaunch>,
  now: number,
): LaunchExchangeResponse {
  const [, nonce, suppliedSignature] = token.split('.')
  if (!nonce || !suppliedSignature) return { outcome: 'rejected', reason: 'invalid' }
  const launch = issued.get(nonce)
  if (!launch) return { outcome: 'rejected', reason: 'invalid' }
  if (launch.used) return { outcome: 'rejected', reason: 'used' }

  const expected = createHmac('sha256', key)
    .update(nonce)
    .update('\0')
    .update(launch.serializedDescriptor)
    .digest()
  const supplied = Buffer.from(suppliedSignature, 'base64url')
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)
    || !timingSafeEqual(expected, launch.signature)) {
    return { outcome: 'rejected', reason: 'invalid' }
  }

  // Consume before checking policy, so a revoked capability cannot be retried.
  launch.used = true
  if (now >= launch.expiresAt) return { outcome: 'rejected', reason: 'expired' }
  try {
    if (launch.isRevoked()) return { outcome: 'rejected', reason: 'revoked' }
  } catch {
    return { outcome: 'rejected', reason: 'revoked' }
  }
  return {
    outcome: 'granted',
    descriptor: JSON.parse(launch.serializedDescriptor) as LaunchScopeDescriptor,
  }
}

/**
 * Create a process-local HMAC capability channel. Unix endpoints are private
 * domain sockets; Windows uses a random named pipe. No TCP listener or durable
 * key/token storage is used.
 */
export async function createLaunchChannel(options: {
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
} = {}): Promise<LaunchChannel> {
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now
  const directory = platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'pi-launch-'))
  if (directory) chmodSync(directory, 0o700)
  const endpoint = endpointFor(platform, directory ?? '')
  const key = randomBytes(32)
  const issued = new Map<string, IssuedLaunch>()
  const sockets = new Set<Socket>()
  let closed = false
  let failed = false

  const server: Server = createServer((socket) => {
    if (closed || failed || sockets.size >= 64) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.setTimeout(EXCHANGE_TIMEOUT_MS, () => socket.destroy())
    let received = ''
    let finished = false
    const finish = (response?: LaunchExchangeResponse): void => {
      if (finished) return
      finished = true
      if (response) socket.end(`${JSON.stringify(response)}\n`)
      else socket.destroy()
    }
    socket.on('data', (chunk: Buffer) => {
      if (finished) return
      received += chunk.toString('utf8')
      if (Buffer.byteLength(received, 'utf8') > MAX_REQUEST_BYTES) {
        finish({ outcome: 'rejected', reason: 'invalid' })
        return
      }
      const newline = received.indexOf('\n')
      if (newline < 0) return
      if (newline !== received.length - 1) {
        finish({ outcome: 'rejected', reason: 'invalid' })
        return
      }
      try {
        const request: unknown = JSON.parse(received.slice(0, newline))
        if (!isLaunchExchangeRequest(request)) {
          finish({ outcome: 'rejected', reason: 'invalid' })
          return
        }
        const token: string = request.token
        finish(exchangeResponse(token, key, issued, now()))
      } catch {
        finish({ outcome: 'rejected', reason: 'invalid' })
      }
    })
    socket.on('error', () => finish())
    socket.on('close', () => sockets.delete(socket))
  })
  server.maxConnections = 64
  server.on('error', () => {
    failed = true
    issued.clear()
    key.fill(0)
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(endpoint)
    })
    if (directory) chmodSync(endpoint, 0o600)
  } catch (error) {
    if (directory) rmSync(directory, { recursive: true, force: true })
    key.fill(0)
    throw error
  }

  return {
    endpoint,
    issue(descriptor, isRevoked = () => false): IssuedLaunchToken {
      if (closed || failed) throw new Error('The child launch channel is unavailable.')
      if (!isLaunchScopeDescriptor(descriptor)) throw new TypeError('The child launch descriptor is invalid.')
      const issuedAt = now()
      if (descriptor.issuedAt > issuedAt
        || issuedAt - descriptor.issuedAt > 60_000
        || descriptor.expiresAt <= issuedAt
        || descriptor.expiresAt - issuedAt > 60_000) {
        throw new TypeError('The child launch descriptor expiry is invalid.')
      }
      for (const [nonce, entry] of issued) {
        if (entry.expiresAt + 60_000 <= issuedAt) issued.delete(nonce)
      }
      if (issued.size >= MAX_ACTIVE_TOKENS) throw new Error('Too many child launch capabilities are active.')

      const nonce = randomBytes(24).toString('base64url')
      const immutableDescriptor = copyDescriptor(descriptor)
      const serializedDescriptor = JSON.stringify(immutableDescriptor)
      const signature = createHmac('sha256', key)
        .update(nonce)
        .update('\0')
        .update(serializedDescriptor)
        .digest()
      const token = `${TOKEN_VERSION}.${nonce}.${signature.toString('base64url')}`
      const entry: IssuedLaunch = {
        signature,
        serializedDescriptor,
        expiresAt: descriptor.expiresAt,
        isRevoked,
        used: false,
      }
      issued.set(nonce, entry)

      return {
        token,
        endpoint,
        revoke(): void {
          entry.used = true
          issued.delete(nonce)
        },
      }
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      issued.clear()
      key.fill(0)
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
      })
      if (directory) rmSync(directory, { recursive: true, force: true })
    },
  }
}

/** Exchange one child-inherited token using a local socket endpoint. */
export function exchangeLaunchToken(
  endpoint: string,
  token: string,
  options: { readonly platform?: NodeJS.Platform; readonly timeoutMs?: number } = {},
): Promise<LaunchExchangeResponse> {
  const platform = options.platform ?? process.platform
  if (!isLocalEndpoint(endpoint, platform) || !isLaunchExchangeRequest({ token })) {
    return Promise.resolve({ outcome: 'rejected', reason: 'invalid' })
  }
  const timeoutMs = options.timeoutMs ?? EXCHANGE_TIMEOUT_MS
  return new Promise((resolve) => {
    const socket = createConnection(endpoint)
    let received = ''
    let settled = false
    const finish = (response: LaunchExchangeResponse): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(response)
    }
    socket.setTimeout(timeoutMs, () => finish({ outcome: 'rejected', reason: 'unavailable' }))
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token })}\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      if (settled) return
      received += chunk.toString('utf8')
      if (Buffer.byteLength(received, 'utf8') > MAX_RESPONSE_BYTES) {
        finish({ outcome: 'rejected', reason: 'invalid' })
        return
      }
      const newline = received.indexOf('\n')
      if (newline < 0) return
      if (newline !== received.length - 1) {
        finish({ outcome: 'rejected', reason: 'invalid' })
        return
      }
      try {
        const response: unknown = JSON.parse(received.slice(0, newline))
        finish(isLaunchExchangeResponse(response)
          ? response
          : { outcome: 'rejected', reason: 'invalid' })
      } catch {
        finish({ outcome: 'rejected', reason: 'invalid' })
      }
    })
    socket.on('error', () => finish({ outcome: 'rejected', reason: 'unavailable' }))
    socket.on('close', () => {
      if (!settled) finish({ outcome: 'rejected', reason: 'unavailable' })
    })
  })
}
