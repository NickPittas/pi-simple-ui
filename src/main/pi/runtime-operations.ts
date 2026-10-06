import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'

export interface RuntimeOperationRuntime {
  readonly scope: RuntimeScope
  readonly runtimeId: string
  readonly workspaceRoot: string
  readonly agentDir: string
  readonly trustDecision: 'trusted' | 'denied' | 'undecided'
  readonly host: { readonly session: AgentSession }
}

export interface RuntimeAdmissionGate {
  /** Commit the input immediately before calling the SDK. Returns false after stop or scope change. */
  commit(): boolean
}

export type RuntimeAdmissionResult<T> =
  | { readonly status: 'completed'; readonly value: T }
  | { readonly status: 'cancelled' }

export interface RuntimePreparedOperation<T> {
  readonly completion: Promise<T>
}

interface Admission<T> {
  readonly callerKey: string
  readonly runtime: RuntimeOperationRuntime
  readonly epoch: number
  cancelled: boolean
  committed: boolean
  completion?: Promise<T>
}

function sameScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return left.ownerId === right.ownerId && left.generation === right.generation
}

/**
 * Serializes the short admission phase against runtime lifecycle operations. The SDK turn
 * itself is not held under the lock: once the synchronous prompt/queue method is invoked,
 * a lifecycle operation may proceed and dispose the old session normally.
 */
export class RuntimeOperations {
  private tail: Promise<void> = Promise.resolve()
  private lifecycleEpoch = 0
  private readonly admissions = new Map<string, Set<Admission<unknown>>>()
  private readonly lateCleanups = new WeakSet<object>()

  constructor(private readonly getCurrentRuntime: () => RuntimeOperationRuntime | undefined) {}

  resolve(scope: RuntimeScope): RuntimeOperationRuntime | undefined {
    const runtime = this.getCurrentRuntime()
    if (!runtime || !sameScope(runtime.scope, scope)) return undefined
    return Object.freeze({
      ...runtime,
      scope: Object.freeze({ ownerId: runtime.scope.ownerId, generation: runtime.scope.generation }),
    })
  }

  /**
   * Run workspace switch/new-session/dispose work in the same FIFO as prompt admission.
   * Invalidation happens synchronously before waiting for the slot, so uncommitted inputs
   * cannot commit against the outgoing runtime.
   */
  runLifecycle<T>(operation: () => Promise<T> | T): Promise<T> {
    this.invalidateAdmissions()
    return this.withSlot(operation)
  }

  /** Invalidate uncommitted work when a lifecycle change originates outside this class. */
  invalidate(): void {
    this.invalidateAdmissions()
  }

  async admit<T>(
    scope: RuntimeScope,
    callerKey: string,
    prepareAndCommit: (
      runtime: RuntimeOperationRuntime,
      gate: RuntimeAdmissionGate,
    ) => Promise<RuntimePreparedOperation<T> | null> | RuntimePreparedOperation<T> | null,
  ): Promise<RuntimeAdmissionResult<T>> {
    const runtime = this.resolve(scope)
    if (!runtime) throw new Error('The runtime scope is no longer current.')
    const admission: Admission<T> = {
      callerKey,
      runtime,
      epoch: this.lifecycleEpoch,
      cancelled: false,
      committed: false,
    }
    const callerAdmissions = this.admissions.get(callerKey) ?? new Set<Admission<unknown>>()
    callerAdmissions.add(admission as Admission<unknown>)
    this.admissions.set(callerKey, callerAdmissions)

    let completion: Promise<T> | null
    try {
      const prepared = await this.withSlot(async () => {
        if (!this.isCurrent(admission)) return null
        const gate: RuntimeAdmissionGate = {
          commit: () => {
            if (!this.isCurrent(admission)) return false
            admission.committed = true
            return true
          },
        }
        const operation = await prepareAndCommit(runtime, gate)
        if (!admission.committed) return null
        // Keep the SDK promise inside an object so async promise assimilation does not
        // hold the admission slot until the provider turn settles.
        return operation
      })
      completion = prepared?.completion ?? null
    } catch (error) {
      this.removeAdmission(admission)
      throw error
    }
    if (!completion || !admission.committed) {
      this.removeAdmission(admission)
      return { status: 'cancelled' }
    }

    admission.completion = completion
    try {
      return { status: 'completed', value: await completion }
    } finally {
      this.removeAdmission(admission)
    }
  }

  /** Cancel a pending admission, or abort the session after that admission committed. */
  async stop(scope: RuntimeScope, callerKey: string): Promise<boolean> {
    const runtime = this.resolve(scope)
    if (!runtime) throw new Error('The runtime scope is no longer current.')
    const currentAdmissions = [...(this.admissions.get(callerKey) ?? [])]
    let stopped = false
    const committedSessions = new Set<AgentSession>()
    for (const admission of currentAdmissions) {
      if (!sameScope(admission.runtime.scope, scope)) continue
      if (!admission.committed) {
        admission.cancelled = true
        stopped = true
      } else {
        committedSessions.add(admission.runtime.host.session)
        stopped = true
      }
    }
    if (!stopped) return false
    for (const session of committedSessions) await session.abort()
    return stopped
  }

  /**
   * Run a factory in the lifecycle slot. If a switch/cancel invalidates it while pending,
   * its late result is disposed once and never returned to the caller.
   */
  async createGuarded<T extends { dispose(): Promise<void> | void }>(
    factory: () => Promise<T>,
    isStillCurrent: () => boolean = () => true,
  ): Promise<T | undefined> {
    const epoch = this.lifecycleEpoch
    return this.withSlot(async () => {
      if (this.lifecycleEpoch !== epoch) return undefined
      try {
        if (!isStillCurrent()) return undefined
      } catch {
        return undefined
      }
      const result = await factory()
      let current = false
      try {
        current = this.lifecycleEpoch === epoch && isStillCurrent()
      } catch {
        current = false
      }
      if (current) return result
      await this.disposeLateResult(result)
      return undefined
    })
  }

  private isCurrent<T>(admission: Admission<T>): boolean {
    if (admission.cancelled || admission.epoch !== this.lifecycleEpoch) return false
    const current = this.getCurrentRuntime()
    return !!current
      && current.host === admission.runtime.host
      && current.runtimeId === admission.runtime.runtimeId
      && sameScope(current.scope, admission.runtime.scope)
  }

  private invalidateAdmissions(): void {
    if (this.lifecycleEpoch >= Number.MAX_SAFE_INTEGER) throw new Error('Runtime lifecycle generation limit reached.')
    this.lifecycleEpoch += 1
    for (const callerAdmissions of this.admissions.values()) {
      for (const admission of callerAdmissions) {
        if (!admission.committed) admission.cancelled = true
      }
    }
  }

  private removeAdmission(admission: Admission<unknown>): void {
    const callerAdmissions = this.admissions.get(admission.callerKey)
    callerAdmissions?.delete(admission)
    if (callerAdmissions?.size === 0) this.admissions.delete(admission.callerKey)
  }

  private async disposeLateResult<T extends { dispose(): Promise<void> | void }>(result: T): Promise<void> {
    if (this.lateCleanups.has(result)) return
    this.lateCleanups.add(result)
    try {
      await result.dispose()
    } catch {
      // Late factory cleanup must not replace the cancellation result or leak host errors.
    }
  }

  private async withSlot<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
