import './ipc-contracts.ts'
import type { WorkspaceSnapshot } from './workspaces.ts'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Stop = () => void

/** Sequence increases monotonically within a process generation. */
export type NativePiEnvelope = {
  version: 1
  processGeneration: number
  sequence: number
  sessionId: string | null
  sessionGeneration: number | null
  kind: 'root' | 'snapshot' | 'event' | 'status' | 'gap'
  payload: Json
}

/** Missing native metadata stays unknown rather than being inferred. */
export type NativePiSessionSnapshot = {
  sessionId: string
  sessionGeneration: number
  name: string | null
  file: string | null
  cwd: string | null
  classification: 'root' | 'child' | 'unknown'
  parentSessionId: string | null
  entries: Json[]
  activeLeaf: string | null
  activeBranch: string[] | null
  partial: Json | null
  metadata: Json
}

/** Snapshot sequence identifies the coherent cutoff for its session data. */
export type NativePiSnapshot = {
  snapshotId: string
  processGeneration: number
  sequence: number
  state: 'starting' | 'ready' | 'disconnected' | 'unsupported' | 'exited' | 'gap'
  rootSessionId: string | null
  sessions: NativePiSessionSnapshot[]
  nextCursor: string | null
  error: string | null
}

export type SnapshotRequest = {
  cursor?: string
}

export type SubmitRequest = {
  requestId: string
  sessionId: string
  sessionGeneration: number
  text: string
}

/** Acceptance acknowledges submission, not execution settlement. */
export type NativePiAck = {
  requestId: string
  outcome: 'accepted' | 'rejected' | 'unknown'
  reason: string | null
}

export type TerminalInput = {
  requestId: string
  data: string
}

export type TerminalSize = {
  columns: number
  rows: number
}

export type TerminalOutput = {
  processGeneration: number
  sequence: number
  data: string
  gap: boolean
}

export type NativeTransportStatus = {
  processGeneration: number
  state: 'waiting' | 'connected' | 'disconnected' | 'disposed'
  reason: string | null
}

export type NativeThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type NativeSessionTarget = { sessionId: string; sessionGeneration: number }
export type NativeModelChoice = { provider: string; id: string; name: string }
export type NativeModelState = NativeSessionTarget & {
  processGeneration: number; sequence: number; model: NativeModelChoice | null; models: NativeModelChoice[]
  thinkingLevel: NativeThinkingLevel | null; thinkingLevels: NativeThinkingLevel[]; busy: boolean
}
export type NativeModelStateResult = { state: NativeModelState | null; error: string | null }
export type NativeSessionSummary = { sessionId: string; file: string; name: string | null; created: string; modified: string; firstMessage: string; messageCount: number; branched: boolean }
export type NativeSessionsResult = { sessions: NativeSessionSummary[]; error: string | null }
export type NativeCommandSource = 'extension' | 'prompt' | 'skill'
/** Pi's own SourceInfo for the resource that provides a command (RPC get_commands). Additive; null when Pi sent none or it failed validation. */
export type NativeCommandSourceInfo = {
  path: string
  source: string
  scope: 'user' | 'project' | 'temporary'
  origin: 'package' | 'top-level'
  baseDir: string | null
}
export type NativeCommandEntry = { name: string; description: string | null; source: NativeCommandSource; sourceInfo?: NativeCommandSourceInfo | null }
export type NativeCommandsResult = { commands: NativeCommandEntry[]; error: string | null }
export type AbortRequest = NativeSessionTarget & { requestId: string }
export type SetModelRequest = NativeSessionTarget & { requestId: string; provider: string; modelId: string }
export type SetThinkingRequest = NativeSessionTarget & { requestId: string; level: NativeThinkingLevel }
export type OpenSessionRequest = { workspaceId: string; expectedProcessGeneration: number; expectedSessionId: string; file: string | null }
export type OpenSessionResult = { outcome: 'opened' | 'failed'; reason: string | null; snapshot: WorkspaceSnapshot }

export type NativeBridgeCommand =
  | { operation: 'snapshot'; payload: SnapshotRequest }
  | { operation: 'submit'; payload: SubmitRequest }
  | { operation: 'model-state'; payload: Record<string, never> }
  | { operation: 'set-model'; payload: SetModelRequest }
  | { operation: 'set-thinking'; payload: SetThinkingRequest }
  | { operation: 'sessions-list'; payload: Record<string, never> }
  | { operation: 'commands-list'; payload: Record<string, never> }
  | { operation: 'abort'; payload: AbortRequest }

export type NativeBridgeRequest =
  | { requestId: string; operation: 'snapshot'; payload: SnapshotRequest }
  | { requestId: string; operation: 'submit'; payload: SubmitRequest }
  | { requestId: string; operation: 'model-state'; payload: Record<string, never> }
  | { requestId: string; operation: 'set-model'; payload: SetModelRequest }
  | { requestId: string; operation: 'set-thinking'; payload: SetThinkingRequest }
  | { requestId: string; operation: 'sessions-list'; payload: Record<string, never> }
  | { requestId: string; operation: 'commands-list'; payload: Record<string, never> }
  | { requestId: string; operation: 'abort'; payload: AbortRequest }

export type NativeBridgeReply = {
  requestId: string
  value: NativePiSnapshot | NativePiAck | NativeModelStateResult | NativeSessionsResult | NativeCommandsResult
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts {
    'native.pi.snapshot': { readonly request: SnapshotRequest; readonly response: NativePiSnapshot }
    'native.pi.submit': { readonly request: SubmitRequest; readonly response: NativePiAck }
    'native.pi.model-state': { readonly request: Record<string, never>; readonly response: NativeModelStateResult }
    'native.pi.set-model': { readonly request: SetModelRequest; readonly response: NativePiAck }
    'native.pi.set-thinking': { readonly request: SetThinkingRequest; readonly response: NativePiAck }
    'native.pi.sessions-list': { readonly request: Record<string, never>; readonly response: NativeSessionsResult }
    'native.pi.commands-list': { readonly request: Record<string, never>; readonly response: NativeCommandsResult }
    'native.pi.abort': { readonly request: AbortRequest; readonly response: NativePiAck }
    'native.pi.open-session': { readonly request: OpenSessionRequest; readonly response: OpenSessionResult }
    'native.pi.terminal-input': { readonly request: TerminalInput; readonly response: NativePiAck }
    'native.pi.terminal-resize': { readonly request: TerminalSize; readonly response: null }
  }
  interface IpcEventContracts {
    'native.pi.events': { readonly payload: NativePiEnvelope }
    'native.pi.terminal-output': { readonly payload: TerminalOutput }
    'native.pi.transport-status': { readonly payload: NativeTransportStatus }
  }
}
