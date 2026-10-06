import type { CapabilityDefinition, EventDefinition } from './register.ts'
import {
  hasExactKeys,
  isPlainRecord,
  isRuntimeScope,
  type RuntimeScope,
} from '../../shared/ipc-contracts.ts'
import {
  CHAT_IPC,
  type ChatAbortRequest,
  type ChatAbortResponse,
  type ChatAttachment,
  type ChatCapabilityContracts,
  type ChatLifecyclePayload,
  type ChatPromptRequest,
  type ChatPromptResponse,
  type ChatQueueClearedResponse,
  type ChatQueueInputRequest,
  type ChatQueueRequest,
  type ChatQueueResponse,
} from '../../shared/chat.ts'
import type { ChatInputService } from '../pi/input-service.ts'

const MAX_PROMPT_LENGTH = 200_000
const MAX_ATTACHMENT_COUNT = 8
const MAX_ATTACHMENT_PATH_LENGTH = 4096

export type ChatCapabilityDefinition = {
  [K in keyof ChatCapabilityContracts]: CapabilityDefinition<
    ChatCapabilityContracts[K]['request'],
    ChatCapabilityContracts[K]['response']
  >
}[keyof ChatCapabilityContracts]

function isAttachment(value: unknown): value is ChatAttachment {
  return isPlainRecord(value)
    && hasExactKeys(value, ['type', 'path'])
    && (value.type === 'text' || value.type === 'image')
    && typeof value.path === 'string'
    && value.path.length > 0
    && value.path.length <= MAX_ATTACHMENT_PATH_LENGTH
    && !value.path.includes('\0')
}

function isAttachmentList(value: unknown): value is readonly ChatAttachment[] {
  return Array.isArray(value) && value.length <= MAX_ATTACHMENT_COUNT && value.every(isAttachment)
}

function isPromptRequest(value: unknown): value is ChatPromptRequest {
  if (!isPlainRecord(value)) return false
  const keys = ['text']
  if (Object.hasOwn(value, 'streamingBehavior')) keys.push('streamingBehavior')
  if (Object.hasOwn(value, 'attachments')) keys.push('attachments')
  return hasExactKeys(value, keys)
    && typeof value.text === 'string'
    && value.text.length <= MAX_PROMPT_LENGTH
    && (!Object.hasOwn(value, 'streamingBehavior')
      || value.streamingBehavior === 'steer'
      || value.streamingBehavior === 'followUp')
    && (!Object.hasOwn(value, 'attachments') || isAttachmentList(value.attachments))
}

function isQueueInputRequest(value: unknown): value is ChatQueueInputRequest {
  if (!isPlainRecord(value)) return false
  const keys = Object.hasOwn(value, 'attachments') ? ['text', 'attachments'] : ['text']
  return hasExactKeys(value, keys)
    && typeof value.text === 'string'
    && value.text.length <= MAX_PROMPT_LENGTH
    && (!Object.hasOwn(value, 'attachments') || isAttachmentList(value.attachments))
}

function isEmptyRequest(value: unknown): value is ChatAbortRequest | ChatQueueRequest {
  return isPlainRecord(value) && hasExactKeys(value, [])
}

function isPromptResponse(value: unknown): value is ChatPromptResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['accepted'])
    && typeof value.accepted === 'boolean'
}

function isAbortResponse(value: unknown): value is ChatAbortResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['stopped'])
    && typeof value.stopped === 'boolean'
}

function isQueueResponse(value: unknown): value is ChatQueueResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['steering', 'followUp', 'pending'])
    && Array.isArray(value.steering)
    && value.steering.every((item) => typeof item === 'string')
    && Array.isArray(value.followUp)
    && value.followUp.every((item) => typeof item === 'string')
    && Number.isSafeInteger(value.pending)
    && (value.pending as number) >= 0
}

function isQueueClearedResponse(value: unknown): value is ChatQueueClearedResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['cleared'])
    && isQueueResponse(value.cleared)
}

function isLifecyclePayload(value: unknown): value is ChatLifecyclePayload {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['runtime', 'event'])
    || !isRuntimeScope(value.runtime)) return false
  const event = value.event
  if (!isPlainRecord(event) || typeof event.type !== 'string') return false
  if (event.type === 'queue-updated') {
    return hasExactKeys(event, ['type', 'steering', 'followUp'])
      && Array.isArray(event.steering)
      && event.steering.every((item) => typeof item === 'string')
      && Array.isArray(event.followUp)
      && event.followUp.every((item) => typeof item === 'string')
  }
  return ['agent-started', 'turn-started', 'turn-ended', 'agent-ended', 'settled'].includes(event.type)
    && hasExactKeys(event, ['type'])
}

function requireScope(scope: RuntimeScope | undefined): RuntimeScope {
  if (!scope) throw new Error('A runtime scope is required for chat operations.')
  return scope
}

/** Compose chat descriptors into the app's single IPC registration. */
export function registerChatCapabilities(service: ChatInputService): readonly ChatCapabilityDefinition[] {
  const prompt: CapabilityDefinition<ChatPromptRequest, ChatPromptResponse> = {
    id: CHAT_IPC.prompt,
    scope: 'runtime',
    validateRequest: isPromptRequest,
    validateResponse: isPromptResponse,
    handle: ({ caller, scope }, request) => service.prompt(caller, requireScope(scope), request),
  }
  const steer: CapabilityDefinition<ChatQueueInputRequest, ChatPromptResponse> = {
    id: CHAT_IPC.steer,
    scope: 'runtime',
    validateRequest: isQueueInputRequest,
    validateResponse: isPromptResponse,
    handle: ({ caller, scope }, request) => service.steer(caller, requireScope(scope), request),
  }
  const followUp: CapabilityDefinition<ChatQueueInputRequest, ChatPromptResponse> = {
    id: CHAT_IPC.followUp,
    scope: 'runtime',
    validateRequest: isQueueInputRequest,
    validateResponse: isPromptResponse,
    handle: ({ caller, scope }, request) => service.followUp(caller, requireScope(scope), request),
  }
  const abort: CapabilityDefinition<ChatAbortRequest, ChatAbortResponse> = {
    id: CHAT_IPC.abort,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isAbortResponse,
    handle: ({ caller, scope }) => service.abort(caller, requireScope(scope)),
  }
  const readQueue: CapabilityDefinition<ChatQueueRequest, ChatQueueResponse> = {
    id: CHAT_IPC.readQueue,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isQueueResponse,
    handle: ({ scope }) => service.readQueue(requireScope(scope)),
  }
  const clearQueue: CapabilityDefinition<ChatQueueRequest, ChatQueueClearedResponse> = {
    id: CHAT_IPC.clearQueue,
    scope: 'runtime',
    validateRequest: isEmptyRequest,
    validateResponse: isQueueClearedResponse,
    handle: ({ scope }) => service.clearQueue(requireScope(scope)),
  }
  return [prompt, steer, followUp, abort, readQueue, clearQueue]
}

export function registerChatEvents(service: ChatInputService): readonly EventDefinition<ChatLifecyclePayload>[] {
  const lifecycle: EventDefinition<ChatLifecyclePayload> = {
    id: CHAT_IPC.lifecycleEvent,
    scope: 'runtime',
    validatePayload: isLifecyclePayload,
    subscribe: (context, publish) => service.subscribe(
      context.caller,
      requireScope(context.scope),
      publish,
    ),
  }
  return [lifecycle]
}
