import type {} from './ipc-contracts.ts'
import type { RuntimeScope } from './ipc-contracts.ts'

export const CODEMODE_IPC = Object.freeze({
  list: 'codemode.list',
  get: 'codemode.get',
  catalog: 'codemode.catalog',
  abort: 'codemode.abort',
  events: 'codemode.events',
})

export type CodemodeExecutionStatus = 'running' | 'completed' | 'failed' | 'aborted'
export type CodemodeCallStatus = 'running' | 'completed' | 'failed' | 'aborted'

/** JSON-compatible data as emitted by the native Code Mode tool pipeline. */
export type CodemodeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CodemodeJsonValue[]
  | { readonly [key: string]: CodemodeJsonValue }

export interface CodemodeCallTrace {
  readonly id: string
  readonly parentId?: string
  readonly name: string
  readonly namespace?: string
  readonly args: CodemodeJsonValue
  readonly output?: CodemodeJsonValue
  readonly partialOutput?: CodemodeJsonValue
  readonly error?: string
  readonly status: CodemodeCallStatus
  readonly startedAt: string
  readonly durationMs?: number
}

export interface CodemodeBudgets {
  readonly timeoutMs: number | null
  readonly maxOutputTokens: number
  readonly memoryLimitBytes: number
  readonly maxOutputChars: number
  readonly maxOutputItems: number
  readonly maxConcurrentModelCalls: number
  /** Native Code Mode has no independent nested-tool call-count budget. */
  readonly maxToolCalls: null
}

export interface CodemodeSettings {
  readonly mode: 'on' | 'only'
  readonly inlineBudget: number
  readonly modelsEnabled: boolean
}

export interface CodemodeTrace {
  readonly executionId: string
  readonly sessionId: string
  readonly script: string
  readonly status: CodemodeExecutionStatus
  readonly startedAt: string
  readonly durationMs?: number
  readonly calls: readonly CodemodeCallTrace[]
  readonly budgets: CodemodeBudgets
  readonly settings: CodemodeSettings
  readonly output?: CodemodeJsonValue
  /** Full text recovered from the native spill file when native output token truncation applied. */
  readonly fullOutput?: string
  readonly partialOutput?: CodemodeJsonValue
  readonly error?: string
}

export interface CodemodeExecutionSummary {
  readonly executionId: string
  readonly status: CodemodeExecutionStatus
  readonly startedAt: string
  readonly durationMs?: number
  readonly callCount: number
  readonly error?: string
}

export interface CodemodeListRequest {
  readonly sessionId: string
}

export interface CodemodeListResponse {
  readonly sessionId: string
  readonly executions: readonly CodemodeExecutionSummary[]
}

export interface CodemodeGetRequest {
  readonly executionId: string
}

export type CodemodeGetResponse = CodemodeTrace | null

export interface CodemodeCatalogRequest {
  readonly sessionId: string
}

export interface CodemodeCatalogTool {
  readonly name: string
  readonly description: string
  readonly namespace?: string
  readonly exposure: string
  readonly parameters: CodemodeJsonValue
  readonly outputSchema?: CodemodeJsonValue
}

export interface CodemodeCatalogNamespace {
  readonly name: string
  readonly description?: string
  readonly instructions?: string
  readonly tools: readonly string[]
}

export interface CodemodeCatalogResponse {
  readonly sessionId: string
  readonly settings: CodemodeSettings
  readonly namespaces: readonly CodemodeCatalogNamespace[]
  readonly tools: readonly CodemodeCatalogTool[]
}

export interface CodemodeAbortRequest {
  readonly executionId: string
}

export interface CodemodeAbortResponse {
  readonly aborted: boolean
  /** Native session abort stops the current agent turn, not only this script. */
  readonly scope: 'turn' | 'none'
}

export interface CodemodeEventPayload {
  readonly runtime: RuntimeScope
  readonly sessionId: string
  readonly execution: CodemodeTrace
}

export interface CodemodeCapabilityContracts {
  'codemode.list': {
    readonly request: CodemodeListRequest
    readonly response: CodemodeListResponse
  }
  'codemode.get': {
    readonly request: CodemodeGetRequest
    readonly response: CodemodeGetResponse
  }
  'codemode.catalog': {
    readonly request: CodemodeCatalogRequest
    readonly response: CodemodeCatalogResponse
  }
  'codemode.abort': {
    readonly request: CodemodeAbortRequest
    readonly response: CodemodeAbortResponse
  }
}

export interface CodemodeEventContracts {
  'codemode.events': { readonly payload: CodemodeEventPayload }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends CodemodeCapabilityContracts {}
  interface IpcEventContracts extends CodemodeEventContracts {}
}
