import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { TextDecoder } from 'node:util'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import {
  type ChatAbortResponse,
  type ChatAttachment,
  type ChatLifecyclePayload,
  type ChatPromptRequest,
  type ChatPromptResponse,
  type ChatQueueClearedResponse,
  type ChatQueueInputRequest,
  type ChatQueueResponse,
} from '../../shared/chat.ts'
import { canonicalFileWithinRoot } from '../security/window-policy.ts'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'
import {
  RuntimeOperations,
  type RuntimeOperationRuntime,
} from './runtime-operations.ts'

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_ATTACHMENT_TOTAL_BYTES = 16 * 1024 * 1024

type SessionImage = { readonly type: 'image'; readonly data: string; readonly mimeType: string }

function callerKey(caller: AuthorizedIpcCaller): string {
  return `${caller.windowId}:${caller.webContentsId}:${caller.frameUrl}`
}

function emptyQueue(session: RuntimeOperationRuntime['host']['session']): ChatQueueResponse {
  const steering = [...session.getSteeringMessages()]
  const followUp = [...session.getFollowUpMessages()]
  return { steering, followUp, pending: session.pendingMessageCount }
}

function detectImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif'
  if (bytes.length >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

function isTextExtension(path: string): boolean {
  return new Set(['.txt', '.md', '.markdown', '.csv', '.log', '.json', '.yaml', '.yml']).has(extname(path).toLowerCase())
}

async function readAttachments(
  runtime: RuntimeOperationRuntime,
  attachments: readonly ChatAttachment[] | undefined,
): Promise<readonly SessionImage[]> {
  const images: SessionImage[] = []
  let textAttachmentFound = false
  let totalBytes = 0
  for (const attachment of attachments ?? []) {
    const canonicalPath = canonicalFileWithinRoot(attachment.path, runtime.workspaceRoot)
    if (!canonicalPath) throw new Error('An attachment is missing or outside the active workspace.')
    let fileSize: number
    try {
      const metadata = await stat(canonicalPath)
      if (!metadata.isFile()) throw new Error('Not a regular file.')
      fileSize = metadata.size
    } catch {
      throw new Error('An attachment could not be read.')
    }
    if (fileSize > MAX_ATTACHMENT_BYTES || totalBytes + fileSize > MAX_ATTACHMENT_TOTAL_BYTES) {
      throw new Error('An attachment exceeds the size limit.')
    }
    let bytes: Buffer
    try {
      bytes = await readFile(canonicalPath)
    } catch {
      throw new Error('An attachment could not be read.')
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('An attachment exceeds the size limit.')
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error('Attachments exceed the total size limit.')
    if (attachment.type === 'image') {
      const mimeType = detectImageMime(bytes)
      if (!mimeType) throw new Error('An image attachment has an unsupported or invalid format.')
      images.push({ type: 'image', data: bytes.toString('base64'), mimeType })
    } else {
      if (!isTextExtension(canonicalPath)) throw new Error('A text attachment must use a supported text-file extension.')
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new Error('A text attachment is not valid UTF-8.')
      }
      textAttachmentFound = true
    }
  }
  if (textAttachmentFound) {
    // The current public Pi SDK accepts images in PromptOptions but has no text-file
    // attachment API. Do not silently inline files or claim they were attached.
    throw new Error('Text-file attachments are not supported by the current Pi SDK.')
  }
  return images
}

export class ChatInputService {
  private readonly turnCaller = new Map<string, string>()
  private readonly queueCaller = new Map<string, string>()

  constructor(readonly operations: RuntimeOperations) {}

  async prompt(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: ChatPromptRequest): Promise<ChatPromptResponse> {
    const key = callerKey(caller)
    const result = await this.operations.admit(scope, key, async (runtime, gate) => {
      const images = await readAttachments(runtime, request.attachments)
      const session = runtime.host.session
      if (session.isStreaming && request.text.startsWith('/')) {
        throw new Error('Extension commands cannot be submitted while the agent is running.')
      }
      if (!gate.commit()) return null
      this.setInputOwner(runtime, key, true)
      const options = {
        ...(request.streamingBehavior ? { streamingBehavior: request.streamingBehavior } : {}),
        ...(images.length > 0 ? { images: [...images] } : {}),
        source: 'interactive' as const,
      }
      return { completion: session.prompt(request.text, options).then(() => undefined) }
    })
    return { accepted: result.status === 'completed' }
  }

  async steer(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: ChatQueueInputRequest): Promise<ChatPromptResponse> {
    return this.queueInput(caller, scope, request, 'steer')
  }

  async followUp(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: ChatQueueInputRequest): Promise<ChatPromptResponse> {
    return this.queueInput(caller, scope, request, 'followUp')
  }

  async abort(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<ChatAbortResponse> {
    return { stopped: await this.operations.stop(scope, callerKey(caller)) }
  }

  readQueue(scope: RuntimeScope): ChatQueueResponse {
    const runtime = this.requireRuntime(scope)
    return emptyQueue(runtime.host.session)
  }

  clearQueue(scope: RuntimeScope): ChatQueueClearedResponse {
    const runtime = this.requireRuntime(scope)
    const cleared = runtime.host.session.clearQueue()
    return {
      cleared: {
        steering: cleared.steering,
        followUp: cleared.followUp,
        pending: 0,
      },
    }
  }

  subscribe(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    publish: (payload: ChatLifecyclePayload) => void,
  ): () => void {
    const runtime = this.requireRuntime(scope)
    const key = callerKey(caller)
    return runtime.host.session.subscribe((event) => {
      const currentRuntime = this.operations.resolve(scope)
      if (!currentRuntime || currentRuntime.runtimeId !== runtime.runtimeId || currentRuntime.host !== runtime.host) return
      let payload: ChatLifecyclePayload | undefined
      if (event.type === 'agent_start') {
        const queuedOwner = this.queueCaller.get(runtime.runtimeId)
        if (queuedOwner) this.turnCaller.set(runtime.runtimeId, queuedOwner)
        payload = { runtime: scope, event: { type: 'agent-started' } }
      } else if (event.type === 'turn_start') {
        payload = { runtime: scope, event: { type: 'turn-started' } }
      } else if (event.type === 'turn_end') {
        payload = { runtime: scope, event: { type: 'turn-ended' } }
      } else if (event.type === 'agent_end') {
        payload = { runtime: scope, event: { type: 'agent-ended' } }
      } else if (event.type === 'agent_settled') {
        payload = { runtime: scope, event: { type: 'settled' } }
      } else if (event.type === 'queue_update') {
        payload = {
          runtime: scope,
          event: { type: 'queue-updated', steering: [...event.steering], followUp: [...event.followUp] },
        }
      }
      if (!payload) return
      const owner = payload.event.type === 'queue-updated'
        ? this.queueCaller.get(runtime.runtimeId)
        : this.turnCaller.get(runtime.runtimeId)
      if (owner !== key) return
      try {
        publish(payload)
      } catch {
        // Main-owned event observers cannot disrupt session event delivery.
      }
      if (payload.event.type === 'settled') {
        queueMicrotask(() => {
          if (this.turnCaller.get(runtime.runtimeId) !== owner) return
          this.turnCaller.delete(runtime.runtimeId)
          this.queueCaller.delete(runtime.runtimeId)
        })
      }
    })
  }

  private async queueInput(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    request: ChatQueueInputRequest,
    behavior: 'steer' | 'followUp',
  ): Promise<ChatPromptResponse> {
    const key = callerKey(caller)
    const result = await this.operations.admit(scope, key, async (runtime, gate) => {
      const images = await readAttachments(runtime, request.attachments)
      if (!gate.commit()) return null
      this.setInputOwner(runtime, key, false)
      const completion = behavior === 'steer'
        ? runtime.host.session.steer(request.text, images.length > 0 ? [...images] : undefined, { source: 'interactive' })
        : runtime.host.session.followUp(request.text, images.length > 0 ? [...images] : undefined, { source: 'interactive' })
      return { completion: completion.then(() => undefined) }
    })
    return { accepted: result.status === 'completed' }
  }

  private setInputOwner(runtime: RuntimeOperationRuntime, key: string, prompt: boolean): void {
    this.queueCaller.set(runtime.runtimeId, key)
    if (prompt && !runtime.host.session.isStreaming) this.turnCaller.set(runtime.runtimeId, key)
  }

  private requireRuntime(scope: RuntimeScope): RuntimeOperationRuntime {
    const runtime = this.operations.resolve(scope)
    if (!runtime) throw new Error('The runtime scope is no longer current.')
    return runtime
  }
}
