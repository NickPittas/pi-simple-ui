import {
  registerSubagentCapabilityCeiling,
  type SubagentCapabilityCeiling,
} from '@app/pi-subagents-nicobailon/capability-ceiling'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { RuntimeLaunchPolicy } from '../security/launch-policy.ts'
import type { RuntimeOperations } from '../pi/runtime-operations.ts'
import type { WorkerHistoryServices } from './tintinweb-observer.ts'
import type { WorkerRegistry } from './worker-registry.ts'
import { NicobailonWorkerControls } from './nicobailon-controls.ts'
import { NicobailonWorkerObserver, type NicobailonEventBus } from './nicobailon-observer.ts'

export interface NicobailonWorkerProviderOptions {
  readonly events: NicobailonEventBus
  readonly registry: WorkerRegistry
  readonly scope: RuntimeScope
  readonly rootSessionId: string
  readonly capabilityCeiling: SubagentCapabilityCeiling
  readonly operations: RuntimeOperations
  readonly getLaunchPolicy: (runtimeId: string) => RuntimeLaunchPolicy | undefined
  readonly history?: WorkerHistoryServices
  readonly onDiagnostic?: (message: string) => void
}

export interface NicobailonWorkerProvider {
  readonly observer: NicobailonWorkerObserver
  readonly controls: NicobailonWorkerControls
  dispose(): void
}

/**
 * Bind nicobailon's native observer and controls to one runtime generation.
 * The capability ceiling is registered first through the vendor's public seam,
 * so its existing launch preflight sees the inherited policy before child setup.
 */
export function createNicobailonWorkerProvider(options: NicobailonWorkerProviderOptions): NicobailonWorkerProvider {
  const ceiling = registerSubagentCapabilityCeiling({
    sessionId: options.rootSessionId,
    source: 'pi-simple-ui/runtime-launch-policy',
    ceiling: options.capabilityCeiling,
  })
  const controls = new NicobailonWorkerControls({
    operations: options.operations,
    registry: options.registry,
    getLaunchPolicy: options.getLaunchPolicy,
  })
  try {
    const observer = new NicobailonWorkerObserver({
      events: options.events,
      registry: options.registry,
      scope: options.scope,
      controls,
      ...(options.history ? { history: options.history } : {}),
      rootSessionId: options.rootSessionId,
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    })
    let disposed = false
    return {
      observer,
      controls,
      dispose() {
        if (disposed) return
        disposed = true
        observer.dispose()
        ceiling.dispose()
      },
    }
  } catch (error) {
    controls.dispose()
    ceiling.dispose()
    throw error
  }
}
