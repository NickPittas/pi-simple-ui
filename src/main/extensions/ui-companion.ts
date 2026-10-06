import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { createHerdrReporterExtension } from '../herdr/reporter.ts'

export interface MainUICompanionOptions {
  /** Main-process policy opt-in; never source this from renderer-controlled state. */
  readonly enableHerdrReporting: boolean
  /** Optional isolated environment for tests; production uses the process environment. */
  readonly environment?: NodeJS.ProcessEnv
}

/** Factory for host-owned GUI extensions; the reporter activates only for Herdr RPC sessions. */
export function createMainUICompanionExtension(options: MainUICompanionOptions): ExtensionFactory {
  return createHerdrReporterExtension({
    enabled: options.enableHerdrReporting,
    environment: options.environment,
  })
}
