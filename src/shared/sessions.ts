import type { RuntimeScope } from './ipc-contracts.ts'

export const SESSIONS_IPC = Object.freeze({
  list: 'sessions.list',
  open: 'sessions.open',
  history: 'sessions.history',
  events: 'sessions.events',
})

export type SessionJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SessionJsonValue[]
  | { readonly [key: string]: SessionJsonValue }

export interface SessionLeafInfo {
  readonly id: string
  readonly type: string
  readonly timestamp: string
  readonly label?: string
}

export interface SessionSnapshot {
  readonly id: string
  readonly name?: string
  readonly cwd: string
  readonly createdAt: string
  readonly messageCount: number
  readonly activeLeaf: SessionLeafInfo | null
}

export type SessionRecoveryDiagnostic = {
  readonly file: string
  readonly reason: 'invalid-jsonl' | 'invalid-session' | 'unreadable'
}

export interface SessionsListRequest {}

export interface SessionsListResponse {
  readonly sessions: readonly SessionSnapshot[]
  readonly diagnostics: readonly SessionRecoveryDiagnostic[]
}

export interface SessionsOpenRequest {
  readonly sessionId: string
}

export interface SessionsOpenResponse {
  readonly cancelled: boolean
  readonly sessionId?: string
}

export interface SessionsHistoryRequest {
  readonly sessionId: string
  readonly offset?: number
  readonly limit?: number
}

export type SessionContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string }
  | {
      readonly type: 'structured'
      readonly value: SessionJsonValue
    }

export interface SessionHistoryEntry {
  readonly id: string
  readonly parentId: string | null
  readonly type: string
  readonly timestamp: string
  readonly label?: string
  readonly content?: readonly SessionContentPart[]
  readonly summary?: string
  readonly data?: SessionJsonValue
}

export interface SessionsHistoryResponse {
  readonly sessionId: string
  readonly offset: number
  readonly limit: number
  readonly entries: readonly SessionHistoryEntry[]
  readonly nextOffset: number | null
  readonly activeLeaf: SessionLeafInfo | null
}

export interface SessionsEventsRequest {}

export interface SessionUsageDTO {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly total: number
}

export type SessionEvent =
  | { readonly type: 'turn-start' }
  | { readonly type: 'text-delta'; readonly contentIndex: number; readonly delta: string }
  | { readonly type: 'thinking-delta'; readonly contentIndex: number; readonly delta: string }
  | {
      readonly type: 'structured-content'
      readonly contentIndex: number
      readonly delta?: string
      readonly value?: SessionJsonValue
    }
  | {
      readonly type: 'tool-start'
      readonly toolCallId: string
      readonly toolName: string
      readonly arguments: SessionJsonValue
    }
  | {
      readonly type: 'tool-update'
      readonly toolCallId: string
      readonly toolName: string
      readonly arguments: SessionJsonValue
      readonly result: SessionJsonValue
    }
  | {
      readonly type: 'tool-end'
      readonly toolCallId: string
      readonly toolName: string
      readonly arguments: SessionJsonValue
      readonly result: SessionJsonValue
      readonly isError: boolean
      readonly error?: string
    }
  | {
      readonly type: 'retry'
      readonly attempt: number
      readonly maxAttempts: number
      readonly delayMs: number
      readonly message: string
    }
  | {
      readonly type: 'compaction'
      readonly phase: 'start' | 'end'
      readonly reason: 'manual' | 'threshold' | 'overflow'
      readonly aborted?: boolean
      readonly willRetry?: boolean
      readonly message?: string
    }
  | { readonly type: 'summary'; readonly kind: 'compaction' | 'branch'; readonly text: string }
  | { readonly type: 'turn-end'; readonly stopReason: string; readonly usage: SessionUsageDTO }
  | { readonly type: 'error'; readonly message: string; readonly source: 'assistant' | 'tool' | 'runtime' }
  | { readonly type: 'terminal'; readonly reason: 'completed' | 'aborted' | 'error' }

export interface SessionEventEnvelope {
  readonly runtime: RuntimeScope
  readonly sessionGeneration: number
  readonly sessionId: string
  readonly event: SessionEvent
}

export interface SessionsCapabilityContracts {
  'sessions.list': { readonly request: SessionsListRequest; readonly response: SessionsListResponse }
  'sessions.open': { readonly request: SessionsOpenRequest; readonly response: SessionsOpenResponse }
  'sessions.history': { readonly request: SessionsHistoryRequest; readonly response: SessionsHistoryResponse }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends SessionsCapabilityContracts {}

  interface IpcEventContracts {
    'sessions.events': { readonly payload: SessionEventEnvelope }
  }
}
