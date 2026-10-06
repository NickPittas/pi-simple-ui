import { createConnection, type Socket } from 'node:net'

export interface HerdrEndpoint {
  readonly socketPath: string
  readonly paneId: string
}

export type HerdrAgentState = 'working' | 'blocked' | 'idle'

interface HerdrSessionReference {
  readonly agent_session_path?: string
  readonly agent_session_id?: string
}

interface HerdrRequestBase {
  readonly id: string
  readonly method: 'pane.report_agent_session' | 'pane.report_agent'
}

export interface HerdrAgentSessionRequest extends HerdrRequestBase {
  readonly method: 'pane.report_agent_session'
  readonly params: {
    readonly pane_id: string
    readonly source: 'herdr:pi'
    readonly agent: 'pi'
    readonly seq: number
    readonly session_start_source?: string
  } & HerdrSessionReference
}

export interface HerdrAgentStateRequest extends HerdrRequestBase {
  readonly method: 'pane.report_agent'
  readonly params: {
    readonly pane_id: string
    readonly source: 'herdr:pi'
    readonly agent: 'pi'
    readonly seq: number
    readonly state: HerdrAgentState
    readonly message?: string
  } & HerdrSessionReference
}

export type HerdrAgentReportRequest = HerdrAgentSessionRequest | HerdrAgentStateRequest

export interface HerdrReportTransport {
  send(request: HerdrAgentReportRequest): Promise<boolean>
  dispose(): void
}

const MAX_SOCKET_PATH_LENGTH = 4_096
const MAX_PANE_ID_LENGTH = 256
const MAX_REQUEST_BYTES = 16_384
const ATTEMPT_TIMEOUTS_MS = [500, 1_500] as const

/** Read only the environment settings used by Herdr's installed Pi integration. */
export function resolveHerdrEndpoint(
  environment: NodeJS.ProcessEnv = process.env,
): HerdrEndpoint | undefined {
  const socketPath = environment.HERDR_SOCKET_PATH
  const paneId = environment.HERDR_PANE_ID
  if (environment.HERDR_ENV !== '1'
    || !socketPath
    || socketPath.trim().length === 0
    || socketPath.length > MAX_SOCKET_PATH_LENGTH
    || !paneId
    || paneId.trim().length === 0
    || paneId.length > MAX_PANE_ID_LENGTH) {
    return undefined
  }
  return { socketPath, paneId }
}

function endpointAddress(endpoint: HerdrEndpoint, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `\\\\.\\pipe\\${endpoint.socketPath}` : endpoint.socketPath
}

/** Send one newline-delimited request to the existing Herdr endpoint. */
export function createHerdrReportTransport(
  endpoint: HerdrEndpoint,
  platform: NodeJS.Platform = process.platform,
): HerdrReportTransport {
  const address = endpointAddress(endpoint, platform)
  const activeAttempts = new Map<Socket, () => void>()
  let disposed = false

  const attempt = (line: string, timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
    if (disposed) {
      resolve(false)
      return
    }

    let socket: Socket | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let done = false
    const finish = (delivered: boolean): void => {
      if (done) return
      done = true
      if (timeout) clearTimeout(timeout)
      if (socket) {
        activeAttempts.delete(socket)
        socket.destroy()
      }
      resolve(delivered && !disposed)
    }

    try {
      socket = createConnection(address)
    } catch {
      finish(false)
      return
    }
    activeAttempts.set(socket, () => finish(false))
    socket.on('error', () => finish(false))
    socket.on('connect', () => {
      try {
        socket?.write(line)
      } catch {
        finish(false)
      }
    })
    socket.on('data', () => finish(true))
    socket.on('end', () => finish(false))
    socket.on('close', () => finish(false))
    timeout = setTimeout(() => finish(false), timeoutMs)
    timeout.unref?.()
  })

  return {
    async send(request): Promise<boolean> {
      if (disposed) return false
      const serialized = `${JSON.stringify(request)}\n`
      if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) return false
      for (const timeoutMs of ATTEMPT_TIMEOUTS_MS) {
        if (disposed) return false
        if (await attempt(serialized, timeoutMs)) return true
      }
      return false
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const cancel of [...activeAttempts.values()]) cancel()
    },
  }
}
