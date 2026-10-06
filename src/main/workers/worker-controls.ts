import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import {
  type WorkerAbortRequest,
  type WorkerAbortResponse,
  type WorkerControlRejectionReason,
  type WorkerControlResponse,
  type WorkerResumeRequest,
  type WorkerResumeResponse,
  type WorkerSteerRequest,
  type WorkerSteerResponse,
} from '../../shared/workers.ts'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'
import type { RuntimeLaunchPolicy } from '../security/launch-policy.ts'
import type { RuntimeOperations } from '../pi/runtime-operations.ts'
import type { WorkerRegistry } from './worker-registry.ts'

interface NativeWorkerRecord {
  readonly session?: unknown
  readonly status?: string
}

export interface WorkerAgentManager {
  getRecord(id: string): NativeWorkerRecord | undefined
  steer(id: string, message: string): boolean
  abort(id: string): boolean
  resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: { readonly isBackground?: boolean },
  ): Promise<NativeWorkerRecord | undefined>
}

export interface WorkerControlHandler {
  steer(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: WorkerSteerRequest): Promise<WorkerSteerResponse>
  abort(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: WorkerAbortRequest): Promise<WorkerAbortResponse>
  resume(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: WorkerResumeRequest): Promise<WorkerResumeResponse>
}

interface WorkerControlsOptions {
  readonly operations: RuntimeOperations
  readonly registry: WorkerRegistry
  readonly getManager: (runtimeId: string) => WorkerAgentManager | undefined
  readonly getLaunchPolicy: (runtimeId: string) => RuntimeLaunchPolicy | undefined
}

type WorkerControlOperation = (manager: WorkerAgentManager, record: NativeWorkerRecord) => WorkerControlResponse | Promise<WorkerControlResponse>

function rejected(reason: WorkerControlRejectionReason, error?: string): WorkerControlResponse {
  return { accepted: false, reason, ...(error ? { error } : {}) }
}

function boundedError(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error)
    const firstLine = message.split(/[\r\n]/, 1)[0] ?? ''
    const safe = firstLine.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1_000)
    return safe || 'The worker operation failed.'
  } catch {
    return 'The worker operation failed.'
  }
}

function callerKey(caller: AuthorizedIpcCaller, scope: RuntimeScope, workerId: string): string {
  return JSON.stringify([
    scope.ownerId,
    scope.generation,
    caller.windowId,
    caller.webContentsId,
    caller.frameUrl,
    workerId,
  ])
}

/**
 * Execute native AgentManager controls through RuntimeOperations admission.
 * The manager itself remains owned and wired by the active Pi session host.
 */
export class WorkerControls implements WorkerControlHandler {
  private readonly operations: RuntimeOperations
  private readonly registry: WorkerRegistry
  private readonly getManager: WorkerControlsOptions['getManager']
  private readonly getLaunchPolicy: WorkerControlsOptions['getLaunchPolicy']

  constructor(options: WorkerControlsOptions) {
    this.operations = options.operations
    this.registry = options.registry
    this.getManager = options.getManager
    this.getLaunchPolicy = options.getLaunchPolicy
  }

  steer(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: WorkerSteerRequest): Promise<WorkerSteerResponse> {
    return this.run(caller, scope, request.workerId, (manager) => manager.steer(request.workerId, request.message)
      ? { accepted: true }
      : rejected('worker-not-running'))
  }

  abort(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: WorkerAbortRequest): Promise<WorkerAbortResponse> {
    return this.run(caller, scope, request.workerId, (manager) => manager.abort(request.workerId)
      ? { accepted: true }
      : rejected('worker-not-running'))
  }

  resume(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: WorkerResumeRequest): Promise<WorkerResumeResponse> {
    return this.run(caller, scope, request.workerId, async (manager, record) => {
      if (!record.session) return rejected('worker-not-resumable')
      if (record.status === 'running' || record.status === 'queued') return rejected('worker-not-resumable')
      const resumed = await manager.resume(request.workerId, request.message, undefined, {
        isBackground: request.isBackground ?? true,
      })
      return resumed ? { accepted: true } : rejected('worker-not-resumable')
    })
  }

  private async run(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    workerId: string,
    operation: WorkerControlOperation,
  ): Promise<WorkerControlResponse> {
    try {
      const result = await this.operations.admit(
        scope,
        callerKey(caller, scope, workerId),
        async (runtime, gate) => {
          const finish = (response: WorkerControlResponse) => {
            if (!gate.commit()) return null
            return { completion: Promise.resolve(response) }
          }

          if (!this.registry.isCurrentScope(runtime.scope)
            || runtime.scope.ownerId !== scope.ownerId
            || runtime.scope.generation !== scope.generation) {
            return finish(rejected('operation-cancelled'))
          }

          const summary = this.registry.snapshot(workerId)?.summary
          if (!summary || summary.source !== 'live') return finish(rejected('worker-not-observed'))

          const manager = this.getManager(runtime.runtimeId)
          if (!manager) return finish(rejected('manager-unavailable'))
          const record = manager.getRecord(workerId)
          if (!record) return finish(rejected('worker-not-observed'))

          const policy = this.getLaunchPolicy(runtime.runtimeId)
          if (!policy || policy.scope.runtimeId !== runtime.runtimeId) {
            return finish(rejected('runtime-policy-unavailable'))
          }
          if (policy.isRevoked()) return finish(rejected('runtime-revoked'))
          if (runtime.trustDecision !== 'trusted' || policy.scope.trustDecision !== 'trusted') {
            return finish(rejected('runtime-not-trusted'))
          }

          // Check revocation again at the admission boundary immediately before
          // the native manager method is invoked.
          if (policy.isRevoked()) return finish(rejected('runtime-revoked'))
          if (!gate.commit()) return null
          const completion = operation(manager, record)
          return { completion: Promise.resolve(completion) }
        },
      )
      return result.status === 'completed' ? result.value : rejected('operation-cancelled')
    } catch (error) {
      return rejected('operation-failed', boundedError(error))
    }
  }
}
