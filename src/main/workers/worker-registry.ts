import type { JSONValue } from '@earendil-works/pi-coding-agent'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type {
  WorkerEvent,
  WorkerListResponse,
  WorkerProviderState,
  WorkerSnapshot,
  WorkerSummary,
} from '../../shared/workers.ts'
import {
  WORKER_SNAPSHOT_DEFAULT_LIMIT,
  WORKER_SNAPSHOT_MAX_LIMIT,
  WORKER_SNAPSHOT_MAX_OFFSET,
} from '../../shared/workers.ts'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'

const MAX_LIVE_EVENTS_PER_WORKER = 500
const MAX_REPLAY_EVENTS = 1_000

interface WorkerState {
  summary: WorkerSummary
  ancestry: readonly string[]
  messages: readonly JSONValue[]
  nativeMessageIds: readonly string[]
  historyComplete: boolean | null
  totalMessages: number | null
  events: WorkerEvent[]
}

export interface WorkerSnapshotPage {
  readonly summary: WorkerSummary
  readonly ancestry: readonly string[]
  readonly messages: readonly JSONValue[]
  readonly offset: number
  readonly limit: number | null
  readonly total: number | null
  readonly nextOffset: number | null
  readonly historyComplete: boolean | null
}

export type WorkerHistoryPageReader = (
  workerId: string,
  offset: number,
  limit: number,
) => Promise<{ readonly messages: readonly JSONValue[]; readonly total: number; readonly nextOffset: number | null } | null>

interface WorkerSubscriber {
  readonly caller: AuthorizedIpcCaller
  readonly scope: RuntimeScope
  readonly publish: (event: WorkerEvent) => void
}

function sameScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return left.ownerId === right.ownerId && left.generation === right.generation
}

function sameCaller(left: AuthorizedIpcCaller, right: AuthorizedIpcCaller): boolean {
  return left.windowId === right.windowId
    && left.webContentsId === right.webContentsId
    && left.frameUrl === right.frameUrl
}

/** Runtime-generation-owned, normalized worker state and bounded live events. */
export class WorkerRegistry {
  readonly scope: RuntimeScope
  ready?: Promise<void>
  private readonly workers = new Map<string, WorkerState>()
  private readonly subscribers = new Set<WorkerSubscriber>()
  private providerState: WorkerProviderState = 'provider-unavailable'
  private historyPageReader: WorkerHistoryPageReader | undefined
  private disposed = false

  constructor(scope: RuntimeScope) {
    this.scope = Object.freeze({ ownerId: scope.ownerId, generation: scope.generation })
  }

  setProviderState(state: WorkerProviderState): void {
    if (this.disposed) return
    this.providerState = state
  }

  isCurrentScope(scope: RuntimeScope): boolean {
    return !this.disposed && sameScope(scope, this.scope)
  }

  hasWorker(workerId: string): boolean {
    return !this.disposed && this.workers.has(workerId)
  }

  list(): WorkerListResponse {
    if (this.disposed || this.providerState === 'provider-unavailable') {
      return { providerState: 'provider-unavailable', workers: [] }
    }
    const workers = [...this.workers.values()]
      .map(({ summary }) => summary)
      .sort((left, right) => right.startedAt - left.startedAt)
    return { providerState: this.providerState, workers }
  }

  snapshot(workerId: string): WorkerSnapshot | null {
    if (this.disposed || this.providerState === 'provider-unavailable') return null
    const state = this.workers.get(workerId)
    if (!state) return null
    return {
      summary: state.summary,
      ancestry: [...state.ancestry],
      messages: [...state.messages],
      nextCursor: null,
      historyComplete: state.historyComplete,
      totalMessages: state.totalMessages,
    }
  }

  /** Read a full snapshot or one bounded page without truncating registry history. */
  snapshotPage?: (workerId: string, offset?: number, limit?: number) => Promise<WorkerSnapshotPage | null> = async (
    workerId,
    requestedOffset,
    requestedLimit,
  ): Promise<WorkerSnapshotPage | null> => {
    if (this.disposed || this.providerState === 'provider-unavailable') return null
    const paged = requestedOffset !== undefined || requestedLimit !== undefined
    const offset = requestedOffset ?? 0
    const limit = requestedLimit ?? WORKER_SNAPSHOT_DEFAULT_LIMIT
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > WORKER_SNAPSHOT_MAX_OFFSET
      || !Number.isSafeInteger(limit) || limit < 1 || limit > WORKER_SNAPSHOT_MAX_LIMIT) {
      throw new TypeError('The worker history page is invalid.')
    }
    const state = this.workers.get(workerId)
    if (!state) return null
    if (!paged) {
      return {
        summary: state.summary,
        ancestry: [...state.ancestry],
        messages: [...state.messages],
        offset: 0,
        limit: null,
        total: state.totalMessages,
        nextOffset: null,
        historyComplete: state.historyComplete,
      }
    }

    // A complete in-memory live/native transcript is fresher than disk while a turn is active.
    const nativePage = state.historyComplete === true
      ? null
      : await this.historyPageReader?.(workerId, offset, limit)
    if (this.disposed || this.workers.get(workerId) !== state) return null
    if (nativePage) {
      const isRunning = state.summary.status === 'running'
      return {
        summary: state.summary,
        ancestry: [...state.ancestry],
        messages: nativePage.messages,
        offset,
        limit,
        total: isRunning ? null : nativePage.total,
        nextOffset: nativePage.nextOffset,
        historyComplete: nativePage.nextOffset !== null ? false : isRunning ? null : true,
      }
    }

    if (state.historyComplete === true && state.totalMessages !== null) {
      const total = state.totalMessages
      const end = Math.min(total, offset + limit)
      return {
        summary: state.summary,
        ancestry: [...state.ancestry],
        messages: state.messages.slice(offset, end),
        offset,
        limit,
        total,
        nextOffset: end < total ? end : null,
        historyComplete: end >= total,
      }
    }

    const lookahead = state.messages.slice(offset, offset + limit + 1)
    const hasLookahead = lookahead.length > limit
    const end = Math.min(lookahead.length, limit)
    return {
      summary: state.summary,
      ancestry: [...state.ancestry],
      messages: lookahead.slice(0, end),
      offset,
      limit,
      total: null,
      nextOffset: hasLookahead ? offset + limit : null,
      historyComplete: hasLookahead ? false : null,
    }
  }

  setHistoryPageReader?: (reader: WorkerHistoryPageReader | undefined) => void = (reader) => {
    if (this.disposed) return
    this.historyPageReader = reader
  }

  upsert(
    summary: WorkerSummary,
    ancestry: readonly string[],
    messages?: readonly JSONValue[],
    historyComplete?: boolean | null,
  ): void {
    if (this.disposed || !summary.id) return
    const previous = this.workers.get(summary.id)
    this.workers.set(summary.id, {
      summary: Object.freeze({ ...summary }),
      ancestry: Object.freeze([...ancestry]),
      messages: messages ? Object.freeze([...messages]) : previous?.messages ?? Object.freeze([]),
      nativeMessageIds: messages ? Object.freeze([]) : previous?.nativeMessageIds ?? Object.freeze([]),
      historyComplete: messages
        ? (historyComplete !== undefined ? historyComplete : summary.source === 'live')
        : previous?.historyComplete ?? null,
      totalMessages: messages
        ? ((historyComplete === true || (historyComplete === undefined && summary.source === 'live')) ? messages.length : null)
        : previous?.totalMessages ?? null,
      events: previous?.events ?? [],
    })
  }

  replaceMessages(workerId: string, messages: readonly JSONValue[]): void {
    const state = this.workers.get(workerId)
    if (!state || this.disposed) return
    state.messages = Object.freeze([...messages])
    state.nativeMessageIds = Object.freeze([])
    state.historyComplete = true
    state.totalMessages = messages.length
  }

  /** Restore a native transcript, deduplicating session messages by SessionEntry ID. */
  restoreMessages?: (workerId: string, messages: readonly JSONValue[], nativeMessageIds: readonly string[]) => void = (
    workerId,
    messages,
    nativeMessageIds,
  ) => {
    const state = this.workers.get(workerId)
    if (!state || this.disposed) return
    // An observed live AgentSession is the complete, current in-memory transcript.
    // Disk restoration must never replace it with an older persisted projection.
    if (state.historyComplete === true && state.nativeMessageIds.length === 0) return
    const uniqueMessages: JSONValue[] = []
    const uniqueIds: string[] = []
    const seen = new Set<string>()
    for (let index = 0; index < messages.length; index++) {
      const id = nativeMessageIds[index]
      if (!id || seen.has(id)) continue
      seen.add(id)
      uniqueIds.push(id)
      uniqueMessages.push(messages[index]!)
    }
    state.messages = Object.freeze(uniqueMessages)
    state.nativeMessageIds = Object.freeze(uniqueIds)
    state.historyComplete = true
    state.totalMessages = uniqueMessages.length
  }

  appendEvent(event: WorkerEvent): void {
    if (this.disposed) return
    const state = this.workers.get(event.workerId)
    if (!state) return
    state.events.push(event)
    if (state.events.length > MAX_LIVE_EVENTS_PER_WORKER) {
      state.events.splice(0, state.events.length - MAX_LIVE_EVENTS_PER_WORKER)
    }
    for (const subscriber of this.subscribers) {
      if (!this.isSubscriberCurrent(subscriber)) continue
      try {
        subscriber.publish(event)
      } catch {
        // An IPC observer must not break the native child-session event path.
      }
    }
  }

  subscribe(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    publish: (event: WorkerEvent) => void,
  ): () => void {
    if (this.disposed || !sameScope(scope, this.scope)) throw new Error('Worker runtime scope is no longer current.')
    const subscriber: WorkerSubscriber = { caller, scope: { ...scope }, publish }
    this.subscribers.add(subscriber)

    const replay = [...this.workers.values()]
      .flatMap((state) => state.events)
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-MAX_REPLAY_EVENTS)
    for (const event of replay) {
      if (!this.isSubscriberCurrent(subscriber)) break
      try {
        publish(event)
      } catch {
        break
      }
    }

    return () => {
      for (const active of this.subscribers) {
        if (active === subscriber && sameCaller(active.caller, caller)) this.subscribers.delete(active)
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.providerState = 'provider-unavailable'
    this.subscribers.clear()
    this.historyPageReader = undefined
    this.workers.clear()
  }

  private isSubscriberCurrent(subscriber: WorkerSubscriber): boolean {
    return !this.disposed
      && this.subscribers.has(subscriber)
      && sameScope(subscriber.scope, this.scope)
  }
}
