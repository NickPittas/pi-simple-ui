import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type {
  CodemodeBudgets,
  CodemodeCallStatus,
  CodemodeCallTrace,
  CodemodeCatalogNamespace,
  CodemodeCatalogResponse,
  CodemodeCatalogTool,
  CodemodeEventPayload,
  CodemodeExecutionStatus,
  CodemodeJsonValue,
  CodemodeSettings,
  CodemodeTrace,
} from '../../shared/codemode.ts'
import type { SessionEventEnvelope } from '../../shared/sessions.ts'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'
import type { RuntimeOperations, RuntimeOperationRuntime } from '../pi/runtime-operations.ts'
import type { CodemodeTraceStore } from './trace-store.ts'

const DEFAULT_INLINE_BUDGET = 3000
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000
const DEFAULT_TIMEOUT_MS = 300_000
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024
const MAX_OUTPUT_ITEMS = 100_000
const MAX_CONCURRENT_MODEL_CALLS = 4
const DEFAULT_TOOL_CALL_BUDGET = null

interface MutableCall {
  id: string
  parentId?: string
  name: string
  namespace?: string
  args: CodemodeJsonValue
  output?: CodemodeJsonValue
  partialOutput?: CodemodeJsonValue
  error?: string
  status: CodemodeCallStatus
  running: boolean
  startedAt: string
  startedClock: number
  durationMs?: number
}

interface MutableTrace {
  executionId: string
  sessionId: string
  script: string
  status: CodemodeExecutionStatus
  startedAt: string
  startedClock: number
  durationMs?: number
  calls: Map<string, MutableCall>
  budgets: CodemodeBudgets
  settings: CodemodeSettings
  output?: CodemodeJsonValue
  fullOutput?: string
  partialOutput?: CodemodeJsonValue
  error?: string
}

interface LiveSubscription {
  readonly callerKey: string
  readonly runtimeId: string
  readonly scope: RuntimeScope
  readonly publish: (payload: CodemodeEventPayload) => void
}

interface SessionEventHost {
  subscribeSessionEvents(listener: (event: SessionEventEnvelope) => void): () => void
}

interface RuntimeObserver {
  readonly runtimeId: string
  readonly runtime: RuntimeOperationRuntime
  readonly scope: RuntimeScope
  sessionId: string
  session: AgentSession
  unsubscribeNative: () => void
  unsubscribeSession: () => void
  readonly traces: Map<string, MutableTrace>
  readonly callsById: Map<string, string>
}

function callerKey(caller: AuthorizedIpcCaller): string {
  return `${caller.windowId}:${caller.webContentsId}:${caller.frameUrl}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toJsonValue(value: unknown, ancestors = new Set<object>()): CodemodeJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return null
  if (ancestors.has(value)) return '[circular]'
  ancestors.add(value)
  let result: CodemodeJsonValue
  if (Array.isArray(value)) {
    result = value.map((item) => toJsonValue(item, ancestors))
  } else {
    const record: Record<string, CodemodeJsonValue> = {}
    for (const [key, item] of Object.entries(value)) record[key] = toJsonValue(item, ancestors)
    result = record
  }
  ancestors.delete(value)
  return result
}

function settingsFor(session: AgentSession): CodemodeSettings {
  const settings = session.settingsManager.getSettings().codemode
  return {
    mode: settings?.mode === 'only' ? 'only' : 'on',
    inlineBudget: typeof settings?.inlineBudget === 'number'
      && Number.isFinite(settings.inlineBudget)
      && settings.inlineBudget >= 0
      ? settings.inlineBudget
      : DEFAULT_INLINE_BUDGET,
    // createCodemodeExtension() in bootstrap.ts uses the native default, which is true.
    modelsEnabled: true,
  }
}

function budgetsFor(script: string): CodemodeBudgets {
  let timeoutMs: number | null = DEFAULT_TIMEOUT_MS
  let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS
  const line = script.split(/\r?\n/, 1)[0]?.trimStart() ?? ''
  const prefix = '// @options:'
  if (line.startsWith(prefix)) {
    try {
      const options: unknown = JSON.parse(line.slice(prefix.length).trim())
      if (isRecord(options)) {
        if (Number.isSafeInteger(options.timeout_ms) && (options.timeout_ms as number) > 0) {
          timeoutMs = options.timeout_ms as number
        }
        if (Number.isSafeInteger(options.max_output_tokens) && (options.max_output_tokens as number) >= 0) {
          maxOutputTokens = options.max_output_tokens as number
        }
      }
    } catch {
      // Invalid native options remain visible in the script and the tool's error output.
    }
  }
  return {
    timeoutMs,
    maxOutputTokens,
    memoryLimitBytes: MEMORY_LIMIT_BYTES,
    maxOutputChars: MAX_OUTPUT_CHARS,
    maxOutputItems: MAX_OUTPUT_ITEMS,
    maxConcurrentModelCalls: MAX_CONCURRENT_MODEL_CALLS,
    maxToolCalls: DEFAULT_TOOL_CALL_BUDGET,
  }
}

function textInResult(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) return ''
  return value.content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
}

function errorInResult(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  for (const candidate of [value.error, value.message]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  const text = textInResult(value)
  const match = /(?:Script error:\s*|Script aborted:\s*|Script timed out:\s*)([\s\S]+)/.exec(text)
  return match?.[1] ?? (text.startsWith('Script failed') ? text : undefined)
}

function callStatus(value: unknown): CodemodeCallStatus {
  if (value === 'ok' || value === 'completed') return 'completed'
  if (value === 'cancelled' || value === 'aborted') return 'aborted'
  if (value === 'error' || value === 'failed') return 'failed'
  return 'running'
}

function executionStatus(result: unknown, isError: boolean): CodemodeExecutionStatus {
  const text = textInResult(result)
  if (/Script aborted:/i.test(text)) return 'aborted'
  return isError ? 'failed' : 'completed'
}

function traceSnapshot(trace: MutableTrace): CodemodeTrace {
  const calls: CodemodeCallTrace[] = [...trace.calls.values()].map((call) => ({
    id: call.id,
    ...(call.parentId ? { parentId: call.parentId } : {}),
    name: call.name,
    ...(call.namespace ? { namespace: call.namespace } : {}),
    args: call.args,
    ...(call.output === undefined ? {} : { output: call.output }),
    ...(call.partialOutput === undefined ? {} : { partialOutput: call.partialOutput }),
    ...(call.error === undefined ? {} : { error: call.error }),
    status: call.status,
    startedAt: call.startedAt,
    ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
  }))
  return {
    executionId: trace.executionId,
    sessionId: trace.sessionId,
    script: trace.script,
    status: trace.status,
    startedAt: trace.startedAt,
    ...(trace.durationMs === undefined ? {} : { durationMs: trace.durationMs }),
    calls,
    budgets: trace.budgets,
    settings: trace.settings,
    ...(trace.output === undefined ? {} : { output: trace.output }),
    ...(trace.fullOutput === undefined ? {} : { fullOutput: trace.fullOutput }),
    ...(trace.partialOutput === undefined ? {} : { partialOutput: trace.partialOutput }),
    ...(trace.error === undefined ? {} : { error: trace.error }),
  }
}

function spillPathFromResult(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.details) || typeof value.details.fullOutputPath !== 'string') return undefined
  const path = value.details.fullOutputPath
  if (dirname(path) !== tmpdir() || !/^pi-codemode-[a-f0-9]{16}\.txt$/.test(basename(path))) return undefined
  return path
}

function mutableCallFromDetail(
  detail: Record<string, unknown>,
  trace: MutableTrace,
): MutableCall | undefined {
  if (typeof detail.id !== 'string' || typeof detail.name !== 'string' || !detail.name.startsWith('models.')) return undefined
  const existing = trace.calls.get(detail.id)
  if (existing) {
    existing.status = callStatus(detail.status)
    existing.running = existing.status === 'running'
    if (typeof detail.durationMs === 'number' && Number.isFinite(detail.durationMs)) existing.durationMs = detail.durationMs
    if (typeof detail.error === 'string') existing.error = detail.error
    return existing
  }
  const call: MutableCall = {
    id: detail.id,
    parentId: trace.executionId,
    name: detail.name,
    args: toJsonValue(detail.args),
    status: callStatus(detail.status),
    running: callStatus(detail.status) === 'running',
    startedAt: new Date().toISOString(),
    startedClock: performance.now(),
  }
  if (typeof detail.durationMs === 'number' && Number.isFinite(detail.durationMs)) call.durationMs = detail.durationMs
  if (typeof detail.error === 'string') call.error = detail.error
  trace.calls.set(call.id, call)
  return call
}

/** Observes only Pi's registered native Code Mode tool; it never creates or runs a script. */
export class CodemodeService {
  private readonly operations: RuntimeOperations
  private readonly store: CodemodeTraceStore
  private observer: RuntimeObserver | undefined
  private readonly listeners = new Set<LiveSubscription>()

  constructor(operations: RuntimeOperations, store: CodemodeTraceStore) {
    this.operations = operations
    this.store = store
  }

  /** Call at runtime startup to begin observing before the first renderer request. */
  watch(scope: RuntimeScope): void {
    this.ensureObserver(scope)
  }

  async list(scope: RuntimeScope, sessionId: string) {
    const runtime = this.ensureObserver(scope)
    if (runtime.host.session.sessionId !== sessionId) throw new Error('The Code Mode session is not active.')
    return { sessionId, executions: await this.store.list(sessionId) }
  }

  async get(scope: RuntimeScope, executionId: string): Promise<CodemodeTrace | null> {
    const runtime = this.ensureObserver(scope)
    return this.store.get(runtime.host.session.sessionId, executionId)
  }

  catalog(scope: RuntimeScope, sessionId: string): CodemodeCatalogResponse {
    const runtime = this.ensureObserver(scope)
    const session = runtime.host.session
    if (session.sessionId !== sessionId) throw new Error('The Code Mode session is not active.')
    const settings = settingsFor(session)
    const callableNames = new Set(session.getCallableToolNames().filter((name) => name !== 'codemode'))
    const tools: CodemodeCatalogTool[] = session.getAllTools()
      .filter((tool) => callableNames.has(tool.name))
      .map((tool) => {
        const definition = session.getToolDefinition(tool.name)
        return {
          name: tool.name,
          description: tool.description,
          ...(tool.namespace ? { namespace: tool.namespace.name } : {}),
          exposure: tool.exposure,
          parameters: toJsonValue(tool.parameters),
          ...(definition?.outputSchema === undefined ? {} : { outputSchema: toJsonValue(definition.outputSchema) }),
        }
      })
    const namespaceMap = new Map<string, CodemodeCatalogNamespace & { tools: string[] }>()
    for (const tool of session.getAllTools()) {
      if (!callableNames.has(tool.name) || !tool.namespace) continue
      const current = namespaceMap.get(tool.namespace.name) ?? {
        name: tool.namespace.name,
        ...(tool.namespace.description ? { description: tool.namespace.description } : {}),
        ...(tool.namespace.instructions ? { instructions: tool.namespace.instructions } : {}),
        tools: [],
      }
      current.tools.push(tool.name)
      namespaceMap.set(tool.namespace.name, current)
    }
    return {
      sessionId,
      settings,
      namespaces: [...namespaceMap.values()].sort((left, right) => left.name.localeCompare(right.name)),
      tools,
    }
  }

  async abort(scope: RuntimeScope, executionId: string): Promise<{ aborted: boolean; scope: 'turn' | 'none' }> {
    const runtime = this.ensureObserver(scope)
    const sessionId = runtime.host.session.sessionId
    const active = this.observer?.traces.get(executionId)
    if (!active || active.sessionId !== sessionId || active.status !== 'running') {
      return { aborted: false, scope: 'none' }
    }
    // The SDK exposes AgentSession.abort(), which aborts the whole active turn. There is no
    // public per-tool cancellation handle; the native Code Mode tool receives the turn's signal.
    await runtime.host.session.abort()
    return { aborted: true, scope: 'turn' }
  }

  subscribe(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    publish: (payload: CodemodeEventPayload) => void,
  ): () => void {
    const runtime = this.ensureObserver(scope)
    const subscription: LiveSubscription = {
      callerKey: callerKey(caller),
      runtimeId: runtime.runtimeId,
      scope: { ownerId: scope.ownerId, generation: scope.generation },
      publish,
    }
    this.listeners.add(subscription)
    return () => this.listeners.delete(subscription)
  }

  dispose(): void {
    this.stopObserver()
    this.listeners.clear()
  }

  private ensureObserver(scope: RuntimeScope): RuntimeOperationRuntime {
    const runtime = this.operations.resolve(scope)
    if (!runtime) throw new Error('The runtime scope is no longer current.')
    if (this.observer?.runtimeId === runtime.runtimeId
      && this.observer.session === runtime.host.session) return runtime
    this.stopObserver()
    const session = runtime.host.session
    const host = runtime.host as RuntimeOperationRuntime['host'] & SessionEventHost
    const observer: RuntimeObserver = {
      runtimeId: runtime.runtimeId,
      runtime,
      scope: { ownerId: scope.ownerId, generation: scope.generation },
      sessionId: session.sessionId,
      session,
      unsubscribeNative: () => undefined,
      unsubscribeSession: () => undefined,
      traces: new Map(),
      callsById: new Map(),
    }
    this.observer = observer
    this.bindNativeSession(observer, session)
    observer.unsubscribeSession = host.subscribeSessionEvents((event) => {
      if (this.observer !== observer || event.runtime.ownerId !== scope.ownerId
        || event.runtime.generation !== scope.generation) return
      const current = this.operations.resolve(scope)
      if (!current || current.runtimeId !== observer.runtimeId) return
      const activeSession = current.host.session
      if (event.sessionId !== observer.sessionId && activeSession !== observer.session) {
        this.bindNativeSession(observer, activeSession)
      }
    })
    return runtime
  }

  private stopObserver(): void {
    const observer = this.observer
    if (!observer) return
    this.interruptActiveTraces(observer)
    this.observer = undefined
    observer.unsubscribeNative()
    observer.unsubscribeSession()
  }

  private bindNativeSession(observer: RuntimeObserver, session: AgentSession): void {
    this.interruptActiveTraces(observer)
    observer.unsubscribeNative()
    observer.session = session
    observer.sessionId = session.sessionId
    observer.traces.clear()
    observer.callsById.clear()
    observer.unsubscribeNative = session.subscribe((event) => {
      if (this.observer !== observer || observer.session !== session) return
      const runtime = this.operations.resolve(observer.scope)
      if (!runtime || runtime.runtimeId !== observer.runtimeId || runtime.host.session !== session) return
      try {
        this.onNativeEvent(observer, event)
      } catch {
        // Trace observers must not affect tool execution or extension dispatch.
      }
    })
  }

  private onNativeEvent(observer: RuntimeObserver, event: AgentSessionEvent): void {
    if (event.type === 'tool_execution_start') {
      if (event.toolName === 'codemode' && !event.parentToolCallId) {
        const args = isRecord(event.args) ? event.args : {}
        const script = typeof args.code === 'string' ? args.code : ''
        const startedClock = performance.now()
        const trace: MutableTrace = {
          executionId: event.toolCallId,
          sessionId: observer.sessionId,
          script,
          status: 'running',
          startedAt: new Date().toISOString(),
          startedClock,
          calls: new Map(),
          budgets: budgetsFor(script),
          settings: settingsFor(observer.session),
        }
        observer.traces.set(trace.executionId, trace)
        observer.callsById.set(event.toolCallId, trace.executionId)
        this.saveAndPublish(observer, trace)
      } else {
        const executionId = event.parentToolCallId
          ? observer.callsById.get(event.parentToolCallId)
          : undefined
        const trace = executionId ? observer.traces.get(executionId) : undefined
        if (trace) this.startCall(observer, trace, event.toolCallId, event.parentToolCallId, event.toolName, event.args)
      }
      return
    }

    if (event.type === 'tool_execution_update') {
      const executionId = observer.callsById.get(event.toolCallId)
      const trace = executionId ? observer.traces.get(executionId) : undefined
      if (!trace) return
      if (event.toolName === 'codemode' && event.toolCallId === trace.executionId) {
        trace.partialOutput = toJsonValue(event.partialResult)
        this.addModelCalls(trace, event.partialResult)
      } else {
        const call = trace.calls.get(event.toolCallId)
        if (call) call.partialOutput = toJsonValue(event.partialResult)
      }
      this.saveAndPublish(observer, trace)
      return
    }

    if (event.type === 'tool_execution_end') {
      const isRoot = event.toolName === 'codemode' && !event.parentToolCallId
      const executionId = isRoot ? event.toolCallId : observer.callsById.get(event.toolCallId)
      const trace = executionId ? observer.traces.get(executionId) : undefined
      if (!trace) return
      if (isRoot) {
        trace.output = toJsonValue(event.result)
        trace.status = executionStatus(event.result, event.isError)
        trace.durationMs = Math.max(0, performance.now() - trace.startedClock)
        const rootError = errorInResult(event.result)
        if (rootError === undefined) delete trace.error
        else trace.error = rootError
        for (const call of trace.calls.values()) {
          // Native Code Mode cancels calls that are still in flight when the script exits.
          if (call.running) call.status = 'aborted'
          call.running = false
          if (call.durationMs === undefined) {
            call.durationMs = Math.max(0, performance.now() - call.startedClock)
          }
        }
        void this.readNativeSpill(event.result).then((fullOutput) => {
          if (fullOutput !== undefined) trace.fullOutput = fullOutput
          this.saveAndPublish(observer, trace)
          observer.traces.delete(trace.executionId)
          for (const [callId, parentExecutionId] of observer.callsById) {
            if (parentExecutionId === trace.executionId) observer.callsById.delete(callId)
          }
        })
      } else {
        const call = trace.calls.get(event.toolCallId)
        if (call) {
          call.output = toJsonValue(event.result)
          call.status = event.isError ? 'failed' : 'completed'
          call.running = false
          call.durationMs = Math.max(0, performance.now() - call.startedClock)
          if (event.isError) {
            call.error = (errorInResult(event.result) ?? textInResult(event.result)) || `${call.name} failed`
          } else {
            delete call.error
          }
        }
        this.saveAndPublish(observer, trace)
      }
    }
  }

  private startCall(
    observer: RuntimeObserver,
    trace: MutableTrace,
    id: string,
    parentId: string | undefined,
    name: string,
    args: unknown,
  ): void {
    const startedClock = performance.now()
    const tool = observer.session.getAllTools().find((item) => item.name === name)
    const call: MutableCall = {
      id,
      ...(parentId ? { parentId } : {}),
      name,
      ...(tool?.namespace ? { namespace: tool.namespace.name } : {}),
      args: toJsonValue(args),
      status: 'running',
      running: true,
      startedAt: new Date().toISOString(),
      startedClock,
    }
    trace.calls.set(id, call)
    observer.callsById.set(id, trace.executionId)
    this.saveAndPublish(observer, trace)
  }

  private addModelCalls(trace: MutableTrace, partialResult: unknown): void {
    if (!isRecord(partialResult) || !isRecord(partialResult.details) || !Array.isArray(partialResult.details.calls)) return
    for (const detail of partialResult.details.calls) {
      if (!isRecord(detail)) continue
      mutableCallFromDetail(detail, trace)
    }
  }

  private async readNativeSpill(result: unknown): Promise<string | undefined> {
    const path = spillPathFromResult(result)
    if (!path) return undefined
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  }

  private saveAndPublish(observer: RuntimeObserver, trace: MutableTrace): void {
    const snapshot = traceSnapshot(trace)
    void this.store.upsert(trace.sessionId, snapshot).catch(() => undefined)
    const runtime = this.operations.resolve(observer.scope)
    if (!runtime || runtime.runtimeId !== observer.runtimeId) return
    const payload: CodemodeEventPayload = {
      runtime: observer.scope,
      sessionId: trace.sessionId,
      execution: snapshot,
    }
    for (const listener of [...this.listeners]) {
      if (listener.runtimeId !== observer.runtimeId
        || listener.scope.ownerId !== observer.scope.ownerId
        || listener.scope.generation !== observer.scope.generation) continue
      try {
        listener.publish(payload)
      } catch {
        // A renderer observer must never interrupt native session execution.
      }
    }
  }

  private interruptActiveTraces(observer: RuntimeObserver): void {
    for (const trace of observer.traces.values()) {
      if (trace.status !== 'running') continue
      trace.status = 'aborted'
      trace.durationMs = Math.max(0, performance.now() - trace.startedClock)
      trace.error = 'The active session changed before Code Mode completed.'
      for (const call of trace.calls.values()) {
        if (call.running) call.status = 'aborted'
        call.running = false
        call.durationMs = Math.max(0, performance.now() - call.startedClock)
      }
      this.saveAndPublish(observer, trace)
    }
    observer.traces.clear()
    observer.callsById.clear()
  }
}
