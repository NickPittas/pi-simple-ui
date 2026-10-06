import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import {
  AGENT_DEFINITIONS_IPC,
  TINTINWEB_AGENT_DEFINITIONS_PROVIDER,
  isAgentDefinitionProvidersRequest,
  isAgentDefinitionProvidersResponse,
  type AgentDefinitionProvider,
  type AgentDefinitionProvidersResponse,
} from '../../shared/agent-definitions.ts'
import {
  registerAgentDefinitionCapabilities,
  withHerdrAgentDefinitions,
  withTintinwebAgentDefinitions,
  type AgentDefinitionCapabilityRouter,
} from '../ipc/agent-definitions.ts'
import type { AuthorizedIpcCaller, CapabilityDefinition } from '../ipc/register.ts'
import { HerdrDefinitionStore } from '../herdr/definitions.ts'
import { TintinwebDefinitions } from './tintinweb-definitions.ts'

/** Same resolution as Pi's getAgentDir(): $PI_CODING_AGENT_DIR (with `~` expansion) or ~/.pi/agent. */
export function nativeAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR
  if (configured) {
    if (configured === '~') return homedir()
    if (configured.startsWith('~/')) return join(homedir(), configured.slice(2))
    return resolve(configured)
  }
  return join(homedir(), '.pi', 'agent')
}

const HERDR_AGENT_DEFINITIONS_PROVIDER = 'herdr' as const

const PACKAGE_NAMES = {
  [TINTINWEB_AGENT_DEFINITIONS_PROVIDER]: '@tintinweb/pi-subagents',
  [HERDR_AGENT_DEFINITIONS_PROVIDER]: 'pi-herdr-agents',
} as const

interface InstalledPackage { readonly name: string; readonly root: string }

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function packageNameAt(root: string): string | undefined {
  const name = readJson(join(root, 'package.json'))?.name
  return typeof name === 'string' ? name : undefined
}

/** `npm:@scope/name@1.2.3` -> `@scope/name`; `npm:name` -> `name`. */
function npmName(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

/**
 * Packages listed in a Pi settings.json `packages` array that are present on disk. Entries may be strings or
 * `{ source, extensions? }`; an explicit empty `extensions` array loads nothing and so counts as disabled.
 */
function packagesFrom(settingsPath: string, base: string): InstalledPackage[] {
  const packages = readJson(settingsPath)?.packages
  if (!Array.isArray(packages)) return []
  const found: InstalledPackage[] = []
  for (const entry of packages) {
    const source = typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? (entry as { source?: unknown }).source : undefined)
    if (typeof source !== 'string') continue
    if (entry && typeof entry === 'object' && Array.isArray((entry as { extensions?: unknown }).extensions)
      && (entry as { extensions: unknown[] }).extensions.length === 0) continue
    let root: string | undefined
    let declared: string | undefined
    if (source.startsWith('npm:')) {
      declared = npmName(source.slice(4))
      root = join(base, 'npm', 'node_modules', declared)
    } else if (source.startsWith('git:')) {
      root = join(base, 'git', source.slice(4).replace(/^\/+/, '').replace(/\.git$/, '').replace(/@[^/]*$/, ''))
    } else if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) {
      root = isAbsolute(source) ? source : resolve(base, source)
    }
    if (!root || !existsSync(join(root, 'package.json'))) continue
    const name = packageNameAt(root)
    if (name) found.push({ name, root })
  }
  return found
}

export interface InstalledAgentProviders {
  readonly providers: readonly AgentDefinitionProvider[]
  /** Installed pi-herdr-agents package root (its `agents/` directory holds the bundled roles). */
  readonly herdrRoot: string | undefined
}

/**
 * Only providers whose extension is listed in the user's (or active project's) Pi settings `packages` and exists
 * on disk are offered. nicobailon's `pi-subagents` is deliberately not probed: no definition adapter is wired
 * into the active composition for it.
 */
export function detectInstalledAgentProviders(agentDir: string, projectCwd: string | undefined): InstalledAgentProviders {
  const installed = [
    ...packagesFrom(join(agentDir, 'settings.json'), agentDir),
    ...(projectCwd ? packagesFrom(join(projectCwd, '.pi', 'settings.json'), join(projectCwd, '.pi')) : []),
  ]
  const has = (name: string): InstalledPackage | undefined => installed.find((candidate) => candidate.name === name)
  const providers: AgentDefinitionProvider[] = []
  if (has(PACKAGE_NAMES.tintinweb)) providers.push(TINTINWEB_AGENT_DEFINITIONS_PROVIDER)
  const herdr = has(PACKAGE_NAMES.herdr)
  if (herdr) providers.push(HERDR_AGENT_DEFINITIONS_PROVIDER)
  let herdrRoot: string | undefined
  if (herdr) {
    try { herdrRoot = statSync(join(herdr.root, 'agents')).isDirectory() ? herdr.root : undefined } catch { herdrRoot = undefined }
  }
  return { providers, herdrRoot }
}

export interface NativeAgentDefinitionOptions {
  /** Active workspace cwd, or null when none is active (project scopes are then unavailable). */
  readonly activeWorkspacePath: () => string | null
  readonly isCallerActive: (caller: AuthorizedIpcCaller) => boolean
  readonly agentDir?: string
}

/**
 * Registers the shared agents.definitions.* capabilities for the native composition. Services are pure
 * file-system adapters rebuilt per call from the current workspace and Pi settings; runtime-scope validity
 * is enforced by the registry's authorizeRuntimeScope before any handler runs.
 */
export function registerNativeAgentDefinitionCapabilities(
  options: NativeAgentDefinitionOptions,
): CapabilityDefinition<any, any>[] {
  const agentDir = options.agentDir ?? nativeAgentDir()
  const current = () => {
    const cwd = options.activeWorkspacePath() ?? undefined
    return { cwd, detected: detectInstalledAgentProviders(agentDir, cwd) }
  }
  const base: AgentDefinitionCapabilityRouter = {
    isCallerAuthorized: (caller) => options.isCallerActive(caller),
    resolve: () => null,
  }
  const tintinweb = withTintinwebAgentDefinitions(base, (_caller: AuthorizedIpcCaller, _scope: RuntimeScope) => {
    const { cwd, detected } = current()
    return detected.providers.includes(TINTINWEB_AGENT_DEFINITIONS_PROVIDER)
      // Native workspaces are trust-managed by Pi itself; an active workspace is the app's project scope.
      ? new TintinwebDefinitions({ agentDir, ...(cwd ? { cwd } : {}), isProjectTrusted: () => cwd !== undefined })
      : null
  })
  const router = withHerdrAgentDefinitions(tintinweb, {
    isCallerAuthorized: (caller) => options.isCallerActive(caller),
    resolve: () => {
      const { cwd, detected } = current()
      if (!detected.providers.includes(HERDR_AGENT_DEFINITIONS_PROVIDER)) return null
      return new HerdrDefinitionStore({
        userRoot: agentDir,
        ...(cwd ? { projectRoot: cwd } : {}),
        projectTrusted: cwd !== undefined,
        ...(detected.herdrRoot ? { bundledRoot: detected.herdrRoot } : {}),
      })
    },
  })
  const providers: CapabilityDefinition<Record<string, never>, AgentDefinitionProvidersResponse> = {
    id: AGENT_DEFINITIONS_IPC.providers,
    scope: 'runtime',
    validateRequest: isAgentDefinitionProvidersRequest,
    validateResponse: isAgentDefinitionProvidersResponse,
    authorize: (caller) => options.isCallerActive(caller),
    handle: () => ({ providers: current().detected.providers }),
  }
  return [...registerAgentDefinitionCapabilities(router), providers]
}
