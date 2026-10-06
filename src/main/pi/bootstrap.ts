import { join, resolve } from 'node:path'
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  getAgentDir,
  initTheme,
  KeybindingsManager,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  setKeybindings,
  setRegisteredThemes,
  theme,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionServicesOptions,
  type CreateModelRuntimeOptions,
  type LoadedMcpConfig,
  type McpExtensionOptions,
  type ModelRuntime as ModelRuntimeType,
  type SettingsManager as SettingsManagerType,
} from '@earendil-works/pi-coding-agent'
import { createMainUICompanionExtension } from '../extensions/ui-companion.ts'
import { resolveHerdrEndpoint } from '../herdr/transport.ts'
import { createNativeMcpFacade, type NativeMcpFacade, type NativeMcpOwner } from '../mcp/native-facade.ts'
import type { CustomViewHost } from '../extensions/custom-view-host.ts'
import type { NativeCustomUIConfiguration } from '../extensions/native-custom-ui/native-custom-ui-host.ts'
import { PiSessionHost } from './session-host.ts'

type ResourceLoaderOptions = NonNullable<CreateAgentSessionServicesOptions['resourceLoaderOptions']>

export interface PiHostBootstrapOptions {
  readonly agentDir?: string
  readonly authPath?: string
  readonly modelsPath?: string
  readonly modelRuntime?: ModelRuntimeType
  readonly modelRuntimeOptions?: Omit<CreateModelRuntimeOptions, 'authPath' | 'modelsPath'>
}

export type PiProjectTrustPolicy = (cwd: string) => boolean | Promise<boolean>

export interface CreatePiSessionHostOptions {
  readonly cwd: string
  readonly sessionDir?: string
  readonly sessionManager?: SessionManager
  readonly settingsManager?: SettingsManagerType
  readonly settingsManagerFactory?: (
    cwd: string,
    agentDir: string,
    projectTrusted: boolean,
  ) => SettingsManagerType
  readonly isProjectTrusted?: PiProjectTrustPolicy
  readonly model?: CreateAgentSessionOptions['model']
  readonly tools?: CreateAgentSessionOptions['tools']
  readonly resourceLoaderOptions?: ResourceLoaderOptions
  readonly mcpOptions?: McpExtensionOptions
  readonly extensionBindings?: Parameters<AgentSession['bindExtensions']>[0]
  readonly customViewHost?: CustomViewHost & {
    configureNativeUI(configuration: NativeCustomUIConfiguration): void
  }
  /** Retained for existing runtime option producers; native extensions now load unchanged. */
  readonly nativeExtensionOwnerKey?: string
  /** Main lifecycle callback bound to the owning ExtensionUIBridge instance. */
  readonly setExtensionUIActiveSession?: (sessionId: string | undefined) => void
}

function emptyMcpConfig(): LoadedMcpConfig {
  return { servers: [], errors: [], autoEnableCodemode: false }
}

export class PiHostBootstrap {
  readonly agentDir: string
  readonly modelRuntime: ModelRuntimeType
  private activeHost: PiSessionHost | undefined
  private activeMcpFacade: NativeMcpFacade | undefined
  private nativeUiInvalidator: (() => void) | undefined
  private creatingHost = false
  private creationSettled: Promise<void> | undefined
  private resolveCreationSettled: (() => void) | undefined

  private constructor(agentDir: string, modelRuntime: ModelRuntimeType) {
    this.agentDir = agentDir
    this.modelRuntime = modelRuntime
  }

  get mcpFacade(): NativeMcpFacade | undefined {
    return this.activeMcpFacade
  }

  setNativeUiInvalidator(invalidateNativeUi: (() => void) | undefined): void {
    this.nativeUiInvalidator = invalidateNativeUi
  }

  static async create(options: PiHostBootstrapOptions = {}): Promise<PiHostBootstrap> {
    const agentDir = resolve(options.agentDir ?? getAgentDir())
    const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
      ...options.modelRuntimeOptions,
      authPath: options.authPath ?? join(agentDir, 'auth.json'),
      modelsPath: options.modelsPath ?? join(agentDir, 'models.json'),
      allowModelNetwork: false,
    })
    return new PiHostBootstrap(agentDir, modelRuntime)
  }

  async createSessionHost(options: CreatePiSessionHostOptions): Promise<PiSessionHost> {
    if (this.activeHost || this.creatingHost) {
      throw new Error('The Pi root session host is already active or starting.')
    }
    this.creatingHost = true
    this.creationSettled = new Promise<void>((resolveCreation) => {
      this.resolveCreationSettled = resolveCreation
    })
    const nativeMcpFacade = createNativeMcpFacade()
    try {
      const initialCwd = resolve(options.cwd)
      const invalidateNativeUi = this.nativeUiInvalidator
      const keybindings = KeybindingsManager.create(this.agentDir)
      let host: PiSessionHost | undefined
      const isActiveSession = (session: AgentSession): boolean => Boolean(
        host
        && this.activeHost === host
        && !host.isDisposed
        && host.session === session,
      )
      const refreshNativeUI = (session: AgentSession): void => {
        if (!isActiveSession(session)) return
        keybindings.reload()
        setKeybindings(keybindings)
        setRegisteredThemes(session.resourceLoader.getThemes().themes)
        initTheme(session.settingsManager.getTheme())
        options.customViewHost?.configureNativeUI({ theme, keybindings })
      }
      const bindReloadLifecycle = (session: AgentSession): void => {
        session.setReloadLifecycleHandlers({
          beforeReload: () => {
            if (!isActiveSession(session)) return
            try {
              invalidateNativeUi?.()
            } catch {
              // Native UI teardown is passive and must not interrupt Pi reload.
            }
          },
          beforeSessionStart: () => refreshNativeUI(session),
          afterResourcesReload: () => refreshNativeUI(session),
        })
      }
      const activateSession = (session: AgentSession): void => {
        if (!isActiveSession(session)) return
        bindReloadLifecycle(session)
        refreshNativeUI(session)
      }
      const trustPolicy = options.isProjectTrusted ?? (() => false)
      const makeRuntime: CreateAgentSessionRuntimeFactory = async ({
        cwd,
        agentDir,
        sessionManager,
        sessionStartEvent,
      }) => {
        const trusted = await trustPolicy(cwd)
        const settingsManager = options.settingsManagerFactory
          ? options.settingsManagerFactory(cwd, agentDir, trusted)
          : options.settingsManager && resolve(cwd) === initialCwd
            ? options.settingsManager
            : SettingsManager.create(cwd, agentDir, { projectTrusted: trusted })
        if (settingsManager.isProjectTrusted() !== trusted) settingsManager.setProjectTrusted(trusted)

        const mcpOptions: McpExtensionOptions & { onManager?: (manager: NativeMcpOwner | undefined) => void } = {
          ...options.mcpOptions,
          onManager: (manager) => {
            nativeMcpFacade.attach(manager)
            if (manager) this.activeMcpFacade = nativeMcpFacade
            else if (this.activeMcpFacade === nativeMcpFacade) this.activeMcpFacade = undefined
          },
        }
        if (!trusted) {
          // Pi's native default loader reads MCP files from disk; wait for explicit trust.
          mcpOptions.loadConfig ??= () => emptyMcpConfig()
          mcpOptions.createTransport ??= () => {
            throw new Error('MCP transports are disabled until the host supplies a trusted configuration.')
          }
        }
        const hostExtensions: NonNullable<ResourceLoaderOptions['extensionFactories']> = [
          {
            name: 'codemode',
            factory: createCodemodeExtension(),
            hidden: true,
            replaceable: true,
          },
          {
            name: 'mcp',
            factory: createMcpExtension(mcpOptions),
            hidden: true,
            replaceable: true,
          },
          {
            name: 'tool-search',
            factory: createToolSearchExtension(),
            hidden: true,
            replaceable: true,
          },
          {
            name: 'ui-companion',
            factory: createMainUICompanionExtension({
              enableHerdrReporting: resolveHerdrEndpoint(process.env) !== undefined,
            }),
            hidden: true,
            replaceable: true,
          },
        ]
        const callerResourceOptions = options.resourceLoaderOptions ?? {}
        const resourceLoaderOptions: ResourceLoaderOptions = {
          ...callerResourceOptions,
          extensionFactories: [...hostExtensions, ...(callerResourceOptions.extensionFactories ?? [])],
        }
        if (!trusted) {
          // Keep disk-discovered packages and workspace resources out; host-owned inline factories remain available.
          Object.assign(resourceLoaderOptions, {
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            additionalExtensionPaths: [],
            additionalSkillPaths: [],
            additionalPromptTemplatePaths: [],
            additionalThemePaths: [],
          })
        }

        const services = await createAgentSessionServices({
          cwd,
          agentDir,
          modelRuntime: this.modelRuntime,
          settingsManager,
          resourceLoaderOptions,
        })
        const result = await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model: options.model,
          tools: options.tools,
        })
        bindReloadLifecycle(result.session)
        return { ...result, services, diagnostics: services.diagnostics }
      }

      const sessionManager = options.sessionManager ?? SessionManager.create(initialCwd, options.sessionDir)
      const runtime = await createAgentSessionRuntime(makeRuntime, {
        cwd: initialCwd,
        agentDir: this.agentDir,
        sessionManager,
        sessionStartEvent: { type: 'session_start', reason: 'startup' },
      })
      options.customViewHost?.configureNativeRuntime(
        runtime.services.resourceLoader.getExtensions().runtime,
      )
      const sessionHost = new PiSessionHost(runtime, () => {
        if (this.activeHost === host) this.activeHost = undefined
      }, options.customViewHost, options.setExtensionUIActiveSession, () => {
        try {
          invalidateNativeUi?.()
        } catch {
          // Native UI teardown is passive and must not interrupt Pi session lifecycle.
        }
      }, activateSession)
      host = sessionHost
      this.activeHost = sessionHost
      try {
        activateSession(runtime.session)
        await sessionHost.bindExtensions(options.extensionBindings ?? {})
        refreshNativeUI(runtime.session)
      } catch (error) {
        await sessionHost.dispose()
        throw error
      }
      return sessionHost
    } catch (error) {
      if (this.activeMcpFacade === nativeMcpFacade) this.activeMcpFacade = undefined
      nativeMcpFacade.dispose()
      throw error
    } finally {
      this.creatingHost = false
      this.resolveCreationSettled?.()
      this.resolveCreationSettled = undefined
      this.creationSettled = undefined
    }
  }

  async dispose(): Promise<void> {
    await this.creationSettled
    await this.activeHost?.dispose()
    this.activeMcpFacade?.dispose()
    this.activeMcpFacade = undefined
  }
}

export function createPiHostBootstrap(options: PiHostBootstrapOptions = {}): Promise<PiHostBootstrap> {
  return PiHostBootstrap.create(options)
}
