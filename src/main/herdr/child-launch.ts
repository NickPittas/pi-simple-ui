import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CapabilityDefinition, CapabilityContext } from '../ipc/register.ts'
import { resolveHerdrEndpoint } from './transport.ts'
import type { HerdrAgentReportRequest } from './transport.ts'
import type { RuntimeLaunchPolicy } from '../security/launch-policy.ts'
import type { LaunchChannel } from '../security/launch-channel.ts'
import {
  HERDR_LAUNCH_CAPABILITY,
  type HerdrLaunchPrepareRequest,
  type HerdrLaunchPreparedResponse,
  type LaunchResourceConstraints,
  type LaunchScopeDescriptor,
  isHerdrLaunchPrepareRequest,
  isHerdrLaunchPreparedResponse,
} from '../../shared/launch.ts'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { WorkerRegistry } from '../workers/worker-registry.ts'
import type { WorkerSummary } from '../../shared/workers.ts'
import type { HerdrChildSessionObserver } from '../workers/child-session-observer.ts'

const LAUNCH_TTL_MS = 60_000
const SESSION_HEADER_MAX_BYTES = 64 * 1024
const FORBIDDEN_ARGUMENTS = new Set([
  '--approve', '-a', '--no-approve', '-na', '--trust', '--no-trust',
  '--session-dir', '--resume', '-r', '--agent-dir', '--cwd', '--no-extensions', '-ne',
  '--no-skills', '-ns', '--no-prompt-templates', '-np', '--no-themes', '--no-context-files', '-nc',
  '--help', '-h', '--version', '-v', '--export', '--config',
])

export interface HerdrChildLaunchOptions {
  readonly channel: LaunchChannel
  /** Must return only a policy for this exact, currently active IPC runtime scope. */
  readonly getLaunchPolicy: (scope: RuntimeScope) => RuntimeLaunchPolicy | undefined
  readonly getWorkerRegistry?: () => WorkerRegistry | undefined
  readonly childSessionObserver?: HerdrChildSessionObserver
  readonly getParentWorkerId?: (context: CapabilityContext) => string | undefined
  readonly isPersistentLaunch?: (request: HerdrLaunchPrepareRequest) => boolean
  readonly getLaunchName?: (request: HerdrLaunchPrepareRequest) => string | undefined
  readonly environment?: NodeJS.ProcessEnv
  readonly now?: () => number
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function canonicalDirectory(path: string): string {
  const canonical = realpathSync(path)
  if (!statSync(canonical).isDirectory()) throw new Error('Launch target is not a directory.')
  return canonical
}

function canonicalSessionFile(
  path: string,
  allowedRoots: readonly string[],
  requireExisting: boolean,
): { path: string; cwd?: string } {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Child session path must be absolute.')
  const resolved = resolve(path)
  let canonical: string
  if (existsSync(resolved)) {
    if (!requireExisting) throw new Error('New child session target already exists.')
    canonical = realpathSync(resolved)
    if (!statSync(canonical).isFile()) throw new Error('Child session target is not a file.')
  } else {
    if (requireExisting) throw new Error('Child session target is unavailable.')
    const parent = realpathSync(dirname(resolved))
    if (!statSync(parent).isDirectory()) throw new Error('Child session directory is unavailable.')
    canonical = join(parent, basename(resolved))
  }
  if (!allowedRoots.some((root) => isWithin(root, canonical))) {
    throw new Error('Child session is outside the current runtime scope.')
  }
  if (!requireExisting) return { path: canonical }

  const fd = openSync(canonical, 'r')
  let headerLine = ''
  try {
    const buffer = Buffer.alloc(SESSION_HEADER_MAX_BYTES)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
    if (newline < 0) throw new Error('Child session header is missing or too large.')
    headerLine = buffer.subarray(0, newline).toString('utf8')
  } finally {
    closeSync(fd)
  }
  let header: unknown
  try {
    header = JSON.parse(headerLine)
  } catch {
    throw new Error('Child session header is invalid.')
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new Error('Child session header is invalid.')
  }
  const record = header as Record<string, unknown>
  if (record.type !== 'session' || typeof record.cwd !== 'string' || !isAbsolute(record.cwd)) {
    throw new Error('Child session header has no valid working directory.')
  }
  return { path: canonical, cwd: canonicalDirectory(record.cwd) }
}

function canonicalSessionArgument(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Child session argument must be absolute.')
  const resolved = resolve(path)
  if (existsSync(resolved)) return realpathSync(resolved)
  return join(realpathSync(dirname(resolved)), basename(resolved))
}

function controlledSessionArgs(args: readonly string[], sessionPath: string): readonly string[] {
  const rest: string[] = []
  let suppliedSession = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (FORBIDDEN_ARGUMENTS.has(argument)
      || argument.startsWith('--session-dir=')
      || argument.startsWith('--resume=')) {
      throw new Error(`Child launch argument is not permitted: ${argument}`)
    }
    if (argument === '--session') {
      const value = args[index + 1]
      if (!value || canonicalSessionArgument(value) !== sessionPath) throw new Error('Child launch session target does not match authorization.')
      suppliedSession = true
      index += 1
      continue
    }
    if (argument.startsWith('--session=')) {
      if (canonicalSessionArgument(argument.slice('--session='.length)) !== sessionPath) {
        throw new Error('Child launch session target does not match authorization.')
      }
      suppliedSession = true
      continue
    }
    if (argument === '--session-dir' || argument === '--resume' || argument === '-r') {
      throw new Error(`Child launch argument is not permitted: ${argument}`)
    }
    rest.push(argument)
  }
  if (!suppliedSession) throw new Error('Child launch is missing its authorized session target.')
  return ['--session', sessionPath, ...rest]
}

function trustedResourceConstraints(workspaceRoot: string): LaunchResourceConstraints {
  return Object.freeze({
    allowedCwdRoot: workspaceRoot,
    projectExtensions: true,
    projectSkills: true,
    projectPromptTemplates: true,
    projectThemes: true,
    projectContextFiles: true,
    projectMcpConfig: true,
  })
}

function trackIssuedLaunch(
  registry: WorkerRegistry | undefined,
  tokenId: string,
  kind: string,
  paneId: string,
  parentWorkerId: string | undefined,
  now: number,
): void {
  if (!registry) return
  const id = `herdr:${tokenId}`
  if (registry.snapshot(id)) return
  const parent = parentWorkerId ? registry.snapshot(parentWorkerId) : null
  const reason = 'The Herdr child-session observer is not wired for this runtime.'
  const summary: WorkerSummary = {
    id,
    parentId: parent ? parentWorkerId! : null,
    rootId: parent?.summary.rootId ?? id,
    name: `Herdr ${kind} child`,
    type: 'herdr-child',
    description: `Prepared ${kind} child launch`,
    status: 'running',
    model: null,
    startedAt: now,
    completedAt: null,
    usage: null,
    error: null,
    source: 'live',
    provider: 'herdr',
    providerDetails: {
      herdr: {
        paneId,
        kind: kind as 'fresh' | 'resume' | 'handoff',
        nativeState: null,
        nativeSessionId: null,
        nativeSessionPath: null,
        nativeStateMessage: null,
        detached: false,
        persistent: false,
        lifetime: 'launch-issued',
        transcript: 'unavailable',
        childPid: null,
        controls: {
          steer: { available: false, reason },
          abort: { available: false, reason },
          resume: { available: false, reason },
        },
      },
    },
  }
  registry.upsert(summary, parent ? [...parent.ancestry, parent.summary.id] : [])
  if (registry.list().providerState === 'provider-unavailable') registry.setProviderState('partial')
}

/**
 * Main-process launch capability for an app-local fork of pi-herdr-agents.
 * Adoption seam: replace the fresh/handoff command assembly and resumed-launch
 * command assembly in `subagents/launch.ts` (including its literal `pi` and
 * `PI_CODING_AGENT_DIR` branches) with `herdr.launch.prepare`, pass the pane id
 * returned by its pane-creation operation, then spawn the returned executable,
 * args, cwd, and env. Do not expose the token as a command argument; do not
 * route arbitrary pane/shell execution through this API.
 */
export class HerdrChildLaunchService {
  readonly capability: CapabilityDefinition<HerdrLaunchPrepareRequest, HerdrLaunchPreparedResponse>
  private readonly channel: LaunchChannel
  private readonly getLaunchPolicy: HerdrChildLaunchOptions['getLaunchPolicy']
  private readonly getWorkerRegistry: HerdrChildLaunchOptions['getWorkerRegistry']
  private readonly childSessionObserver: HerdrChildLaunchOptions['childSessionObserver']
  private readonly getParentWorkerId: HerdrChildLaunchOptions['getParentWorkerId']
  private readonly isPersistentLaunch: HerdrChildLaunchOptions['isPersistentLaunch']
  private readonly getLaunchName: HerdrChildLaunchOptions['getLaunchName']
  private readonly environment: NodeJS.ProcessEnv
  private readonly now: () => number

  constructor(options: HerdrChildLaunchOptions) {
    this.channel = options.channel
    this.getLaunchPolicy = options.getLaunchPolicy
    this.getWorkerRegistry = options.getWorkerRegistry
    this.childSessionObserver = options.childSessionObserver
    this.getParentWorkerId = options.getParentWorkerId
    this.isPersistentLaunch = options.isPersistentLaunch
    this.getLaunchName = options.getLaunchName
    this.environment = options.environment ?? process.env
    this.now = options.now ?? Date.now
    this.capability = {
      id: HERDR_LAUNCH_CAPABILITY,
      scope: 'runtime',
      validateRequest: isHerdrLaunchPrepareRequest,
      validateResponse: isHerdrLaunchPreparedResponse,
      handle: (context, request) => this.prepare(context, request),
    }
  }

  /** Parent protocol receivers may pass Herdr's existing report messages here. */
  receiveHerdrReport(request: HerdrAgentReportRequest): boolean {
    return this.childSessionObserver?.receiveReport(request) ?? false
  }

  prepare(context: CapabilityContext, request: HerdrLaunchPrepareRequest): HerdrLaunchPreparedResponse {
    const runtimeScope = context.scope
    if (!runtimeScope) throw new Error('A current runtime scope is required for a Herdr child launch.')
    const policy = this.getLaunchPolicy(runtimeScope)
    if (!policy || policy.isRevoked() || policy.scope.trustDecision !== 'trusted') {
      throw new Error('Current runtime trust does not allow a Herdr child launch.')
    }
    if (policy.scope.runtimeId.length === 0 || policy.isRevoked()) {
      throw new Error('Current runtime launch policy is unavailable or revoked.')
    }

    const workspaceRoot = canonicalDirectory(policy.scope.workspaceRoot)
    const agentDir = canonicalDirectory(policy.scope.agentDir)
    const targetCwd = policy.assertLaunchAllowed(request.agentSpec.cwd)
    if (!isWithin(workspaceRoot, targetCwd) || policy.isRevoked()) {
      throw new Error('Child launch target is outside the current trusted workspace.')
    }
    const targetAgentDir = request.agentSpec.agentDir === undefined
      ? agentDir
      : canonicalDirectory(request.agentSpec.agentDir)
    if (targetAgentDir !== agentDir && !isWithin(workspaceRoot, targetAgentDir)) {
      throw new Error('Child agent directory is outside the current runtime scope.')
    }

    const allowedSessionRoots = [agentDir, workspaceRoot]
    const isResume = request.agentSpec.kind === 'resume'
    const session = canonicalSessionFile(request.agentSpec.sessionFile ?? '', allowedSessionRoots, isResume)
    if (session.cwd !== undefined && !isWithin(workspaceRoot, session.cwd)) {
      throw new Error('Child session working directory is outside the current trusted workspace.')
    }
    if (session.cwd !== undefined && session.cwd !== targetCwd) {
      throw new Error('Child session target no longer matches the current launch directory.')
    }
    if (request.agentSpec.kind === 'handoff') {
      const source = canonicalSessionFile(request.agentSpec.sourceSessionFile ?? '', allowedSessionRoots, true)
      if (!source.cwd || !isWithin(workspaceRoot, source.cwd)) {
        throw new Error('Handoff source session is outside the current trusted workspace.')
      }
    }
    const args = controlledSessionArgs(request.agentSpec.args, session.path)
    const endpoint = resolveHerdrEndpoint(this.environment)
    if (!endpoint) throw new Error('Herdr reporting endpoint is unavailable.')
    const childEndpoint = Object.freeze({
      socketPath: endpoint.socketPath,
      paneId: request.agentSpec.herdrPaneId,
    })
    if (policy.isRevoked()) throw new Error('Runtime trust was revoked before child launch preparation.')

    const issuedAt = this.now()
    const launchId = request.agentSpec.launchId ?? randomUUID()
    const descriptor: LaunchScopeDescriptor = Object.freeze({
      launchId,
      runtimeScope: Object.freeze({ ...runtimeScope }),
      runtimeId: policy.scope.runtimeId,
      workspaceRoot,
      agentDir,
      trustDecision: policy.scope.trustDecision,
      targetCwd,
      targetAgentDir,
      issuedAt,
      expiresAt: issuedAt + LAUNCH_TTL_MS,
      resourceConstraints: trustedResourceConstraints(workspaceRoot),
      herdr: childEndpoint,
    })
    const issued = this.channel.issue(descriptor, policy.isRevoked)
    const tokenId = issued.token.split('.')[1]
    const parentWorkerId = this.getParentWorkerId?.(context)
      ?? this.childSessionObserver?.workerIdForPane(this.environment.HERDR_PANE_ID ?? '')
    try {
      if (tokenId && this.childSessionObserver) {
        this.childSessionObserver.registerLaunch({
          tokenId,
          agentSpec: request.agentSpec,
          parentWorkerId,
          launchScope: descriptor,
          persistent: this.isPersistentLaunch?.(request) ?? false,
          name: this.getLaunchName?.(request),
        })
      } else {
        trackIssuedLaunch(
          this.getWorkerRegistry?.(),
          tokenId ?? launchId,
          request.agentSpec.kind,
          childEndpoint.paneId,
          parentWorkerId,
          issuedAt,
        )
      }
    } catch {
      // Worker observation is additive and cannot invalidate an authorized launch.
    }

    return {
      command: Object.freeze({ executable: 'pi', args }),
      env: Object.freeze({
        PI_CODING_AGENT_DIR: targetAgentDir,
        PI_DESKTOP_LAUNCH_TOKEN: issued.token,
        PI_DESKTOP_LAUNCH_ENDPOINT: issued.endpoint,
        HERDR_ENV: '1',
        HERDR_SOCKET_PATH: endpoint.socketPath,
        HERDR_PANE_ID: childEndpoint.paneId,
      }),
      cwd: targetCwd,
    }
  }
}
