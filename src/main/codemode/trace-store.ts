import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { AppPreferencesSnapshot, TraceRetentionDays } from '../../shared/app-preferences.ts'
import type {
  CodemodeExecutionSummary,
  CodemodeTrace,
} from '../../shared/codemode.ts'

const MAX_EXECUTIONS_PER_SESSION = 100
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/
const RETENTION_DAYS = new Set<TraceRetentionDays>([0, 1, 7, 30, 90])

export interface CodemodeTraceStoreOptions {
  /** App-managed directory, normally `join(app.getPath('userData'), 'codemode-traces')`. */
  readonly directory: string
  /** Read the current app preference snapshot; `privacy.traceRetentionDays` is authoritative. */
  readonly readPreferences: () => AppPreferencesSnapshot
  readonly maxExecutionsPerSession?: number
}

interface StoredTraceFile {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly executions: readonly CodemodeTrace[]
}

function traceFileName(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new TypeError('The Code Mode session ID is invalid.')
  return `${sessionId}.json`
}

function cloneJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return null
  if (ancestors.has(value)) return '[circular]'
  ancestors.add(value)
  let result: unknown
  if (Array.isArray(value)) {
    result = value.map((item) => cloneJson(item, ancestors))
  } else {
    const record: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) record[key] = cloneJson(item, ancestors)
    result = record
  }
  ancestors.delete(value)
  return result
}

function validJsonValue(value: unknown): boolean {
  const pending: unknown[] = [value]
  const visited = new WeakSet<object>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false
      continue
    }
    if (typeof current !== 'object') return false
    if (visited.has(current)) return false
    visited.add(current)
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item)
    } else {
      if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) return false
      for (const item of Object.values(current)) pending.push(item)
    }
  }
  return true
}

function validTrace(value: unknown, sessionId: string): value is CodemodeTrace {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const trace = value as Partial<CodemodeTrace>
  return trace.sessionId === sessionId
    && typeof trace.executionId === 'string'
    && typeof trace.script === 'string'
    && ['running', 'completed', 'failed', 'aborted'].includes(String(trace.status))
    && typeof trace.startedAt === 'string'
    && Array.isArray(trace.calls)
    && typeof trace.budgets === 'object'
    && trace.budgets !== null
    && typeof trace.settings === 'object'
    && trace.settings !== null
    && validJsonValue(value)
}

function summary(trace: CodemodeTrace): CodemodeExecutionSummary {
  return {
    executionId: trace.executionId,
    status: trace.status,
    startedAt: trace.startedAt,
    ...(trace.durationMs === undefined ? {} : { durationMs: trace.durationMs }),
    callCount: trace.calls.length,
    ...(trace.error === undefined ? {} : { error: trace.error }),
  }
}

/**
 * Session traces live in an app-managed side store, not the native JSONL session file. The
 * session-id filename keeps each restored session independently recoverable without changing
 * Pi's session format. Stored execution payloads are never length-truncated.
 */
export class CodemodeTraceStore {
  private readonly directory: string
  private readonly readPreferences: () => AppPreferencesSnapshot
  private readonly maxExecutionsPerSession: number
  private readonly sessions = new Map<string, CodemodeTrace[]>()
  private readonly loads = new Map<string, Promise<CodemodeTrace[]>>()
  private readonly writes = new Map<string, Promise<void>>()

  constructor(options: CodemodeTraceStoreOptions) {
    if (!isAbsolute(options.directory) || options.directory.includes('\0')) {
      throw new TypeError('The Code Mode trace directory must be an absolute path.')
    }
    this.directory = options.directory
    this.readPreferences = options.readPreferences
    const requested = options.maxExecutionsPerSession ?? MAX_EXECUTIONS_PER_SESSION
    this.maxExecutionsPerSession = Number.isSafeInteger(requested) && requested > 0
      ? Math.min(requested, MAX_EXECUTIONS_PER_SESSION)
      : MAX_EXECUTIONS_PER_SESSION
  }

  async list(sessionId: string): Promise<readonly CodemodeExecutionSummary[]> {
    const traces = await this.loadSession(sessionId)
    return traces
      .slice()
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .map(summary)
  }

  async get(sessionId: string, executionId: string): Promise<CodemodeTrace | null> {
    const traces = await this.loadSession(sessionId)
    const trace = traces.find((item) => item.executionId === executionId)
    return trace ? cloneJson(trace) as CodemodeTrace : null
  }

  async upsert(sessionId: string, trace: CodemodeTrace): Promise<void> {
    traceFileName(sessionId)
    if (!validTrace(trace, sessionId)) throw new TypeError('The Code Mode trace is invalid.')
    const traces = await this.loadSession(sessionId)
    const snapshot = cloneJson(trace) as CodemodeTrace
    const existing = traces.findIndex((item) => item.executionId === snapshot.executionId)
    if (existing >= 0) traces.splice(existing, 1)
    traces.push(snapshot)
    this.prune(sessionId, traces)
    await this.persist(sessionId, traces)
  }

  async clearSession(sessionId: string): Promise<void> {
    const filePath = this.filePath(sessionId)
    this.sessions.delete(sessionId)
    await this.enqueueWrite(sessionId, async () => {
      await rm(filePath, { force: true })
    })
  }

  private async loadSession(sessionId: string): Promise<CodemodeTrace[]> {
    traceFileName(sessionId)
    const cached = this.sessions.get(sessionId)
    if (cached) {
      this.prune(sessionId, cached)
      return cached
    }
    const pending = this.loads.get(sessionId)
    if (pending) return pending
    const loading = this.readSessionFile(sessionId)
    this.loads.set(sessionId, loading)
    try {
      const traces = await loading
      this.sessions.set(sessionId, traces)
      this.prune(sessionId, traces)
      await this.persist(sessionId, traces)
      return traces
    } finally {
      this.loads.delete(sessionId)
    }
  }

  private async readSessionFile(sessionId: string): Promise<CodemodeTrace[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath(sessionId), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
      const stored = parsed as Partial<StoredTraceFile>
      if (stored.schemaVersion !== 1 || stored.sessionId !== sessionId || !Array.isArray(stored.executions)) return []
      return stored.executions
        .filter((trace): trace is CodemodeTrace => validTrace(trace, sessionId))
        .map((trace) => trace.status !== 'running' ? trace : {
          ...trace,
          status: 'aborted' as const,
          error: 'The application stopped before Code Mode completed.',
          calls: trace.calls.map((call) => call.status === 'running' ? { ...call, status: 'aborted' as const } : call),
        })
    } catch {
      return []
    }
  }

  private retentionDays(): TraceRetentionDays {
    try {
      const value = this.readPreferences().preferences.privacy.traceRetentionDays
      return RETENTION_DAYS.has(value) ? value : 7
    } catch {
      return 7
    }
  }

  private prune(sessionId: string, traces: CodemodeTrace[]): void {
    const days = this.retentionDays()
    const cutoff = days === 0 ? Number.POSITIVE_INFINITY : Date.now() - days * 24 * 60 * 60 * 1000
    const retained = traces
      .filter((trace) => trace.status === 'running' || Date.parse(trace.startedAt) >= cutoff)
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
      .slice(-this.maxExecutionsPerSession)
    traces.splice(0, traces.length, ...retained)
    this.sessions.set(sessionId, traces)
  }

  private async persist(sessionId: string, traces: readonly CodemodeTrace[]): Promise<void> {
    const filePath = this.filePath(sessionId)
    const retentionDays = this.retentionDays()
    await this.enqueueWrite(sessionId, async () => {
      if (retentionDays === 0 || traces.length === 0) {
        await rm(filePath, { force: true })
        return
      }
      await mkdir(this.directory, { recursive: true })
      const document: StoredTraceFile = {
        schemaVersion: 1,
        sessionId,
        executions: cloneJson(traces) as CodemodeTrace[],
      }
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporaryPath, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 })
        await rename(temporaryPath, filePath)
      } catch {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw new Error('The Code Mode trace could not be persisted.')
      }
    })
  }

  private filePath(sessionId: string): string {
    return join(this.directory, traceFileName(sessionId))
  }

  private async enqueueWrite(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.writes.set(sessionId, current)
    try {
      await current
    } finally {
      if (this.writes.get(sessionId) === current) this.writes.delete(sessionId)
    }
  }
}
