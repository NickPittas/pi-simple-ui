import { SessionManager, type AgentSession, type AgentSessionEvent, type SessionEntry } from '@earendil-works/pi-coding-agent'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type {
  UsageEventPayload,
  UsageMarker,
  UsageModelsResponse,
  UsageSessionResponse,
  UsageTotals,
  UsageTurnResponse,
  UsageUnknownMarker,
  UsageWorkerTotals,
  UsageWorkersResponse,
} from '../../shared/usage.ts'
import type { WorkerSummary } from '../../shared/workers.ts'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'
import type { RuntimeOperationRuntime, RuntimeOperations } from '../pi/runtime-operations.ts'
import type { WorkerRegistry } from '../workers/worker-registry.ts'

type UsageMetric = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'costMicros' | 'turns'

const USAGE_METRICS: readonly UsageMetric[] = [
  'input', 'output', 'cacheRead', 'cacheWrite', 'costMicros', 'turns',
]
const MAX_LIVE_MARKERS = 200
const MAX_OUTPUT_MARKERS = 500
const INTERNAL_CALLER: AuthorizedIpcCaller = Object.freeze({
  windowId: -1,
  webContentsId: -1,
  frameUrl: 'internal://usage-observer',
})

interface MetricState {
  value: number
  seen: boolean
  missing: boolean
}

/** A missing native field poisons only that metric, never the other token totals. */
class UsageAccumulator {
  private readonly metrics: Record<UsageMetric, MetricState> = {
    input: { value: 0, seen: false, missing: false },
    output: { value: 0, seen: false, missing: false },
    cacheRead: { value: 0, seen: false, missing: false },
    cacheWrite: { value: 0, seen: false, missing: false },
    costMicros: { value: 0, seen: false, missing: false },
    turns: { value: 0, seen: false, missing: false },
  }

  add(usage: unknown, turns: number | null): void {
    if (!isRecord(usage)) return
    for (const metric of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      const value = usage[metric]
      this.addMetric(metric, typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
    }
    const cost = isRecord(usage.cost) ? usage.cost.total : undefined
    const micros = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
      ? Math.round(cost * 1_000_000)
      : null
    this.addMetric('costMicros', micros !== null && Number.isSafeInteger(micros) ? micros : null)
    this.addMetric('turns', turns)
  }

  addTotals(totals: UsageTotals): void {
    for (const metric of USAGE_METRICS) this.addMetric(metric, totals[metric])
  }

  snapshot(): UsageTotals {
    const result = {} as Record<UsageMetric, number | null>
    for (const metric of USAGE_METRICS) {
      const state = this.metrics[metric]
      result[metric] = state.seen && !state.missing ? state.value : null
    }
    return result as UsageTotals
  }

  private addMetric(metric: UsageMetric, value: number | null): void {
    const state = this.metrics[metric]
    state.seen = true
    if (value === null || !Number.isFinite(value) || value < 0) {
      state.missing = true
      return
    }
    state.value += value
  }
}

interface WorkerUsageState {
  readonly totals: UsageAccumulator
  readonly modelTotals: Map<string, UsageAccumulator>
  readonly seenMessages: Set<string>
}

interface UsageSubscriber {
  readonly callerKey: string
  readonly runtimeId: string
  readonly scope: RuntimeScope
  readonly publish: (payload: UsageEventPayload) => void
}

interface SessionEventHost {
  subscribeSessionEvents(listener: (event: {
    readonly runtime: RuntimeScope
    readonly sessionId: string
  }) => void): () => void
}

interface RuntimeObserver {
  readonly runtimeId: string
  readonly scope: RuntimeScope
  sessionId: string
  session: AgentSession
  unsubscribeNative: () => void
  unsubscribeSession: () => void
  unsubscribeWorkers: () => void
  workerRegistry?: WorkerRegistry
  latestTurn: UsageTotals | null
  readonly markers: UsageMarker[]
  readonly workerUsage: Map<string, WorkerUsageState>
  seenWorkerEvents: WeakSet<object>
}

interface SessionUsageSource {
  readonly manager: SessionManager
  readonly active: boolean
}

function callerKey(caller: AuthorizedIpcCaller): string {
  return `${caller.windowId}:${caller.webContentsId}:${caller.frameUrl}`
}

function sameScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return left.ownerId === right.ownerId && left.generation === right.generation
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function newWorkerUsageState(): WorkerUsageState {
  return { totals: new UsageAccumulator(), modelTotals: new Map(), seenMessages: new Set() }
}

function usageKey(provider: unknown, model: unknown): string | undefined {
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) return undefined
  return `${provider}/${model}`.slice(0, 1_024)
}

function addWorkerMessage(state: WorkerUsageState, message: unknown): boolean {
  if (!isRecord(message) || message.role !== 'assistant' || !isRecord(message.usage)) return false
  const fingerprint = JSON.stringify([
    message.timestamp,
    message.provider,
    message.responseModel ?? message.model,
    message.responseId,
    message.usage,
  ])
  if (state.seenMessages.has(fingerprint)) return false
  state.seenMessages.add(fingerprint)
  state.totals.add(message.usage, 1)
  const model = usageKey(message.provider, message.responseModel ?? message.model)
  if (model) {
    let modelTotals = state.modelTotals.get(model)
    if (!modelTotals) {
      modelTotals = new UsageAccumulator()
      state.modelTotals.set(model, modelTotals)
    }
    modelTotals.add(message.usage, 1)
  }
  return true
}

function modelForEntry(entry: SessionEntry): string | undefined {
  if (entry.type === 'message' && entry.message.role === 'assistant') {
    return usageKey(entry.message.provider, entry.message.responseModel ?? entry.message.model)
  }
  if (entry.type === 'usage') return usageKey(entry.provider, entry.model)
  if ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage) return 'Tools/summaries'
  return undefined
}

function addEntryUsage(
  entry: SessionEntry,
  totals: UsageAccumulator,
  models?: Map<string, UsageAccumulator>,
  includeToolResults = true,
): { readonly toolUsageUnattributed: boolean } {
  let usage: unknown
  let turns = 0
  if (entry.type === 'message' && entry.message.role === 'assistant') {
    usage = entry.message.usage
    turns = 1
  } else if (entry.type === 'message' && entry.message.role === 'toolResult') {
    if (!includeToolResults) return { toolUsageUnattributed: !!entry.message.usage }
    usage = entry.message.usage
  } else if (entry.type === 'usage') {
    usage = entry.usage
  } else if ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage) {
    usage = entry.usage
  }
  if (usage === undefined) return { toolUsageUnattributed: false }
  totals.add(usage, turns)
  const key = models ? modelForEntry(entry) : undefined
  if (models && key) {
    let modelTotals = models.get(key)
    if (!modelTotals) {
      modelTotals = new UsageAccumulator()
      models.set(key, modelTotals)
    }
    modelTotals.add(usage, turns)
  }
  return { toolUsageUnattributed: entry.type === 'message' && entry.message.role === 'toolResult' }
}

function totalsFromEntries(entries: readonly SessionEntry[], includeToolResults = true): {
  readonly totals: UsageTotals
  readonly toolUsageUnattributed: boolean
} {
  const totals = new UsageAccumulator()
  let toolUsageUnattributed = false
  for (const entry of entries) {
    const result = addEntryUsage(entry, totals, undefined, includeToolResults)
    toolUsageUnattributed ||= result.toolUsageUnattributed
  }
  return { totals: totals.snapshot(), toolUsageUnattributed }
}

function mapSnapshot(models: Map<string, UsageAccumulator>): Readonly<Record<string, UsageTotals>> {
  return Object.fromEntries([...models.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([model, totals]) => [model, totals.snapshot()]))
}

function summarizeUnknown(...sets: readonly (readonly UsageUnknownMarker[])[]): readonly UsageUnknownMarker[] {
  return [...new Set(sets.flat())].sort()
}

function unknownForTotals(totals: UsageTotals): UsageUnknownMarker[] {
  const result: UsageUnknownMarker[] = []
  if (totals.input === null || totals.output === null || totals.cacheRead === null || totals.cacheWrite === null) {
    result.push('usage-unavailable')
  }
  if (totals.costMicros === null) result.push('cost-unavailable')
  return result
}

function withUnknownCost(totals: UsageTotals): UsageTotals {
  return { ...totals, costMicros: null }
}

function timestampOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function compactionMarkerFromEntry(entry: SessionEntry): UsageMarker | undefined {
  if (entry.type !== 'compaction') return undefined
  const details = isRecord(entry.details) ? entry.details : undefined
  const reason = details?.reason
  return {
    kind: 'compaction',
    phase: 'recorded',
    reason: reason === 'manual' || reason === 'threshold' || reason === 'overflow' ? reason : null,
    timestamp: timestampOf(entry.timestamp) ?? 0,
  }
}

function markerFromNativeEvent(event: AgentSessionEvent): UsageMarker | undefined {
  if (event.type === 'compaction_start') {
    return { kind: 'compaction', phase: 'start', reason: event.reason, timestamp: Date.now() }
  }
  if (event.type === 'compaction_end') {
    return {
      kind: 'compaction',
      phase: 'end',
      reason: event.reason,
      timestamp: Date.now(),
      aborted: event.aborted,
      willRetry: event.willRetry,
    }
  }
  if (event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled') {
    return {
      kind: 'retry',
      phase: 'start',
      timestamp: Date.now(),
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
    }
  }
  if (event.type === 'auto_retry_end' || event.type === 'summarization_retry_finished') {
    return { kind: 'retry', phase: 'end', timestamp: Date.now() }
  }
  if (event.type === 'summarization_retry_attempt_start') {
    return { kind: 'retry', phase: 'start', timestamp: Date.now() }
  }
  return undefined
}

function isSubagentUsage(summary: WorkerSummary): boolean {
  const usage = summary.usage
  return !!usage && (usage.input > 0 || usage.output > 0 || usage.cacheWrite > 0 || usage.cost > 0)
}

/** Reads only usage already persisted by Pi and native AgentSession message events. */
export class UsageService {
  private readonly operations: RuntimeOperations
  private readonly getWorkerRegistry: (runtimeId: string, scope: RuntimeScope) => WorkerRegistry | undefined
  private observer: RuntimeObserver | undefined
  private readonly listeners = new Set<UsageSubscriber>()

  constructor(
    operations: RuntimeOperations,
    getWorkerRegistry: (runtimeId: string, scope: RuntimeScope) => WorkerRegistry | undefined,
  ) {
    this.operations = operations
    this.getWorkerRegistry = getWorkerRegistry
  }

  /** Call during runtime startup so native and child events are observed from turn one. */
  watch(scope: RuntimeScope): void {
    this.ensureObserver(scope)
  }

  session(_caller: AuthorizedIpcCaller, scope: RuntimeScope, sessionId: string): UsageSessionResponse {
    const source = this.resolveSession(scope, sessionId)
    const entries = source.manager.getEntries()
    const branchEntries = source.manager.getBranch()
    const all = totalsFromEntries(entries)
    const branch = totalsFromEntries(branchEntries)
    const toolCostUnknown = this.toolResultCostUnknown(source, entries)
    const sessionTotals = toolCostUnknown ? withUnknownCost(all.totals) : all.totals
    const branchTotals = toolCostUnknown && this.hasToolResultUsage(branchEntries)
      ? withUnknownCost(branch.totals)
      : branch.totals
    const markers = this.markersFor(source, entries)
    return {
      runtime: { ...scope },
      sessionId,
      branch: branchTotals,
      session: sessionTotals,
      markers,
      unknown: summarizeUnknown(
        unknownForTotals(branchTotals),
        unknownForTotals(sessionTotals),
        all.toolUsageUnattributed ? ['tool-usage-unattributed'] : [],
      ),
    }
  }

  turn(_caller: AuthorizedIpcCaller, scope: RuntimeScope, sessionId: string): UsageTurnResponse {
    const source = this.resolveSession(scope, sessionId)
    const observer = this.observer
    const latest = source.active && observer?.latestTurn
      ? observer.latestTurn
      : this.latestTurnFromBranch(source.manager.getBranch())
    return {
      runtime: { ...scope },
      sessionId,
      turn: latest ?? new UsageAccumulator().snapshot(),
      unknown: unknownForTotals(latest ?? new UsageAccumulator().snapshot()),
    }
  }

  workers(_caller: AuthorizedIpcCaller, scope: RuntimeScope, sessionId: string): UsageWorkersResponse {
    const source = this.resolveSession(scope, sessionId)
    const observer = this.observer
    const result = source.active && observer ? this.workerSnapshot(observer, source.manager) : {
      workers: {},
      unknown: ['worker-provider-unavailable'] as UsageUnknownMarker[],
    }
    return { runtime: { ...scope }, sessionId, workers: result.workers, unknown: result.unknown }
  }

  models(_caller: AuthorizedIpcCaller, scope: RuntimeScope, sessionId: string): UsageModelsResponse {
    const source = this.resolveSession(scope, sessionId)
    const branchModels = this.modelsFromEntries(source.manager.getBranch())
    const sessionModels = this.modelsFromEntries(source.manager.getEntries())
    const toolUsageUnattributed = this.hasToolResultUsage(source.manager.getEntries())
    if (source.active && this.observer) this.addWorkerModels(this.observer, sessionModels)
    const branch = mapSnapshot(branchModels)
    const session = mapSnapshot(sessionModels)
    const workerProvider = source.active && this.observer?.workerRegistry
      ? this.observer.workerRegistry.list().providerState
      : 'provider-unavailable'
    const unknown = summarizeUnknown(
      this.unknownFromModelMap(branch),
      this.unknownFromModelMap(session),
      toolUsageUnattributed ? ['tool-usage-unattributed', 'model-attribution-incomplete'] : [],
      workerProvider !== 'available' ? ['worker-provider-unavailable'] : [],
    )
    return { runtime: { ...scope }, sessionId, branch, session, unknown }
  }

  subscribe(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    publish: (payload: UsageEventPayload) => void,
  ): () => void {
    const runtime = this.ensureObserver(scope)
    const subscriber: UsageSubscriber = {
      callerKey: callerKey(caller),
      runtimeId: runtime.runtimeId,
      scope: { ownerId: scope.ownerId, generation: scope.generation },
      publish,
    }
    this.listeners.add(subscriber)
    return () => {
      if (this.listeners.has(subscriber) && subscriber.callerKey === callerKey(caller)) {
        this.listeners.delete(subscriber)
      }
    }
  }

  dispose(): void {
    this.stopObserver()
    this.listeners.clear()
  }

  private ensureObserver(scope: RuntimeScope): RuntimeOperationRuntime {
    const runtime = this.operations.resolve(scope)
    if (!runtime) throw new Error('The runtime scope is no longer current.')
    if (this.observer?.runtimeId === runtime.runtimeId && this.observer.session === runtime.host.session) {
      this.ensureWorkerRegistry(this.observer)
      return runtime
    }
    this.stopObserver()
    const session = runtime.host.session
    const observer: RuntimeObserver = {
      runtimeId: runtime.runtimeId,
      scope: { ownerId: scope.ownerId, generation: scope.generation },
      sessionId: session.sessionId,
      session,
      unsubscribeNative: () => undefined,
      unsubscribeSession: () => undefined,
      unsubscribeWorkers: () => undefined,
      latestTurn: null,
      markers: [],
      workerUsage: new Map(),
      seenWorkerEvents: new WeakSet(),
    }
    this.observer = observer
    this.bindNativeSession(observer, session)
    const host = runtime.host as RuntimeOperationRuntime['host'] & SessionEventHost
    if (typeof host.subscribeSessionEvents === 'function') {
      observer.unsubscribeSession = host.subscribeSessionEvents((event) => {
        if (this.observer !== observer || !sameScope(event.runtime, observer.scope)) return
        const current = this.operations.resolve(observer.scope)
        if (!current || current.runtimeId !== observer.runtimeId) return
        if (current.host.session !== observer.session || event.sessionId !== observer.sessionId) {
          this.bindNativeSession(observer, current.host.session)
          this.ensureWorkerRegistry(observer)
        }
      })
    }
    this.ensureWorkerRegistry(observer)
    return runtime
  }

  private bindNativeSession(observer: RuntimeObserver, session: AgentSession): void {
    observer.unsubscribeNative()
    observer.unsubscribeWorkers()
    observer.unsubscribeWorkers = () => undefined
    observer.workerRegistry = undefined
    observer.workerUsage.clear()
    observer.seenWorkerEvents = new WeakSet()
    observer.session = session
    observer.sessionId = session.sessionId
    observer.latestTurn = null
    observer.markers.length = 0
    observer.unsubscribeNative = session.subscribe((event) => {
      if (this.observer !== observer || observer.session !== session) return
      const current = this.operations.resolve(observer.scope)
      if (!current || current.runtimeId !== observer.runtimeId || current.host.session !== session) return
      let changed = false
      if (event.type === 'turn_end' && event.message.role === 'assistant') {
        const turn = new UsageAccumulator()
        turn.add(event.message.usage, 1)
        observer.latestTurn = turn.snapshot()
        changed = true
      }
      const marker = markerFromNativeEvent(event)
      if (marker) {
        observer.markers.push(marker)
        if (observer.markers.length > MAX_LIVE_MARKERS) observer.markers.splice(0, observer.markers.length - MAX_LIVE_MARKERS)
        changed = true
      }
      if (changed) this.publish(observer)
    })
  }

  private ensureWorkerRegistry(observer: RuntimeObserver): void {
    const registry = this.getWorkerRegistry(observer.runtimeId, observer.scope)
    if (registry === observer.workerRegistry) return
    observer.unsubscribeWorkers()
    observer.unsubscribeWorkers = () => undefined
    observer.workerRegistry = registry
    observer.workerUsage.clear()
    if (!registry || !registry.isCurrentScope(observer.scope)) return

    // Seed retained native messages before replay. WorkerSummary.usage is deliberately not
    // used as a total: tintinweb adds every descendant's lifetime usage to each ancestor.
    for (const summary of registry.list().workers) {
      const snapshot = registry.snapshot(summary.id)
      if (!snapshot) continue
      const state = this.workerState(observer, summary.id)
      for (const message of snapshot.messages) addWorkerMessage(state, message)
    }
    observer.unsubscribeWorkers = registry.subscribe(INTERNAL_CALLER, observer.scope, (event) => {
      if (this.observer !== observer || !registry.isCurrentScope(observer.scope)) return
      if (observer.seenWorkerEvents.has(event)) return
      observer.seenWorkerEvents.add(event)
      let changed = false
      if (event.type === 'message-ended') {
        const state = this.workerState(observer, event.workerId)
        changed = addWorkerMessage(state, event.message)
      }
      if (changed) this.publish(observer)
    })
  }

  private stopObserver(): void {
    const observer = this.observer
    if (!observer) return
    this.observer = undefined
    observer.unsubscribeNative()
    observer.unsubscribeSession()
    observer.unsubscribeWorkers()
  }

  private resolveSession(scope: RuntimeScope, sessionId: string): SessionUsageSource {
    const runtime = this.ensureObserver(scope)
    const activeManager = runtime.host.session.sessionManager
    if (runtime.host.session.sessionId === sessionId) return { manager: activeManager, active: true }
    const path = SessionManager.findById(activeManager.getCwd(), sessionId, activeManager.getSessionDir())
    if (!path) throw new Error('The requested native session was not found.')
    const manager = SessionManager.open(path, activeManager.getSessionDir())
    if (manager.getSessionId() !== sessionId) throw new Error('The requested native session was not found.')
    return { manager, active: false }
  }

  private latestTurnFromBranch(entries: readonly SessionEntry[]): UsageTotals | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry?.type === 'message' && entry.message.role === 'assistant' && isRecord(entry.message.usage)) {
        const usage = new UsageAccumulator()
        usage.add(entry.message.usage, 1)
        return usage.snapshot()
      }
    }
    return null
  }

  private markersFor(source: SessionUsageSource, entries: readonly SessionEntry[]): readonly UsageMarker[] {
    const recorded = entries.flatMap((entry) => {
      const marker = compactionMarkerFromEntry(entry)
      return marker ? [marker] : []
    })
    const live = source.active && this.observer ? this.observer.markers : []
    return [...recorded, ...live].sort((left, right) => left.timestamp - right.timestamp).slice(-MAX_OUTPUT_MARKERS)
  }

  private modelsFromEntries(entries: readonly SessionEntry[]): Map<string, UsageAccumulator> {
    const result = new Map<string, UsageAccumulator>()
    for (const entry of entries) {
      // Child usage attached to tool results is an aggregate, not a separate model call.
      // Child message events are attributed below, exactly once, to their own models.
      addEntryUsage(entry, new UsageAccumulator(), result, false)
    }
    return result
  }

  private hasToolResultUsage(entries: readonly SessionEntry[]): boolean {
    return entries.some((entry) => entry.type === 'message'
      && entry.message.role === 'toolResult'
      && entry.message.usage !== undefined)
  }

  private hasUsageEntries(entries: readonly SessionEntry[], includeToolResults: boolean): boolean {
    return entries.some((entry) => {
      if (entry.type === 'message') {
        if (entry.message.role === 'assistant') return entry.message.usage !== undefined
        return includeToolResults && entry.message.role === 'toolResult' && entry.message.usage !== undefined
      }
      return entry.type === 'usage'
        || (entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage !== undefined
    })
  }

  private toolResultCostUnknown(source: SessionUsageSource, entries: readonly SessionEntry[]): boolean {
    if (!this.hasToolResultUsage(entries)) return false
    const observer = this.observer
    if (!source.active || !observer?.workerRegistry) return true
    const registry = observer.workerRegistry
    if (!registry.isCurrentScope(observer.scope) || registry.list().providerState !== 'available') return true
    const unknown = this.workerSnapshot(observer, source.manager).unknown
    return unknown.includes('worker-usage-incomplete') || unknown.includes('cost-unavailable')
  }

  private addWorkerModels(observer: RuntimeObserver, models: Map<string, UsageAccumulator>): void {
    for (const state of observer.workerUsage.values()) {
      for (const [model, totals] of state.modelTotals) {
        let existing = models.get(model)
        if (!existing) {
          existing = new UsageAccumulator()
          models.set(model, existing)
        }
        existing.addTotals(totals.snapshot())
      }
    }
  }

  private unknownFromModelMap(models: Readonly<Record<string, UsageTotals>>): UsageUnknownMarker[] {
    return Object.values(models).flatMap(unknownForTotals)
  }

  private workerState(observer: RuntimeObserver, workerId: string): WorkerUsageState {
    let state = observer.workerUsage.get(workerId)
    if (!state) {
      state = newWorkerUsageState()
      observer.workerUsage.set(workerId, state)
    }
    return state
  }

  private workerSnapshot(observer: RuntimeObserver, manager: SessionManager): {
    readonly workers: Readonly<Record<string, UsageWorkerTotals>>
    readonly unknown: readonly UsageUnknownMarker[]
  } {
    const entries = manager.getEntries()
    const rootOwn = totalsFromEntries(entries, false).totals
    const registry = observer.workerRegistry
    const registryResult = registry?.list()
    const summaries = registryResult?.workers ?? []
    const ancestryById = new Map<string, readonly string[]>()
    for (const summary of summaries) {
      ancestryById.set(summary.id, registry?.snapshot(summary.id)?.ancestry ?? [])
    }

    const ownById = new Map<string, UsageAccumulator>()
    const aggregateById = new Map<string, UsageAccumulator>()
    const unknown: UsageUnknownMarker[] = []
    const rootAggregate = new UsageAccumulator()
    if (this.hasUsageEntries(entries, false)) rootAggregate.addTotals(rootOwn)
    for (const summary of summaries) {
      const state = observer.workerUsage.get(summary.id)
      const own = state?.totals ?? new UsageAccumulator()
      ownById.set(summary.id, own)
      const aggregate = new UsageAccumulator()
      if (state && state.seenMessages.size > 0) aggregate.addTotals(own.snapshot())
      aggregateById.set(summary.id, aggregate)
    }

    for (const summary of summaries) {
      const own = ownById.get(summary.id)
      if (!own) continue
      const state = observer.workerUsage.get(summary.id)
      if (!state || state.seenMessages.size === 0) continue
      const ownTotals = own.snapshot()
      rootAggregate.addTotals(ownTotals)
      for (const ancestorId of ancestryById.get(summary.id) ?? []) {
        const ancestor = aggregateById.get(ancestorId)
        if (ancestor) ancestor.addTotals(ownTotals)
      }
      // tintinweb's lifetimeUsage includes descendants. The comparison below checks
      // the event-derived hierarchy without trusting that double-booked aggregate.
    }

    if (!registry || !registry.isCurrentScope(observer.scope) || registryResult?.providerState !== 'available') {
      unknown.push('worker-provider-unavailable')
    }

    const workers: Record<string, UsageWorkerTotals> = {}
    const rootModel = observer.session.model
      ? `${observer.session.model.provider}/${observer.session.model.id}`
      : null
    workers[observer.sessionId] = {
      id: observer.sessionId,
      parentId: null,
      rootId: observer.sessionId,
      ancestry: [],
      name: 'root session',
      model: rootModel,
      totals: rootAggregate.snapshot(),
    }

    for (const summary of summaries) {
      const ancestry = ancestryById.get(summary.id) ?? []
      const aggregate = aggregateById.get(summary.id)
      if (!aggregate) continue
      workers[summary.id] = {
        id: summary.id,
        parentId: summary.parentId,
        rootId: summary.rootId,
        ancestry,
        name: summary.name,
        model: summary.model,
        totals: aggregate.snapshot(),
      }
      if (isSubagentUsage(summary)) {
        const actual = aggregate.snapshot()
        const usage = summary.usage!
        if (actual.input === null || actual.input !== usage.input
          || actual.output === null || actual.output !== usage.output
          || actual.cacheWrite === null || actual.cacheWrite !== usage.cacheWrite) {
          unknown.push('worker-usage-incomplete')
        }
      }
    }

    for (const totals of [rootAggregate.snapshot(), ...Object.values(workers).map((worker) => worker.totals)]) {
      unknown.push(...unknownForTotals(totals))
    }
    // Root native tool-result usage is the tintinweb child-usage carrier. It is omitted
    // from root worker totals because its child assistant messages are already counted.
    if (this.hasToolResultUsage(entries)) unknown.push('tool-usage-unattributed')
    return { workers, unknown: summarizeUnknown(unknown) }
  }

  private buildEventPayload(observer: RuntimeObserver): UsageEventPayload | undefined {
    const runtime = this.operations.resolve(observer.scope)
    if (!runtime || runtime.runtimeId !== observer.runtimeId || runtime.host.session !== observer.session) return undefined
    const manager = observer.session.sessionManager
    const entries = manager.getEntries()
    const branchEntries = manager.getBranch()
    const branchRaw = totalsFromEntries(branchEntries).totals
    const sessionRaw = totalsFromEntries(entries)
    const toolCostUnknown = this.toolResultCostUnknown({ manager, active: true }, entries)
    const sessionTotals = toolCostUnknown ? withUnknownCost(sessionRaw.totals) : sessionRaw.totals
    const branchTotals = toolCostUnknown && this.hasToolResultUsage(branchEntries)
      ? withUnknownCost(branchRaw)
      : branchRaw
    const modelTotals = this.modelsFromEntries(entries)
    this.addWorkerModels(observer, modelTotals)
    const modelSnapshot = mapSnapshot(modelTotals)
    const workerSnapshot = this.workerSnapshot(observer, manager)
    const turn = observer.latestTurn ?? this.latestTurnFromBranch(manager.getBranch()) ?? new UsageAccumulator().snapshot()
    const unknown = summarizeUnknown(
      unknownForTotals(turn),
      unknownForTotals(branchTotals),
      unknownForTotals(sessionTotals),
      this.unknownFromModelMap(modelSnapshot),
      workerSnapshot.unknown,
      this.hasToolResultUsage(entries) ? ['tool-usage-unattributed', 'model-attribution-incomplete'] : [],
    )
    return {
      runtime: { ...observer.scope },
      sessionId: observer.sessionId,
      turn,
      branch: branchTotals,
      session: sessionTotals,
      models: modelSnapshot,
      workers: workerSnapshot.workers,
      markers: this.markersFor({ manager, active: true }, entries),
      unknown,
    }
  }

  private publish(observer: RuntimeObserver): void {
    const payload = this.buildEventPayload(observer)
    if (!payload) return
    for (const listener of [...this.listeners]) {
      if (listener.runtimeId !== observer.runtimeId
        || !sameScope(listener.scope, observer.scope)
        || !this.operations.resolve(listener.scope)) continue
      try {
        listener.publish(payload)
      } catch {
        // An observer must not interrupt native AgentSession execution.
      }
    }
  }
}
