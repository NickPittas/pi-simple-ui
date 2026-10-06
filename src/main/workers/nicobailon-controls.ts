import { existsSync } from 'node:fs'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type {
  NicobailonWorkerDetails,
  WorkerAbortRequest,
  WorkerAbortResponse,
  WorkerControlAvailability,
  WorkerControlRejectionReason,
  WorkerControlResponse,
  WorkerResumeRequest,
  WorkerResumeResponse,
  WorkerSteerRequest,
  WorkerSteerResponse,
} from '../../shared/workers.ts'
import type { SubagentWorkerControls } from '@app/pi-subagents-nicobailon/worker-observer'
import { requestAsyncSteer, requestAsyncStop, steerInboxClosedPath, stopInboxClosedPath } from '@app/pi-subagents-nicobailon/control-channel'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'
import type { RuntimeLaunchPolicy } from '../security/launch-policy.ts'
import type { RuntimeOperations } from '../pi/runtime-operations.ts'
import type { WorkerControlHandler } from './worker-controls.ts'
import type { WorkerRegistry } from './worker-registry.ts'

interface AsyncControlTarget {
  readonly asyncDir: string
  readonly stepIndex: number
}

type ControlTarget =
  | { readonly kind: 'foreground'; readonly controls: SubagentWorkerControls }
  | { readonly kind: 'async'; readonly controls: AsyncControlTarget }

interface NicobailonWorkerControlsOptions {
  readonly operations: RuntimeOperations
  readonly registry: WorkerRegistry
  readonly getLaunchPolicy: (runtimeId: string) => RuntimeLaunchPolicy | undefined
}

function rejected(reason: WorkerControlRejectionReason, error?: string): WorkerControlResponse {
  return { accepted: false, reason, ...(error ? { error } : {}) }
}

function boundedError(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error)
    return message.split(/[\r\n]/, 1)[0]?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1_000)
      || 'The nicobailon worker operation failed.'
  } catch {
    return 'The nicobailon worker operation failed.'
  }
}

function callerKey(caller: AuthorizedIpcCaller, scope: RuntimeScope, workerId: string): string {
  return JSON.stringify([scope.ownerId, scope.generation, caller.windowId, caller.webContentsId, caller.frameUrl, workerId])
}

function unavailable(reason: string): WorkerControlAvailability {
  return { available: false, reason }
}

/** Routes controls to the native Pi session or nicobailon's existing async inbox. */
export class NicobailonWorkerControls implements WorkerControlHandler {
  private readonly operations: RuntimeOperations
  private readonly registry: WorkerRegistry
  private readonly getLaunchPolicy: NicobailonWorkerControlsOptions['getLaunchPolicy']
  private readonly targets = new Map<string, ControlTarget>()

  constructor(options: NicobailonWorkerControlsOptions) {
    this.operations = options.operations
    this.registry = options.registry
    this.getLaunchPolicy = options.getLaunchPolicy
  }

  registerForeground(workerId: string, controls: SubagentWorkerControls): void {
    if (this.registry.isCurrentScope(this.registry.scope)) this.targets.set(workerId, { kind: 'foreground', controls })
  }

  registerAsync(workerId: string, controls: AsyncControlTarget): void {
    if (this.registry.isCurrentScope(this.registry.scope)) this.targets.set(workerId, { kind: 'async', controls })
  }

  unregister(workerId: string): void {
    this.targets.delete(workerId)
  }

  availability(workerId: string): NicobailonWorkerDetails['controls'] {
    const target = this.targets.get(workerId)
    const summary = this.registry.snapshot(workerId)?.summary
    const terminal = summary?.status === 'completed' || summary?.status === 'failed' || summary?.status === 'aborted'
    const steer = !target || terminal
      ? unavailable(terminal ? 'The native child session has settled.' : 'The native control endpoint is unavailable.')
      : target.kind === 'async' && existsSync(steerInboxClosedPath(target.controls.asyncDir))
        ? unavailable('The native async run has closed its steering inbox.')
        : { available: true }
    const abort = !target || terminal
      ? unavailable(terminal ? 'The native child session has settled.' : 'The native control endpoint is unavailable.')
      : target.kind === 'async' && existsSync(stopInboxClosedPath(target.controls.asyncDir))
        ? unavailable('The native async run has closed its stop inbox.')
        : { available: true }
    return {
      steer,
      abort,
      resume: unavailable('The public nicobailon runtime API does not expose child resume for this worker.'),
    }
  }

  steer(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: WorkerSteerRequest): Promise<WorkerSteerResponse> {
    const availability = this.availability(request.workerId).steer
    if (!availability.available) return Promise.resolve(rejected('control-unavailable', availability.reason))
    return this.run(caller, scope, request.workerId, async (target) => {
      if (target.kind === 'foreground') {
        await target.controls.steer(request.message)
        return { accepted: true }
      } else {
        requestAsyncSteer(target.controls.asyncDir, {
          message: request.message,
          targetIndex: target.controls.stepIndex,
          source: 'pi-simple-ui',
        })
        return { accepted: true, delivery: 'queued' }
      }
    })
  }

  abort(caller: AuthorizedIpcCaller, scope: RuntimeScope, request: WorkerAbortRequest): Promise<WorkerAbortResponse> {
    const availability = this.availability(request.workerId).abort
    if (!availability.available) return Promise.resolve(rejected('control-unavailable', availability.reason))
    return this.run(caller, scope, request.workerId, async (target) => {
      if (target.kind === 'foreground') await target.controls.abort()
      else {
        requestAsyncStop(target.controls.asyncDir, { targetIndex: target.controls.stepIndex, source: 'pi-simple-ui' })
        return { accepted: true, delivery: 'queued' }
      }
      return { accepted: true }
    })
  }

  resume(_caller: AuthorizedIpcCaller, _scope: RuntimeScope, _request: WorkerResumeRequest): Promise<WorkerResumeResponse> {
    return Promise.resolve(rejected('control-unavailable', 'The public nicobailon runtime API does not expose child resume for this worker.'))
  }

  dispose(): void {
    this.targets.clear()
  }

  private async run(
    caller: AuthorizedIpcCaller,
    scope: RuntimeScope,
    workerId: string,
    operation: (target: ControlTarget) => Promise<WorkerControlResponse>,
  ): Promise<WorkerControlResponse> {
    try {
      const result = await this.operations.admit(scope, callerKey(caller, scope, workerId), async (runtime, gate) => {
        const finish = (response: WorkerControlResponse) => gate.commit() ? { completion: Promise.resolve(response) } : null
        if (!this.registry.isCurrentScope(runtime.scope)
          || runtime.scope.ownerId !== scope.ownerId
          || runtime.scope.generation !== scope.generation) return finish(rejected('operation-cancelled'))
        const summary = this.registry.snapshot(workerId)?.summary
        if (!summary || summary.source !== 'live' || summary.provider !== 'nicobailon') {
          return finish(rejected('worker-not-observed'))
        }
        const target = this.targets.get(workerId)
        if (!target) return finish(rejected('control-unavailable', 'The native control endpoint is no longer active.'))
        const policy = this.getLaunchPolicy(runtime.runtimeId)
        if (!policy || policy.scope.runtimeId !== runtime.runtimeId) return finish(rejected('runtime-policy-unavailable'))
        if (policy.isRevoked()) return finish(rejected('runtime-revoked'))
        if (runtime.trustDecision !== 'trusted' || policy.scope.trustDecision !== 'trusted') {
          return finish(rejected('runtime-not-trusted'))
        }
        if (!gate.commit()) return null
        return { completion: operation(target) }
      })
      return result.status === 'completed' ? result.value : rejected('operation-cancelled')
    } catch (error) {
      return rejected('operation-failed', boundedError(error))
    }
  }
}
