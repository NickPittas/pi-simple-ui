import type { RuntimeScope } from './ipc-contracts.ts'

export const CHAT_IPC = Object.freeze({
  prompt: 'chat.prompt',
  steer: 'chat.steer',
  followUp: 'chat.follow-up',
  abort: 'chat.abort',
  readQueue: 'chat.queue.read',
  clearQueue: 'chat.queue.clear',
  lifecycleEvent: 'chat.lifecycle',
})

export interface ChatAttachment {
  readonly type: 'text' | 'image'
  readonly path: string
}

export interface ChatPromptRequest {
  readonly text: string
  readonly streamingBehavior?: 'steer' | 'followUp'
  readonly attachments?: readonly ChatAttachment[]
}

export interface ChatQueueInputRequest {
  readonly text: string
  readonly attachments?: readonly ChatAttachment[]
}

export interface ChatAbortRequest {}

export interface ChatQueueRequest {}

export interface ChatPromptResponse {
  readonly accepted: boolean
}

export interface ChatQueueResponse {
  readonly steering: readonly string[]
  readonly followUp: readonly string[]
  readonly pending: number
}

export interface ChatQueueClearedResponse {
  readonly cleared: ChatQueueResponse
}

export interface ChatAbortResponse {
  readonly stopped: boolean
}

export type ChatLifecycleEvent =
  | { readonly type: 'agent-started' }
  | { readonly type: 'turn-started' }
  | { readonly type: 'turn-ended' }
  | { readonly type: 'agent-ended' }
  | { readonly type: 'settled' }
  | {
      readonly type: 'queue-updated'
      readonly steering: readonly string[]
      readonly followUp: readonly string[]
    }

export interface ChatLifecyclePayload {
  readonly runtime: RuntimeScope
  readonly event: ChatLifecycleEvent
}

export interface ChatCapabilityContracts {
  'chat.prompt': { readonly request: ChatPromptRequest; readonly response: ChatPromptResponse }
  'chat.steer': { readonly request: ChatQueueInputRequest; readonly response: ChatPromptResponse }
  'chat.follow-up': { readonly request: ChatQueueInputRequest; readonly response: ChatPromptResponse }
  'chat.abort': { readonly request: ChatAbortRequest; readonly response: ChatAbortResponse }
  'chat.queue.read': { readonly request: ChatQueueRequest; readonly response: ChatQueueResponse }
  'chat.queue.clear': { readonly request: ChatQueueRequest; readonly response: ChatQueueClearedResponse }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends ChatCapabilityContracts {}

  interface IpcEventContracts {
    'chat.lifecycle': { readonly payload: ChatLifecyclePayload }
  }
}
