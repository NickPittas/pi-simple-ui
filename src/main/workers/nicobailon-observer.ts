import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, watch, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { AgentSessionEvent, JSONValue } from '@earendil-works/pi-coding-agent'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import { WORKER_SNAPSHOT_MAX_LIMIT } from '../../shared/workers.ts'
import type {
  NicobailonWorkerDetails,
  WorkerEvent,
  WorkerStatus,
  WorkerSummary,
  WorkerUsage,
} from '../../shared/workers.ts'
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_ASYNC_STARTED_EVENT,
  SUBAGENT_WORKER_EVENT,
  subagentAsyncRunsDirectory,
  subagentNestedEventsDirectory,
  type SubagentWorkerObservation,
} from '@app/pi-subagents-nicobailon/worker-observer'
import type { WorkerHistoryServices } from './tintinweb-observer.ts'
import { toWorkerEvents, toWorkerJson } from './worker-events.ts'
import type { NicobailonWorkerControls } from './nicobailon-controls.ts'
import type { WorkerRegistry } from './worker-registry.ts'

export interface NicobailonEventBus {
  on(event: string, handler: (payload: unknown) => void): () => void
}

export interface NicobailonObserverOptions {
  readonly events: NicobailonEventBus
  readonly registry: WorkerRegistry
  readonly scope: RuntimeScope
  readonly controls: NicobailonWorkerControls
  readonly history?: WorkerHistoryServices
  /** If set, ignore async runs started from another root Pi session. */
  readonly rootSessionId?: string
  readonly onDiagnostic?: (message: string) => void
}

interface RunWatch {
  readonly runId: string
  readonly asyncDir: string
  readonly rootSessionId: string
  readonly parentSessionId: string | null
  readonly toolCallId?: string
  readonly parentRunId: string | null
  readonly parentStepIndex?: number
  readonly watcher: FSWatcher
  nested?: NestedWatch
  decoder: StringDecoder
  offset: number
  pending: string
  finished: boolean
  transcriptUnavailable: boolean
}

interface NestedWatch {
  readonly directory: string
  readonly rootRunId: string
  readonly capabilityToken: string
  readonly watcher: FSWatcher
  readonly seen: Set<string>
  readonly activeRuns: Set<string>
}

interface WorkerRecord {
  readonly id: string
  readonly runId: string
  readonly index: number
  readonly agent: string
  readonly cwd: string
  readonly parentSessionId: string | null
  readonly asyncDir: string | null
  readonly messages: JSONValue[]
  readonly ancestry: string[]
  startedAt: number
  completedAt: number | null
  status: WorkerStatus
  sessionId: string | null
  sessionFile: string | null
  nativeSessionId: string | null
  nativeSessionPath: string | null
  toolCallId: string | null
  rootToolCallId: string | null
  transcript: NicobailonWorkerDetails['transcript']
  model: string | null
  error: string | null
  usage: WorkerUsage | null
  identityKey: string | null
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max = 4_096): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
    ? value
    : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function within(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}

function workerId(runId: string, index: number, sessionId?: string | null): string {
  const nativeSession = sessionId ? `session\0${sessionId}` : `${runId}\0${index}`
  const key = createHash('sha256').update(nativeSession).digest('hex').slice(0, 32)
  return `nicobailon:${key}`
}

function runStepKey(runId: string, index: number): string {
  return `${runId}\0${index}`
}

function usageFrom(value: unknown): WorkerUsage | null {
  if (!record(value)) return null
  const input = nonNegative(value.input)
  const output = nonNegative(value.output)
  const cacheWrite = nonNegative(value.cacheWrite)
  const cost = nonNegative(value.cost)
  if (input === undefined || output === undefined || cacheWrite === undefined || cost === undefined) return null
  return { input, output, cacheWrite, cost }
}

function asyncStarted(value: unknown): {
  runId: string
  asyncDir: string
  rootSessionId: string
  parentSessionId: string | null
  toolCallId?: string
  parentRunId: string | null
  nestedRoute?: { rootRunId: string; eventSink: string; capabilityToken: string }
} | undefined {
  if (!record(value)) return undefined
  const runId = text(value.id, 256)
  const asyncDir = text(value.asyncDir)
  const rootSessionId = text(value.sessionId)
  if (!runId || !asyncDir || !rootSessionId) return undefined
  const route = record(value.nestedRoute) ? value.nestedRoute : undefined
  return {
    runId,
    asyncDir,
    rootSessionId,
    parentSessionId: text(value.parentSessionId, 256) ?? null,
    ...(text(value.toolCallId, 256) ? { toolCallId: text(value.toolCallId, 256) } : {}),
    parentRunId: text(value.parentWorkflowRunId, 256) ?? null,
    ...(route
      && route.rootRunId === runId
      && text(route.eventSink)
      && text(route.capabilityToken, 256)
      ? { nestedRoute: { rootRunId: runId, eventSink: route.eventSink as string, capabilityToken: route.capabilityToken as string } }
      : {}),
  }
}

function subagentObservation(value: unknown): value is SubagentWorkerObservation {
  return record(value)
    && value.version === 1
    && (value.type === 'child-started' || value.type === 'child-event' || value.type === 'child-settled')
    && text(value.runId, 256) !== undefined
    && Number.isSafeInteger(value.index)
    && (value.index as number) >= 0 && (value.index as number) <= 1_000_000
    && text(value.agent, 512) !== undefined
    && text(value.cwd) !== undefined
    && (value.parentSessionId === null || text(value.parentSessionId) !== undefined)
    && (value.toolCallId === undefined || text(value.toolCallId, 256) !== undefined)
    && (value.sessionId === null || text(value.sessionId) !== undefined)
    && (value.sessionFile === null || text(value.sessionFile) !== undefined)
    && number(value.timestamp) !== undefined
    && (value.controls === undefined || (record(value.controls)
      && typeof value.controls.steer === 'function'
      && typeof value.controls.abort === 'function'))
}

function backgroundObservation(value: unknown): {
  runId: string
  index: number
  agent: string
  cwd: string
  sessionId: string | null
  sessionFile: string | null
  timestamp: number
  event: Record<string, unknown>
} | undefined {
  if (!record(value) || value.subagentSource !== 'child') return undefined
  const runId = text(value.subagentRunId, 256)
  const index = value.subagentStepIndex
  const agent = text(value.subagentAgent, 512)
  const cwd = text(value.subagentCwd)
  if (!runId || !Number.isSafeInteger(index) || (index as number) < 0 || (index as number) > 1_000_000 || !agent || !cwd) return undefined
  const event = { ...value }
  for (const key of ['subagentSource', 'subagentRunId', 'subagentStepIndex', 'subagentAgent', 'subagentSessionId', 'subagentSessionFile', 'subagentCwd', 'observedAt']) {
    delete event[key]
  }
  return {
    runId,
    index: index as number,
    agent,
    cwd,
    sessionId: text(value.subagentSessionId, 256) ?? null,
    sessionFile: text(value.subagentSessionFile) ?? null,
    timestamp: number(value.observedAt) ?? Date.now(),
    event,
  }
}

/** Runtime-generation-owned adapter for nicobailon's native worker events. */
export class NicobailonWorkerObserver {
  readonly scope: RuntimeScope
  private readonly registry: WorkerRegistry
  private readonly controls: NicobailonWorkerControls
  private readonly history: WorkerHistoryServices | undefined
  private readonly rootSessionId: string | undefined
  private readonly onDiagnostic: (message: string) => void
  private readonly workers = new Map<string, WorkerRecord>()
  private readonly sessionWorkers = new Map<string, string>()
  private readonly runStepWorkers = new Map<string, string>()
  private readonly runs = new Map<string, RunWatch>()
  private readonly restoring = new Set<string>()
  private readonly unsubscribes: Array<() => void>
  private disposed = false

  constructor(options: NicobailonObserverOptions) {
    this.scope = Object.freeze({ ownerId: options.scope.ownerId, generation: options.scope.generation })
    this.registry = options.registry
    this.controls = options.controls
    this.history = options.history
    this.rootSessionId = options.rootSessionId
    this.onDiagnostic = options.onDiagnostic ?? (() => {})
    this.registry.setProviderState('available')
    this.unsubscribes = [
      options.events.on(SUBAGENT_WORKER_EVENT, (payload) => this.observeForeground(payload)),
      options.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (payload) => this.observeAsyncStarted(payload)),
      options.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (payload) => this.observeAsyncComplete(payload)),
    ]
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.unsubscribes) {
      try { unsubscribe() } catch { /* Best-effort event teardown. */ }
    }
    for (const run of this.runs.values()) {
      run.watcher.close()
      run.nested?.watcher.close()
    }
    this.runs.clear()
    this.controls.dispose()
    this.workers.clear()
    this.sessionWorkers.clear()
    this.runStepWorkers.clear()
    this.restoring.clear()
  }

  private isCurrent(): boolean {
    return !this.disposed && this.registry.isCurrentScope(this.scope)
  }

  private diagnostic(message: string): void {
    this.registry.setProviderState('partial')
    try { this.onDiagnostic(message) } catch { /* Diagnostics are advisory. */ }
  }

  private observeForeground(value: unknown): void {
    if (!this.isCurrent() || !subagentObservation(value)) return
    if (this.rootSessionId && value.parentSessionId !== this.rootSessionId
      && !this.sessionWorkers.has(value.parentSessionId ?? '')) return
    const key = runStepKey(value.runId, value.index)
    const id = this.runStepWorkers.get(key) ?? workerId(value.runId, value.index, value.sessionId)
    if (value.type === 'child-started' && value.controls) this.controls.registerForeground(id, value.controls)
    if (value.type === 'child-settled') this.controls.unregister(id)
    const summary = this.applyNativeObservation(value)
    if (!summary) return
    if (value.type === 'child-settled') {
      const worker = this.workers.get(summary.id)
      if (worker && (worker.transcript === 'unavailable' || worker.transcript === 'file-live')) {
        void this.restoreNativeTranscript(worker)
      }
    }
  }

  private observeAsyncStarted(value: unknown): void {
    if (!this.isCurrent()) return
    const start = asyncStarted(value)
    if (!start || (this.rootSessionId
      && start.parentSessionId !== this.rootSessionId
      && !this.sessionWorkers.has(start.parentSessionId ?? ''))) return
    const asyncRoot = subagentAsyncRunsDirectory()
    let asyncDir: string
    try {
      const canonicalRoot = realpathSync(asyncRoot)
      asyncDir = realpathSync(start.asyncDir)
      if (!within(canonicalRoot, asyncDir)) throw new Error('The async run directory is outside nicobailon’s configured run root.')
      if (!existsSync(join(asyncDir, 'events.jsonl'))) {
        // The native run may not have created its event log yet; the directory is still watched.
      }
    } catch (error) {
      this.diagnostic(`Could not attach to a native nicobailon run: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const { nestedRoute, ...runStart } = start
    this.watchAsyncRun(runStart, asyncDir)
    const run = this.runs.get(start.runId)
    if (run && nestedRoute) this.watchNestedRoute(run, nestedRoute)
  }

  private watchAsyncRun(
    start: { runId: string; rootSessionId: string; parentSessionId: string | null; toolCallId?: string; parentRunId: string | null; parentStepIndex?: number },
    asyncDir: string,
  ): void {
    const previous = this.runs.get(start.runId)
    if (previous) {
      previous.watcher.close()
      previous.nested?.watcher.close()
    }
    try {
      const watcher = watch(asyncDir, { persistent: false }, (_event, filename) => {
        if (filename === null || String(filename) === 'events.jsonl') this.drainRun(start.runId)
      })
      watcher.on('error', (error) => {
        const run = this.runs.get(start.runId)
        if (run) {
          run.transcriptUnavailable = true
          for (const worker of this.workers.values()) {
            if (worker.runId !== start.runId) continue
            worker.transcript = 'unavailable'
            this.refreshControls(worker.id)
            if (worker.status !== 'running') void this.restoreNativeTranscript(worker)
          }
        }
        this.diagnostic(`Native nicobailon event watch stopped: ${error.message}`)
      })
      const run: RunWatch = {
        ...start,
        asyncDir,
        watcher,
        decoder: new StringDecoder('utf8'),
        offset: 0,
        pending: '',
        finished: false,
        transcriptUnavailable: false,
      }
      this.runs.set(start.runId, run)
      this.drainRun(start.runId)
    } catch (error) {
      this.diagnostic(`Native nicobailon event watch could not be installed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private watchNestedRoute(
    parentRun: RunWatch,
    route: { rootRunId: string; eventSink: string; capabilityToken: string },
  ): void {
    if (route.rootRunId !== parentRun.runId) return
    try {
      const canonicalRoot = realpathSync(subagentNestedEventsDirectory())
      const directory = realpathSync(route.eventSink)
      if (!within(canonicalRoot, directory)) throw new Error('The nested event route is outside nicobailon’s configured event root.')
      const watcher = watch(directory, { persistent: false }, () => this.scanNestedRoute(parentRun.runId))
      watcher.on('error', (error) => {
        this.diagnostic(`Native nicobailon nested event watch stopped: ${error.message}`)
      })
      parentRun.nested = {
        directory,
        rootRunId: route.rootRunId,
        capabilityToken: route.capabilityToken,
        watcher,
        seen: new Set(),
        activeRuns: new Set(),
      }
      this.scanNestedRoute(parentRun.runId)
    } catch (error) {
      this.diagnostic(`Native nicobailon nested events could not be observed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private scanNestedRoute(parentRunId: string): void {
    if (!this.isCurrent()) return
    const parentRun = this.runs.get(parentRunId)
    const nested = parentRun?.nested
    if (!nested) return
    let files: string[]
    try {
      files = readdirSync(nested.directory).sort()
    } catch (error) {
      this.diagnostic(`Native nicobailon nested event records could not be listed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      if (nested.seen.has(file)) continue
      if (nested.seen.size >= 10_000) {
        this.diagnostic('The native nicobailon nested event record limit was reached.')
        nested.watcher.close()
        return
      }
      nested.seen.add(file)
      try {
        const content = readFileSync(join(nested.directory, file), 'utf8')
        if (Buffer.byteLength(content, 'utf8') > 64 * 1_024) continue
        const value: unknown = JSON.parse(content)
        if (!record(value)
          || value.rootRunId !== nested.rootRunId
          || value.capabilityToken !== nested.capabilityToken
          || !['subagent.nested.started', 'subagent.nested.updated', 'subagent.nested.completed'].includes(value.type as string)
          || !record(value.child)) continue
        const child = value.child
        const childRunId = text(child.id, 256)
        const childAsyncDir = text(child.asyncDir)
        if (!childRunId || !childAsyncDir) continue
        if (value.type === 'subagent.nested.completed') nested.activeRuns.delete(childRunId)
        else nested.activeRuns.add(childRunId)
        const childSessionId = text(child.sessionId, 4_096) ?? parentRun.rootSessionId
        const asyncRoot = realpathSync(subagentAsyncRunsDirectory())
        const asyncDir = realpathSync(childAsyncDir)
        if (!within(asyncRoot, asyncDir)) throw new Error('A nested async run directory is outside nicobailon’s configured run root.')
        if (!this.runs.has(childRunId)) {
          const parentStepIndex = nonNegative(child.parentStepIndex)
          const parentRunId = text(child.parentRunId, 256) ?? parentRun.runId
          const parentWorkerId = parentStepIndex !== undefined && Number.isSafeInteger(parentStepIndex)
            ? this.runStepWorkers.get(runStepKey(parentRunId, parentStepIndex))
            : undefined
          const parentSessionId = parentWorkerId ? this.workers.get(parentWorkerId)?.sessionId ?? null : null
          this.watchAsyncRun({
            runId: childRunId,
            rootSessionId: childSessionId,
            parentSessionId,
            ...(text(child.toolCallId, 256) ? { toolCallId: text(child.toolCallId, 256) } : {}),
            parentRunId,
            ...(parentStepIndex !== undefined && Number.isSafeInteger(parentStepIndex) ? { parentStepIndex } : {}),
          }, asyncDir)
        }
        if (value.type === 'subagent.nested.completed') this.finishAsyncRun(childRunId)
        if (parentRun.finished && nested.activeRuns.size === 0) {
          nested.watcher.close()
          this.runs.delete(parentRun.runId)
        }
      } catch (error) {
        this.diagnostic(`A native nicobailon nested event record was ignored: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private observeAsyncComplete(value: unknown): void {
    if (!record(value)) return
    const runId = text(value.id, 256) ?? text(value.runId, 256)
    if (!runId) return
    this.finishAsyncRun(runId)
  }

  private finishAsyncRun(runId: string): void {
    this.drainRun(runId)
    const run = this.runs.get(runId)
    if (!run) return
    for (const worker of this.workers.values()) {
      if (worker.runId !== runId || worker.status !== 'running') continue
      worker.status = 'idle'
      worker.completedAt = Date.now()
      worker.error = 'The native async run ended without a child-settlement record; the outcome is unknown.'
      this.controls.unregister(worker.id)
      this.refreshControls(worker.id)
      if (worker.transcript === 'unavailable' || worker.transcript === 'file-live') {
        void this.restoreNativeTranscript(worker)
      }
    }
    run.watcher.close()
    run.finished = true
    if (!run.nested || run.nested.activeRuns.size === 0) {
      run.nested?.watcher.close()
      this.runs.delete(runId)
    }
  }

  private drainRun(runId: string): void {
    if (!this.isCurrent()) return
    const run = this.runs.get(runId)
    if (!run) return
    const eventPath = join(run.asyncDir, 'events.jsonl')
    let fd: number
    try {
      const fileStat = lstatSync(eventPath)
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || !within(run.asyncDir, realpathSync(eventPath))) {
        this.diagnostic('A native nicobailon event log path was not a regular file inside its run directory.')
        this.markRunTranscriptUnavailable(run.runId)
        return
      }
      fd = openSync(eventPath, 'r')
    } catch (error) {
      if (record(error) && error.code === 'ENOENT') return
      this.diagnostic(`Native nicobailon event log could not be opened: ${error instanceof Error ? error.message : String(error)}`)
      this.markRunTranscriptUnavailable(run.runId)
      return
    }
    try {
      const size = fstatSync(fd).size
      if (size < run.offset) {
        run.offset = 0
        run.pending = ''
        run.decoder = new StringDecoder('utf8')
        this.markRunTranscriptUnavailable(run.runId)
        this.diagnostic('A native nicobailon event log was truncated while being observed.')
      }
      const buffer = Buffer.allocUnsafe(64 * 1_024)
      while (run.offset < size) {
        const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, size - run.offset), run.offset)
        if (bytesRead <= 0) break
        run.offset += bytesRead
        this.consumeBackgroundText(run, run.decoder.write(buffer.subarray(0, bytesRead)))
      }
    } catch (error) {
      this.diagnostic(`Native nicobailon event log could not be read: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      closeSync(fd)
    }
  }

  private consumeBackgroundText(run: RunWatch, chunk: string): void {
    const textChunk = run.pending + chunk
    const lines = textChunk.split('\n')
    run.pending = lines.pop() ?? ''
    if (run.pending.length > 1_000_000) {
      run.pending = ''
      this.markRunTranscriptUnavailable(run.runId)
      this.diagnostic('An oversized native nicobailon event record was skipped.')
    }
    for (const line of lines) {
      if (!line) continue
      let value: unknown
      try { value = JSON.parse(line) } catch {
        this.markRunTranscriptUnavailable(run.runId)
        this.diagnostic('A malformed native nicobailon event record was skipped.')
        continue
      }
      if (record(value) && value.type === 'subagent.events.truncated') {
        this.markRunTranscriptUnavailable(run.runId)
        continue
      }
      const parsed = backgroundObservation(value)
      if (!parsed || parsed.runId !== run.runId) continue
      const parentSessionId = run.parentSessionId
      const stepKey = runStepKey(parsed.runId, parsed.index)
      const id = this.runStepWorkers.get(stepKey) ?? workerId(parsed.runId, parsed.index, parsed.sessionId)
      if (parsed.event.type === 'subagent:child-started') this.controls.registerAsync(id, { asyncDir: run.asyncDir, stepIndex: parsed.index })
      else if (parsed.event.type === 'subagent:child-settled') this.controls.unregister(id)
      const summary = this.applyBackgroundObservation(parsed, run, parentSessionId)
      if (summary && (parsed.event.type === 'subagent:child-started' || parsed.event.type === 'subagent:child-settled')) {
        this.refreshControls(summary.id)
      }
      if (summary && parsed.event.type === 'subagent:child-settled') {
        const worker = this.workers.get(summary.id)
        if (worker && (worker.transcript === 'unavailable' || worker.transcript === 'file-live')) {
          void this.restoreNativeTranscript(worker)
        }
      }
    }
  }

  private applyBackgroundObservation(
    event: NonNullable<ReturnType<typeof backgroundObservation>>,
    run: RunWatch,
    parentSessionId: string | null,
  ): WorkerSummary | undefined {
    return this.applyObservation({
      version: 1,
      type: event.event.type === 'subagent:child-started'
        ? 'child-started'
        : event.event.type === 'subagent:child-settled' ? 'child-settled' : 'child-event',
      runId: event.runId,
      index: event.index,
      agent: event.agent,
      cwd: event.cwd,
      parentSessionId,
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
      sessionId: event.sessionId,
      sessionFile: event.sessionFile,
      timestamp: event.timestamp,
      event: event.event,
      ...(event.event.status === 'completed' || event.event.status === 'failed' || event.event.status === 'aborted'
        ? { status: event.event.status }
        : {}),
      ...(text(event.event.model, 512) ? { model: text(event.event.model, 512) } : {}),
      ...(text(event.event.error, 20_000) ? { error: text(event.event.error, 20_000) } : {}),
      ...(usageFrom(event.event.usage) ? { usage: usageFrom(event.event.usage)! } : {}),
    }, run)
  }

  private applyNativeObservation(event: SubagentWorkerObservation): WorkerSummary | undefined {
    return this.applyObservation(event)
  }

  private applyObservation(event: SubagentWorkerObservation, run?: RunWatch): WorkerSummary | undefined {
    if (!this.isCurrent()) return undefined
    const stepKey = runStepKey(event.runId, event.index)
    const id = this.runStepWorkers.get(stepKey) ?? workerId(event.runId, event.index, event.sessionId)
    let current = this.workers.get(id)
    const isNew = !current
    let shouldUpdateSummary = isNew || event.type !== 'child-event'
    if (!current) {
      const parentId = event.parentSessionId ? this.sessionWorkers.get(event.parentSessionId) : undefined
      const linkedParentId = parentId ?? (run?.parentRunId && run.parentStepIndex !== undefined
        ? this.runStepWorkers.get(runStepKey(run.parentRunId, run.parentStepIndex))
        : undefined)
      const parentSummary = linkedParentId ? this.registry.snapshot(linkedParentId)?.summary : undefined
      const parentSnapshot = linkedParentId ? this.registry.snapshot(linkedParentId) : null
      const ancestry = parentSummary && parentSnapshot
        ? [...parentSnapshot.ancestry, parentSummary.id]
        : []
      current = {
        id,
        runId: event.runId,
        index: event.index,
        agent: event.agent.slice(0, 512),
        cwd: event.cwd,
        parentSessionId: event.parentSessionId,
        asyncDir: run?.asyncDir ?? null,
        messages: [],
        ancestry: ancestry.length > 64 ? [ancestry[0]!, ...ancestry.slice(-63)] : ancestry,
        startedAt: event.timestamp,
        completedAt: null,
        status: 'running',
        sessionId: event.sessionId,
        sessionFile: event.sessionFile,
        nativeSessionId: null,
        nativeSessionPath: null,
        transcript: run
          ? (run.transcriptUnavailable ? 'unavailable' : event.sessionFile ? 'file-live' : 'event-live')
          : event.sessionFile ? 'file-live' : 'event-live',
        model: null,
        error: null,
        usage: null,
        identityKey: null,
        toolCallId: event.toolCallId ?? run?.toolCallId ?? null,
        rootToolCallId: null,
      }
      this.workers.set(id, current)
      this.runStepWorkers.set(stepKey, id)
    }

    current.sessionId = event.sessionId ?? current.sessionId
    current.sessionFile = event.sessionFile ?? current.sessionFile
    current.toolCallId = event.toolCallId ?? run?.toolCallId ?? current.toolCallId
    if (this.rootSessionId && current.parentSessionId === this.rootSessionId && current.toolCallId) {
      current.rootToolCallId = current.toolCallId
    }
    if (current.sessionId) this.sessionWorkers.set(current.sessionId, id)
    if (event.type === 'child-event' && record(event.event)) {
      const nativeEvent = event.event
      if ((nativeEvent.type === 'message_end' || nativeEvent.type === 'tool_result_end')
        && nativeEvent.message !== undefined) {
        current.messages.push(toWorkerJson(nativeEvent.message))
        shouldUpdateSummary = true
      }
      const nativeMessage = record(nativeEvent.message) ? nativeEvent.message : undefined
      const model = text(event.model, 512) ?? (nativeMessage ? text(nativeMessage.model, 512) : undefined)
      if (model) current.model = model
      const usage = usageFrom(event.usage) ?? usageFrom(nativeEvent.usage) ?? (nativeMessage ? usageFrom(nativeMessage.usage) : null)
      if (usage) {
        const changed = !current.usage
          || current.usage.input !== usage.input
          || current.usage.output !== usage.output
          || current.usage.cacheWrite !== usage.cacheWrite
          || current.usage.cost !== usage.cost
        current.usage = usage
        if (changed) shouldUpdateSummary = true
      }
      if (nativeEvent.type === 'error') {
        current.error = text(nativeEvent.message, 20_000) ?? current.error
        if (current.error) {
          shouldUpdateSummary = true
          this.registry.appendEvent({ workerId: id, type: 'error', timestamp: event.timestamp, message: current.error })
        }
      }
      if (nativeEvent.type === 'message_update' && record(nativeEvent.assistantMessageEvent)) {
        const error = record(nativeEvent.assistantMessageEvent.error) ? nativeEvent.assistantMessageEvent.error : undefined
        const updateError = text(error?.errorMessage, 20_000) ?? text(error?.message, 20_000)
        if (updateError) {
          current.error = updateError
          shouldUpdateSummary = true
        }
      }
      const normalizedEvent = nativeEvent.type === 'message_update' && !record(nativeEvent.message)
        ? { ...nativeEvent, message: { role: 'assistant' } }
        : nativeEvent
      const workerEvents = nativeEvent.type === 'tool_result_end' && nativeEvent.message !== undefined
        ? [{ workerId: id, type: 'message-ended' as const, timestamp: event.timestamp, message: toWorkerJson(nativeEvent.message) }]
        : nativeEvent.type === 'message_update' && !record(nativeEvent.assistantMessageEvent)
        ? [{ workerId: id, type: 'session-event' as const, timestamp: event.timestamp, event: toWorkerJson(nativeEvent) }]
        : toWorkerEvents(id, normalizedEvent as unknown as AgentSessionEvent, event.timestamp)
      if (workerEvents) for (const workerEvent of workerEvents) this.registry.appendEvent(workerEvent)
    }

    if (event.type === 'child-settled') {
      current.status = event.status === 'aborted' ? 'aborted'
        : event.status === 'failed' ? 'failed'
          : event.status === 'completed' ? 'completed' : 'idle'
      current.completedAt = event.timestamp
      current.error = text(event.error, 20_000) ?? current.error
        ?? (event.status === undefined ? 'The native child settled without a recognized outcome.' : null)
      current.model = text(event.model, 512) ?? current.model
      current.usage = event.usage ?? current.usage
    } else if (record(event.event) && event.event.type === 'subagent:child-started') {
      current.startedAt = number(event.event.startedAt) ?? current.startedAt
      current.model = text(event.event.model, 512) ?? current.model
    } else if (record(event.event) && event.event.type === 'subagent:child-settled') {
      const status = event.event.status
      current.status = status === 'aborted' ? 'aborted'
        : status === 'failed' ? 'failed'
          : status === 'completed' ? 'completed' : 'idle'
      current.completedAt = number(event.event.completedAt) ?? event.timestamp
      current.error = text(event.event.error, 20_000) ?? current.error
        ?? (status === undefined ? 'The native child settled without a recognized outcome.' : null)
      current.model = text(event.event.model, 512) ?? current.model
      current.usage = usageFrom(event.event.usage) ?? current.usage
    }

    if (shouldUpdateSummary) this.captureNativeReference(current, event.type === 'child-settled'
      || (record(event.event) && event.event.type === 'subagent:child-settled'))
    const summary = this.summary(current)
    if (shouldUpdateSummary) {
      this.registry.upsert(summary, current.ancestry, current.messages, current.transcript === 'file-restored' ? true : null)
    }
    if (event.type === 'child-settled' || (record(event.event) && event.event.type === 'subagent:child-settled')) {
      const terminal: WorkerEvent = {
        workerId: id,
        type: 'agent-ended',
        timestamp: current.completedAt ?? event.timestamp,
        details: toWorkerJson({ status: current.status, error: current.error }),
      }
      this.registry.appendEvent(terminal)
    }
    return summary
  }

  private captureNativeReference(worker: WorkerRecord, finalAttempt = false): void {
    const history = this.history
    if (!history || !worker.sessionId || !worker.sessionFile) return
    const key = `${worker.sessionId}\0${worker.sessionFile}`
    if (worker.identityKey === key || (worker.identityKey === `attempted:${key}` && !finalAttempt)) return
    const reference = history.history.captureSessionReference(worker.id, worker.sessionFile, worker.sessionId, worker.cwd)
    if (!reference) {
      worker.identityKey = `attempted:${key}`
      return
    }
    try {
      const identity = history.identities.remember({
        provider: 'nicobailon',
        nativeSessionId: reference.nativeSessionId,
        preferredWorkerId: worker.id,
        ...(worker.parentSessionId && worker.parentSessionId.length <= 256 ? { parentSessionId: worker.parentSessionId } : {}),
        ...(this.rootSessionId ? { rootSessionId: this.rootSessionId } : {}),
        workflowId: worker.runId,
        ...(worker.toolCallId ? { toolCallId: worker.toolCallId } : {}),
        nativeSessionPath: reference.nativeSessionPath,
        nativeSessionDirectory: reference.nativeSessionDirectory,
        nativeSessionCwd: reference.nativeSessionCwd,
        ownerWorkspaceId: history.ownership.workspaceId,
        ownerWorkspacePath: history.ownership.workspacePath,
        ownerRuntimeId: history.ownership.runtimeId,
      })
      worker.nativeSessionId = reference.nativeSessionId
      worker.nativeSessionPath = reference.nativeSessionPath
      worker.rootToolCallId = identity.rootToolCallId
      worker.identityKey = key
      void history.history.restoreWorker(this.registry, worker.id)
    } catch (error) {
      this.diagnostic(`A native nicobailon session reference could not be retained: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private summary(worker: WorkerRecord): WorkerSummary {
    const controls = this.controls.availability(worker.id)
    const details: NicobailonWorkerDetails = {
      asyncRunId: worker.asyncDir ? worker.runId : null,
      stepIndex: worker.asyncDir ? worker.index : null,
      nativeSessionId: worker.nativeSessionId,
      nativeSessionPath: worker.nativeSessionPath,
      ...(this.rootSessionId ? { rootSessionId: this.rootSessionId } : {}),
      ...(worker.rootToolCallId ? { rootToolCallId: worker.rootToolCallId } : {}),
      transcript: worker.transcript,
      controls,
    }
    return {
      id: worker.id,
      parentId: worker.ancestry.at(-1) ?? null,
      rootId: worker.ancestry[0] ?? worker.id,
      name: worker.agent,
      type: 'subagent',
      description: '',
      status: worker.status,
      model: worker.model,
      startedAt: worker.startedAt,
      completedAt: worker.completedAt,
      usage: worker.usage,
      error: worker.error,
      source: 'live',
      provider: 'nicobailon',
      providerDetails: { nicobailon: details },
    }
  }

  private refreshControls(id: string): void {
    const worker = this.workers.get(id)
    if (!worker) return
    this.registry.upsert(this.summary(worker), worker.ancestry, worker.messages, worker.transcript === 'file-restored' ? true : null)
  }

  private markRunTranscriptUnavailable(runId: string): void {
    const run = this.runs.get(runId)
    if (run) run.transcriptUnavailable = true
    this.diagnostic('Native nicobailon event history is incomplete; session-file recovery will be attempted where available.')
    for (const worker of this.workers.values()) {
      if (worker.runId !== runId) continue
      worker.transcript = 'unavailable'
      this.refreshControls(worker.id)
      if (worker.status !== 'running') void this.restoreNativeTranscript(worker)
    }
  }

  private async restoreNativeTranscript(worker: WorkerRecord): Promise<void> {
    const history = this.history
    if (!history || !this.isCurrent()
      || (worker.transcript !== 'unavailable' && worker.transcript !== 'file-live')
      || !worker.sessionId || !worker.sessionFile
      || this.restoring.has(worker.id)) return
    this.restoring.add(worker.id)
    try {
      const messages: JSONValue[] = []
      let offset = 0
      for (;;) {
        const page = await history.history.page(this.registry, worker.id, offset, WORKER_SNAPSHOT_MAX_LIMIT)
        if (!page || !this.isCurrent() || this.workers.get(worker.id) !== worker) return
        messages.push(...page.messages)
        if (page.nextOffset === null) {
          worker.messages.splice(0, worker.messages.length, ...messages)
          this.registry.replaceMessages(worker.id, messages)
          worker.transcript = 'file-restored'
          this.refreshControls(worker.id)
          return
        }
        offset = page.nextOffset
      }
    } catch (error) {
      this.diagnostic(`Native nicobailon transcript recovery failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.restoring.delete(worker.id)
    }
  }
}

export function createNicobailonWorkerObserver(options: NicobailonObserverOptions): NicobailonWorkerObserver {
  return new NicobailonWorkerObserver(options)
}
