import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
import {
  LAUNCH_ENV,
  isLaunchScopeDescriptor,
  type LaunchExchangeResponse,
  type LaunchResourceConstraints,
  type LaunchScopeDescriptor,
} from '../../shared/launch.ts'
import { exchangeLaunchToken } from '../security/launch-channel.ts'
import { createHerdrReporterExtension } from './reporter.ts'

export interface InheritedHerdrLaunchPolicy {
  readonly descriptor: LaunchScopeDescriptor
  readonly projectTrusted: true
  readonly resourceConstraints: LaunchResourceConstraints
}

export interface HerdrChildBootstrapAdapters<T> {
  readonly environment?: NodeJS.ProcessEnv
  readonly argv: readonly string[]
  /** Installs a session-scoped decision into the native trust store before it reads settings. */
  readonly installTrustStoreDecision: (input: {
    readonly workspaceRoot: string
    readonly agentDir: string
    readonly targetAgentDir: string
    readonly targetCwd: string
    readonly trusted: true
  }) => void | Promise<void>
  /** Applies resource restrictions before the native CLI initializes settings/resources. */
  readonly installResourceConstraints: (constraints: LaunchResourceConstraints) => void | Promise<void>
  /** The app-local fork delegates to the native CLI only after both installers complete. */
  readonly delegateToNativeCli: (
    argv: readonly string[],
    options: {
      readonly policy: InheritedHerdrLaunchPolicy
      readonly extensionFactories: readonly InlineExtension[]
    },
  ) => T | Promise<T>
  readonly now?: () => number
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function canonicalDirectory(path: string): string {
  const canonical = realpathSync(path)
  if (!statSync(canonical).isDirectory()) throw new Error('Inherited launch path is not a directory.')
  return canonical
}

function nativeArgs(argv: readonly string[], constraints: LaunchResourceConstraints): readonly string[] {
  const trustFlags = new Set(['--approve', '-a', '--no-approve', '-na'])
  if (argv.some((argument) => trustFlags.has(argument))) {
    throw new Error('Child arguments cannot override inherited project trust.')
  }
  const result = [...argv]
  if (!constraints.projectExtensions) result.push('--no-extensions')
  if (!constraints.projectSkills) result.push('--no-skills')
  if (!constraints.projectPromptTemplates) result.push('--no-prompt-templates')
  if (!constraints.projectThemes) result.push('--no-themes')
  if (!constraints.projectContextFiles) result.push('--no-context-files')
  // The app-local native fork applies the MCP constraint in its resource policy
  // adapter; the stock CLI has no per-project-MCP disable flag.
  result.push('--approve')
  return result
}

/**
 * First step in the app-local Herdr child CLI entrypoint. It exchanges and
 * consumes the inherited capability, installs trust/resource policy, then
 * delegates to Pi's native CLI bootstrap. An app-local fork must call this
 * before setupCli/main creates settings, session, or resource services.
 */
export async function bootstrapHerdrChild<T>(
  adapters: HerdrChildBootstrapAdapters<T>,
): Promise<T> {
  const environment = adapters.environment ?? process.env
  const token = environment[LAUNCH_ENV.token]
  const endpoint = environment[LAUNCH_ENV.endpoint]
  if (!token || !endpoint) throw new Error('Missing inherited Herdr launch capability.')

  delete environment[LAUNCH_ENV.token]
  let response: LaunchExchangeResponse
  try {
    response = await exchangeLaunchToken(endpoint, token)
  } finally {
    // A child process must not retain or accidentally forward the bearer token.
    delete environment[LAUNCH_ENV.token]
    delete environment[LAUNCH_ENV.endpoint]
  }
  if (response.outcome !== 'granted' || !isLaunchScopeDescriptor(response.descriptor)) {
    throw new Error(`Herdr child launch authorization failed (${response.outcome === 'rejected' ? response.reason : 'invalid'}).`)
  }

  const descriptor = response.descriptor
  const now = (adapters.now ?? Date.now)()
  if (descriptor.trustDecision !== 'trusted'
    || now < descriptor.issuedAt
    || now >= descriptor.expiresAt) {
    throw new Error('Inherited Herdr launch trust is invalid or expired.')
  }
  const workspaceRoot = canonicalDirectory(descriptor.workspaceRoot)
  const agentDir = canonicalDirectory(descriptor.agentDir)
  const targetCwd = canonicalDirectory(descriptor.targetCwd)
  const targetAgentDir = canonicalDirectory(descriptor.targetAgentDir)
  const allowedCwdRoot = canonicalDirectory(descriptor.resourceConstraints.allowedCwdRoot)
  if (workspaceRoot !== descriptor.workspaceRoot
    || targetCwd !== descriptor.targetCwd
    || targetAgentDir !== descriptor.targetAgentDir
    || allowedCwdRoot !== workspaceRoot
    || !isWithin(workspaceRoot, targetCwd)
    || (targetAgentDir !== agentDir && !isWithin(workspaceRoot, targetAgentDir))
    || !isWithin(allowedCwdRoot, targetCwd)) {
    throw new Error('Inherited Herdr launch paths are outside the authenticated scope.')
  }
  if (!descriptor.herdr) throw new Error('Inherited Herdr reporting endpoint is missing.')

  const currentCwd = canonicalDirectory(process.cwd())
  if (currentCwd !== targetCwd) throw new Error('Child working directory does not match its launch capability.')
  environment.PI_CODING_AGENT_DIR = targetAgentDir
  environment.HERDR_ENV = '1'
  environment.HERDR_SOCKET_PATH = descriptor.herdr.socketPath
  environment.HERDR_PANE_ID = descriptor.herdr.paneId
  if (adapters.argv.includes(token)) throw new Error('Launch capability must not appear in native CLI arguments.')

  const policy: InheritedHerdrLaunchPolicy = Object.freeze({
    descriptor,
    projectTrusted: true,
    resourceConstraints: descriptor.resourceConstraints,
  })
  await adapters.installTrustStoreDecision({
    workspaceRoot,
    agentDir,
    targetAgentDir,
    targetCwd,
    trusted: true,
  })
  await adapters.installResourceConstraints(policy.resourceConstraints)

  const extensionFactories: readonly InlineExtension[] = Object.freeze([Object.freeze({
    name: 'herdr-reporter',
    factory: createHerdrReporterExtension({ enabled: true, environment }),
    hidden: true,
    replaceable: true,
  })])
  return await adapters.delegateToNativeCli(nativeArgs(adapters.argv, policy.resourceConstraints), {
    policy,
    extensionFactories,
  })
}
