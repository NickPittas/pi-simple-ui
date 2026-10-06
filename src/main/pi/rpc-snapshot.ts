import type { Json, NativePiSnapshot } from '../../shared/native-pi.ts'

export type RpcSnapshotInput = {
  snapshotId: string
  processGeneration: number
  sequence: number
  sessionGeneration: number
  session: { sessionId: string; sessionFile?: string; sessionName?: string }
  entries: Json[]
  leafId: string | null
  partial: Json | null
}

export function projectRpcSnapshot(input: RpcSnapshotInput): NativePiSnapshot {
  const byId = new Map<string, { [key: string]: Json }>()
  const problems = new Set<string>()
  for (const value of input.entries) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problems.add('entry has invalid structure')
      continue
    }
    const entry = value as { [key: string]: Json }
    if (typeof entry.id !== 'string' || !entry.id || (entry.parentId !== null && typeof entry.parentId !== 'string')) {
      problems.add('entry has invalid id or parent')
      continue
    }
    if (byId.has(entry.id)) problems.add('entries contain duplicate ids')
    else byId.set(entry.id, entry)
  }
  for (const entry of byId.values()) {
    if (typeof entry.parentId === 'string' && !byId.has(entry.parentId)) problems.add('entry references a missing parent')
  }

  const complete = new Set<string>()
  for (const id of byId.keys()) {
    const path = new Set<string>()
    let cursor: string | null = id
    while (cursor !== null && byId.has(cursor) && !complete.has(cursor)) {
      if (path.has(cursor)) {
        problems.add('entries contain a parent cycle')
        break
      }
      path.add(cursor)
      cursor = byId.get(cursor)!.parentId as string | null
    }
    for (const visited of path) complete.add(visited)
  }

  if (input.leafId === null ? byId.size > 0 : !byId.has(input.leafId)) problems.add('active leaf is missing')
  let activeBranch: string[] | null = null
  if (!problems.size && input.leafId !== null) {
    activeBranch = []
    let cursor: string | null = input.leafId
    while (cursor !== null) {
      activeBranch.push(cursor)
      cursor = byId.get(cursor)!.parentId as string | null
    }
    activeBranch.reverse()
  }

  const error = problems.size ? [...problems].join('; ') : null
  return {
    snapshotId: input.snapshotId,
    processGeneration: input.processGeneration,
    sequence: input.sequence,
    state: error === null ? 'ready' : 'gap',
    rootSessionId: input.session.sessionId,
    sessions: [{
      sessionId: input.session.sessionId,
      sessionGeneration: input.sessionGeneration,
      name: input.session.sessionName ?? null,
      file: input.session.sessionFile ?? null,
      cwd: null,
      classification: 'root',
      parentSessionId: null,
      // Native RPC entries are preserved by reference and must be treated as immutable.
      entries: input.entries,
      activeLeaf: input.leafId,
      activeBranch,
      partial: input.partial === null ? null : structuredClone(input.partial),
      metadata: {},
    }],
    nextCursor: null,
    error,
  }
}
