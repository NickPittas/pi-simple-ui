import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Json, NativePiSessionSnapshot, NativePiSnapshot } from '../../src/shared/native-pi.ts'

export type NativeManager = ExtensionContext['sessionManager']

let snapshotSequence = 0


// Pi objects can carry own `undefined`-valued properties (e.g. SessionHeader.parentSession on a
// fresh root session, dist/core/session-manager.js newSession). structuredClone preserves them,
// but the Json wire contract forbids undefined and isJson rejects it; normalize to null here, at
// the boundary. The validator is never relaxed to accept undefined.
function toWireJson(value: unknown): Json {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') return value as Json
  if (Array.isArray(value)) return value.map(toWireJson)
  const out: Record<string, Json> = {}
  for (const [key, child] of Object.entries(value)) out[key] = toWireJson(child)
  return out
}

export type RetainedPartial = {
  sessionId: string
  processGeneration: number
  payload: Json
}

export function readNativeSessionSnapshot(
  manager: NativeManager,
  processGeneration: number,
  partial: RetainedPartial | null,
): NativePiSnapshot {
  if (!Number.isSafeInteger(processGeneration) || processGeneration < 0) {
    throw new Error('process generation must be a nonnegative safe integer')
  }

  if (snapshotSequence === Number.MAX_SAFE_INTEGER) throw new Error('snapshot sequence exhausted')
  const sequence = ++snapshotSequence
  const sessionId = manager.getSessionId()
  const header = manager.getHeader()
  const entries = manager.getEntries()
  const leaf = manager.getLeafId()
  const branch = manager.getBranch()
  const projection = manager.buildSessionProjection()
  const name = [...entries].reverse().find(entry => entry.type === 'session_info')

  const session: NativePiSessionSnapshot = {
    sessionId,
    // 0 is a placeholder: the public manager API exposes no session-generation value, so this is not a real generation.
    sessionGeneration: 0,
    name: name?.type === 'session_info' ? name.name ?? null : null,
    file: manager.getSessionFile() ?? null,
    cwd: header?.cwd ?? null,
    classification: header?.parentSession ? 'child' : header ? 'root' : 'unknown',
    // Stays null because the header parent is a path, not a session id.
    parentSessionId: null,
    // Assumes entries are plain persisted JSON; structuredClone is cast to Json on that assumption.
    entries: toWireJson(structuredClone(entries)) as Json[],
    activeLeaf: leaf,
    activeBranch: branch.map(entry => entry.id),
    // Retain partial only when both session id and process generation match; otherwise use null.
    partial: partial?.sessionId === sessionId && partial.processGeneration === processGeneration
      ? toWireJson(structuredClone(partial.payload))
      : null,
    metadata: {
      header: toWireJson(structuredClone(header)),
      branch: toWireJson(structuredClone(branch)),
      messages: toWireJson(structuredClone(projection.messages)),
    },
  }

  return {
    snapshotId: `${processGeneration}:${sessionId}:${sequence}`,
    processGeneration,
    sequence,
    state: 'ready',
    rootSessionId: header && !header.parentSession ? sessionId : null,
    sessions: [session],
    nextCursor: null,
    error: null,
  }
}
