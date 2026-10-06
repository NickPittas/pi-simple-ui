import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export type RuntimeTrustDecision = 'trusted' | 'denied' | 'undecided'

export interface RuntimeLaunchScope {
  readonly workspaceRoot: string
  readonly agentDir: string
  readonly trustDecision: RuntimeTrustDecision
  readonly runtimeId: string
}

export interface RuntimeLaunchPolicy {
  readonly scope: RuntimeLaunchScope
  readonly descriptor: RuntimeLaunchScope
  isRevoked(): boolean
  assertLaunchAllowed(targetCwd: string): string
}

function isWithinRoot(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** Create an immutable trust snapshot with a live revocation check for launch-time use. */
export function createRuntimeLaunchPolicy(
  input: RuntimeLaunchScope,
  wasRevoked: () => boolean,
): RuntimeLaunchPolicy {
  if (!isAbsolute(input.workspaceRoot) || !isAbsolute(input.agentDir)
    || input.workspaceRoot.includes('\0') || input.agentDir.includes('\0')
    || !['trusted', 'denied', 'undecided'].includes(input.trustDecision)
    || input.runtimeId.length === 0 || input.runtimeId.length > 160
    || !/^[a-zA-Z0-9._:-]+$/.test(input.runtimeId)) {
    throw new TypeError('The runtime launch scope is invalid.')
  }
  const scope: RuntimeLaunchScope = Object.freeze({
    workspaceRoot: resolve(input.workspaceRoot),
    agentDir: resolve(input.agentDir),
    trustDecision: input.trustDecision,
    runtimeId: input.runtimeId,
  })
  const descriptor: RuntimeLaunchScope = Object.freeze({ ...scope })

  const isRevoked = (): boolean => {
    try {
      return wasRevoked() === true
    } catch {
      return true
    }
  }

  return Object.freeze({
    scope,
    descriptor,
    isRevoked,
    assertLaunchAllowed(targetCwd: string): string {
      if (scope.trustDecision !== 'trusted' || isRevoked()) {
        throw new Error('Runtime trust does not allow a child launch.')
      }
      if (!isAbsolute(targetCwd) || targetCwd.includes('\0')) {
        throw new Error('The child launch directory is invalid.')
      }
      try {
        const canonicalRoot = realpathSync(scope.workspaceRoot)
        const canonicalTarget = realpathSync(targetCwd)
        if (!statSync(canonicalTarget).isDirectory() || !isWithinRoot(canonicalRoot, canonicalTarget)) {
          throw new Error('The child launch directory is outside the trusted workspace.')
        }
        if (isRevoked()) throw new Error('Runtime trust was revoked before child launch.')
        return canonicalTarget
      } catch {
        throw new Error('The child launch directory is unavailable or outside the trusted workspace.')
      }
    },
  })
}
