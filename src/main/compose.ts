import { app, shell, type BrowserWindow, type OpenDialogOptions, type OpenDialogReturnValue, type SaveDialogOptions, type SaveDialogReturnValue } from 'electron'
import { join, resolve } from 'node:path'
import { shareSessionNative, type AgentSession, type ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { AppPreferencesStore } from './config/app-preferences.ts'
import {
  createHerdrSettingsProvider,
  createSubagentsSettingsProvider,
  NativeSettingsService,
} from './config/native-settings-service.ts'
import { ScopedSettingsService } from './config/settings-service.ts'
import { CommandDispatcher } from './commands/dispatch.ts'
import { registerNativeCoreCommandAdapters } from './commands/native-core-adapter.ts'
import { CodemodeService } from './codemode/codemode-service.ts'
import { CodemodeTraceStore } from './codemode/trace-store.ts'
import { HerdrSettingsStore } from './herdr/settings.ts'
import { registerChatCapabilities, registerChatEvents } from './ipc/chat.ts'
import { registerCodemodeCapabilities, registerCodemodeEvents } from './ipc/codemode.ts'
import { registerCommandCapabilities } from './ipc/commands.ts'
import { registerFileCapabilities } from './ipc/files.ts'
import { registerHerdrSettingsCapabilities } from './ipc/herdr-settings.ts'
import { registerAppPreferenceCapabilities } from './ipc/preferences.ts'
import { registerDiagnosticsCapabilities } from './ipc/diagnostics.ts'
import { registerSettingsCapabilities, registerSettingsEvents, type SettingsCapabilityRouter } from './ipc/settings.ts'
import { createPackagesIpcDefinitions } from './ipc/packages.ts'
import { registerUsageCapabilities, registerUsageEvents, type UsageIpcService } from './ipc/usage.ts'
import { registerModelCapabilities, type ModelCapabilityRouter } from './ipc/models.ts'
import { registerProviderCapabilities, registerProviderEvents, type ProviderCapabilityRouter } from './ipc/providers.ts'
import {
  registerAgentDefinitionCapabilities,
  withHerdrAgentDefinitions,
  withNicobailonAgentDefinitions,
  withTintinwebAgentDefinitions,
  type AgentDefinitionCapabilityRouter,
} from './ipc/agent-definitions.ts'
import { registerMcpCapabilities, registerMcpEvents, type McpIpcRuntimeBinding } from './ipc/mcp.ts'
import { registerMcpBackendCapabilities, type McpBackendRuntimeBinding } from './mcp/composition.ts'
import { registerSessionsCapabilities, registerSessionsEvents, type SessionsIpcService } from './ipc/sessions.ts'
import { registerTransferCapabilities, registerTransferEvents } from './ipc/transfer.ts'
import { registerWorkerCapabilities, registerWorkerControlCapabilities, registerWorkerEvents } from './ipc/workers.ts'
import { registerWorkspaceCapabilities, registerWorkspaceEvents } from './ipc/workspaces.ts'
import { createExtensionUIBridgeRouter } from './ipc/extension-ui.ts'
import type { CapabilityDefinition, EventDefinition, AuthorizedIpcCaller } from './ipc/register.ts'
import {
  bindWebAccessNativeStatusBridge,
  clearWebAccessNativeOwner,
  resolveWebAccessNativeOwner,
} from './extensions/web-access-binding.ts'
import { AccountService } from './models/account-service.ts'
import { ModelService } from './models/model-service.ts'
import { ModelSettingsService } from './models/model-settings.ts'
import { ProviderModelConfigService } from './models/provider-model-config.ts'
import { TintinwebDefinitions } from './agents/tintinweb-definitions.ts'
import { NicobailonDefinitions } from './agents/nicobailon-definitions.ts'
import { HerdrDefinitionStore } from './herdr/definitions.ts'
import { McpConfigService } from './mcp/config-service.ts'
import { McpConnectionService } from './mcp/connection-service.ts'
import { createScopedMcpExposureSettingsStore, McpExposureService } from './mcp/exposure-service.ts'
import { McpSecretsStore } from './security/secrets.ts'
import { ElectronMcpSecretBackend } from './security/electron-mcp-secret-backend.ts'
import { PackageService } from './packages/package-service.ts'
import { ResourceService } from './packages/resource-service.ts'
import { SkillService } from './packages/skill-service.ts'
import { createPiSessionSwitchPort, type PiSessionHost } from './pi/session-host.ts'
import { ChatInputService } from './pi/input-service.ts'
import { RuntimeOperations, type RuntimeOperationRuntime } from './pi/runtime-operations.ts'
import { UsageService } from './usage/usage-service.ts'
import { PrivilegedFileService } from './security/file-service.ts'
import { createRuntimeLaunchPolicy, type RuntimeLaunchPolicy } from './security/launch-policy.ts'
import {
  createTintinwebObserver,
  createWorkerHistoryServices,
  type TintinwebEventBus,
} from './workers/tintinweb-observer.ts'
import { WorkerControls, type WorkerAgentManager } from './workers/worker-controls.ts'
import { WorkerRegistry } from './workers/worker-registry.ts'
import { SessionIndex } from './sessions/session-index.ts'
import type { SessionSwitchPort } from './sessions/session-service.ts'
import { TransferService } from './sessions/transfer-service.ts'
import type { RuntimeScope } from '../shared/ipc-contracts.ts'
import type { NativeCoreCommandOutcome } from '../shared/commands.ts'
import { HERDR_SETTINGS_PROVIDER } from '../shared/herdr-settings.ts'
import type { RuntimeLaunchScope } from './security/launch-policy.ts'
import type { CreatePiSessionHostOptions, PiHostBootstrap } from './pi/bootstrap.ts'
import { WorkspaceService, type ActiveWorkspaceRuntime, type WorkspaceSessionHost } from './workspaces/workspace-service.ts'
import { createNativeFolderPicker } from './workspaces/folder-picker.ts'
import {
  registerFffHostActions,
  registerIntercomHostActions,
  registerMultiAccountHostActions,
  registerPowerlineHostActions,
  registerPreviewHostActions,
  registerQuotaHostActions,
  registerTasksHostActions,
  registerWebAccessHostActions,
} from './extensions/host-actions/index.ts'
import { DiagnosticLogService, installGlobalHandlers, type DiagnosticSaveDialogResult } from './logging/log-service.ts'

type Capability = CapabilityDefinition<any, any>
type IpcEvent = EventDefinition<any>

interface CompositionOptions {
  readonly registryFilePath: string
  readonly userDataDirectory: string
  readonly bootstrap: PiHostBootstrap
  readonly trustStore: ProjectTrustStore
  readonly appPreferences: AppPreferencesStore
  readonly authorizeCallerActive: (caller: AuthorizedIpcCaller) => boolean
  readonly getWindow: (caller: AuthorizedIpcCaller) => BrowserWindow | null
  readonly showOpenDialog: (window: BrowserWindow, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>
  readonly showSaveDialog: (window: BrowserWindow, options: SaveDialogOptions) => Promise<SaveDialogReturnValue>
  readonly showDiagnosticSaveDialog: (options: SaveDialogOptions) => Promise<DiagnosticSaveDialogResult>
}

interface RuntimeServices {
  readonly identity: ActiveWorkspaceRuntime
  readonly runtimeId: string
  readonly sessionIndex: SessionIndex
  readonly sessionContext: { readonly cwd: string; readonly sessionDir: string }
  readonly chat: ChatInputService
  readonly models: ModelService
  readonly modelSettings: ModelSettingsService
  readonly providerModelConfig: ProviderModelConfigService
  readonly accounts: AccountService
  readonly usage: UsageService
  readonly settings: NativeSettingsService
  readonly packages: PackageService
  readonly resources: ResourceService
  readonly skills: SkillService
  readonly definitions: {
    readonly tintinweb: TintinwebDefinitions
    readonly nicobailon: NicobailonDefinitions
    readonly herdr: HerdrDefinitionStore
  }
  readonly mcp?: McpIpcRuntimeBinding
  readonly mcpBackend?: McpBackendRuntimeBinding
  readonly workers: WorkerRegistry
  readonly workerManager?: WorkerAgentManager
  readonly launchPolicy: RuntimeLaunchPolicy
  readonly herdrSettings: HerdrSettingsStore
  readonly host: WorkspaceSessionHost
}

interface RuntimeServicesLease {
  readonly runtime: RuntimeServices
  dispose(): void
}

interface PiSubagentsRegistry {
  readonly manager?: unknown
  readonly ready?: boolean
  readonly events?: TintinwebEventBus
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function scopeKey(scope: RuntimeScope): string {
  return `${scope.ownerId}:${scope.generation}`
}

/** Match pi's per-cwd default session directory without scanning other agent sessions. */
function nativeWorkerSessionDirectory(agentDir: string, cwd: string): string {
  const resolvedCwd = resolve(cwd)
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(agentDir, 'sessions', safePath)
}

function asSessionHost(host: WorkspaceSessionHost): PiSessionHost {
  return host as PiSessionHost
}

function getSubagentsRegistry(): PiSubagentsRegistry | undefined {
  const candidate: unknown = Reflect.get(globalThis, Symbol.for('pi-subagents:manager'))
  if (!record(candidate)
    || !record(candidate.events)
    || typeof candidate.events.on !== 'function') return undefined
  return candidate as unknown as PiSubagentsRegistry
}

function getWorkerManager(value: unknown): WorkerAgentManager | undefined {
  if (!record(value)
    || typeof value.getRecord !== 'function'
    || typeof value.steer !== 'function'
    || typeof value.abort !== 'function'
    || typeof value.resume !== 'function') return undefined
  return value as unknown as WorkerAgentManager
}

function emptyWorkers(): ReturnType<WorkerRegistry['list']> {
  return { providerState: 'provider-unavailable', workers: [] }
}

/** Single composition point for completed main-process capability families and workspace runtimes. */
export class MainComposition {
  readonly workspaceService: WorkspaceService
  readonly logService: DiagnosticLogService
  readonly extensionUIBridgeRouter = createExtensionUIBridgeRouter()
  readonly capabilities: readonly Capability[]
  readonly events: readonly IpcEvent[]
  private readonly options: CompositionOptions
  private readonly preferences: AppPreferencesStore
  private readonly services = new Map<string, RuntimeServices>()
  private readonly workerManagers = new Map<string, WorkerAgentManager>()
  private readonly launchPolicies = new Map<string, RuntimeLaunchPolicy>()
  private readonly preparedIndexes = new Map<string, SessionIndex>()
  private readonly tempCleanups = new Set<() => void>()
  private readonly operations: RuntimeOperations
  private readonly chat: ChatInputService
  private readonly commands: CommandDispatcher
  private readonly codemode: CodemodeService
  private readonly transfer: TransferService
  private readonly nativeCommandDisposer: () => void
  private readonly sessionSwitch: SessionSwitchPort
  private readonly removeGlobalHandlers: () => void
  private readonly mcpSecrets: McpSecretsStore
  private disposed = false

  constructor(options: CompositionOptions) {
    this.options = options
    this.preferences = options.appPreferences
    this.mcpSecrets = new McpSecretsStore(new ElectronMcpSecretBackend(
      join(options.userDataDirectory, 'mcp-secrets.enc.json'),
    ))
    this.operations = new RuntimeOperations(() => {
      const current = this.currentRuntime()
      return current ? this.operationRuntime(current) : undefined
    })
    this.chat = new ChatInputService(this.operations)
    this.workspaceService = new WorkspaceService({
      registryFilePath: options.registryFilePath,
      trustStore: options.trustStore,
      createSessionHost: (hostOptions) => options.bootstrap.createSessionHost(hostOptions),
      setExtensionUIBridge: (bridge) => {
        this.extensionUIBridgeRouter.setActive(bridge)
        options.bootstrap.setNativeUiInvalidator(bridge ? () => bridge.invalidateNativeUi() : undefined)
      },
      sessionDirForWorkspace: (workspaceId) => this.sessionDirectory(workspaceId),
      runtimeOptionsForWorkspace: (workspace) => this.runtimeOptionsForWorkspace(workspace.id, workspace.path),
      onRuntimeStarted: (runtime) => this.runtimeStarted(runtime),
    })
    const diagnosticSettings = new NativeSettingsService(
      () => this.currentRuntime()?.host.session.settingsManager,
      { projectTrusted: () => this.currentRuntime()?.identity.trustDecision === 'trusted' },
    )
    this.logService = new DiagnosticLogService({
      preferences: this.preferences,
      workspaces: this.workspaceService,
      settings: diagnosticSettings,
      saveDialog: { showSaveDialog: options.showDiagnosticSaveDialog },
    })
    this.removeGlobalHandlers = installGlobalHandlers(this.logService)
    this.commands = new CommandDispatcher(this.workspaceService)
    this.sessionSwitch = this.createSessionSwitchPort()
    this.nativeCommandDisposer = registerNativeCoreCommandAdapters(this.commands, {
      sessionSwitch: this.sessionSwitch,
      outcomeSink: {
        publish: async (context, outcome) => this.handleNativeCommandOutcome(context.host, context.session, outcome),
      },
    })
    this.transfer = new TransferService({
      getRuntime: (caller, scope) => {
        const runtime = this.resolve(caller, scope)
        if (!runtime) return undefined
        return {
          session: runtime.host.session,
          cwd: runtime.sessionContext.cwd,
          importFromJsonl: async (path, cwd) => {
            const result = await runtime.host.importFromJsonl(path, cwd)
            if (!result.cancelled) await runtime.modelSettings.restoreScopedModels(runtime.host.session)
            return result
          },
        }
      },
      isRuntimeScopeCurrent: (caller, scope) => this.isAuthorizedRuntime(caller, scope),
      getWindow: options.getWindow,
      isCallerActive: options.authorizeCallerActive,
      showSaveDialog: options.showSaveDialog,
      showOpenDialog: options.showOpenDialog,
      shareOperation: {
        run: (session, shareOptions) => shareSessionNative(session, {
          signal: shareOptions.signal,
          onProgress: shareOptions.onProgress,
        }),
      },
    })
    const traceStore = new CodemodeTraceStore({
      directory: join(options.userDataDirectory, 'codemode-traces'),
      readPreferences: () => this.preferences.read(),
    })
    this.codemode = new CodemodeService(this.operations, traceStore)
    const hostActions = this.hostActionRegistrations()
    const packagesIpc = createPackagesIpcDefinitions((caller, scope) => {
      const runtime = this.resolve(caller, scope)
      return runtime ? { packages: runtime.packages, resources: runtime.resources, skills: runtime.skills } : undefined
    })
    const capabilities: Capability[] = [
      ...registerAppPreferenceCapabilities(this.preferences),
      ...registerChatCapabilities(this.chat),
      ...registerCommandCapabilities(this.commands),
      ...registerSessionsCapabilities(this.sessionsService()),
      ...registerWorkerCapabilities(this.workerRegistryProxy()),
      ...registerWorkerControlCapabilities(new WorkerControls({
        operations: this.operations,
        registry: this.workerRegistryProxy(),
        getManager: (runtimeId) => this.workerManagers.get(runtimeId),
        getLaunchPolicy: (runtimeId) => this.launchPolicies.get(runtimeId),
      }), {
        registry: this.workerRegistryProxy(),
      }),
      ...registerTransferCapabilities(this.transfer),
      ...registerCodemodeCapabilities(this.codemode),
      ...registerFileCapabilities(this.createFileService(), {
        authorizeWorkspace: (caller, scope, workspacePath) => {
          const runtime = this.resolve(caller, scope)
          return !!runtime && resolve(workspacePath) === runtime.sessionContext.cwd
        },
      }),
      ...registerHerdrSettingsCapabilities((provider, _requestedScope, context) => {
        if (provider !== HERDR_SETTINGS_PROVIDER || !this.options.authorizeCallerActive(context.caller)) return undefined
        const scope = context.scope
        const runtime = scope ? this.resolve(context.caller, scope) : this.currentRuntime()
        return runtime?.herdrSettings
      }),
      ...registerSettingsCapabilities(this.settingsRouter()),
      ...packagesIpc.capabilities,
      ...registerUsageCapabilities(this.usageRouter()),
      ...registerModelCapabilities(this.modelRouter()),
      ...registerProviderCapabilities(this.providerRouter()),
      ...registerAgentDefinitionCapabilities(this.agentDefinitionsRouter()),
      ...registerMcpCapabilities((caller, scope) => this.resolve(caller, scope)?.mcp),
      ...registerMcpBackendCapabilities((caller, scope) => this.resolve(caller, scope)?.mcpBackend),
      ...registerDiagnosticsCapabilities({
        isCallerAuthorized: (caller) => this.options.authorizeCallerActive(caller),
        resolve: (caller, scope) => {
          if (!this.options.authorizeCallerActive(caller)) return undefined
          const runtime = this.resolve(caller, scope)
          return runtime ? this.logService : undefined
        },
      }),
      ...registerWorkspaceCapabilities(this.workspaceService, createNativeFolderPicker({
        showOpenDialog: options.showOpenDialog,
        getWindow: options.getWindow,
        isCallerActive: options.authorizeCallerActive,
      })),
      ...this.extensionUIBridgeRouter.capabilities,
      ...hostActions.capabilities,
    ]
    const events: IpcEvent[] = [
      ...registerChatEvents(this.chat),
      ...registerSessionsEvents(this.sessionsService()),
      ...registerWorkerEvents(this.workerRegistryProxy()),
      ...registerSettingsEvents(this.settingsRouter()),
      ...packagesIpc.events,
      ...registerUsageEvents(this.usageRouter()),
      ...registerCodemodeEvents(this.codemode),
      ...registerProviderEvents(this.providerRouter()),
      ...registerMcpEvents((caller, scope) => this.resolve(caller, scope)?.mcp),
      ...registerTransferEvents(this.transfer),
      ...registerWorkspaceEvents(this.workspaceService),
      ...this.extensionUIBridgeRouter.events,
      ...hostActions.events,
    ]
    this.capabilities = capabilities
    this.events = events
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.removeGlobalHandlers()
    this.nativeCommandDisposer()
    this.transfer.dispose()
    this.codemode.dispose()
    for (const runtime of this.services.values()) this.disposeRuntimeServices(runtime)
    this.services.clear()
    this.workerManagers.clear()
    this.launchPolicies.clear()
    for (const cleanup of this.tempCleanups) {
      try { cleanup() } catch { /* cleanup is best-effort during application shutdown */ }
    }
    this.tempCleanups.clear()
  }

  private async runtimeOptionsForWorkspace(
    workspaceId: string,
    cwd: string,
  ): Promise<Omit<CreatePiSessionHostOptions, 'cwd' | 'sessionDir' | 'isProjectTrusted' | 'customViewHost'>> {
    const scope = this.workspaceService.getRuntimeScope()
    const index = new SessionIndex()
    const sessionDir = this.sessionDirectory(workspaceId)
    const recovery = await index.recoverStartup({ cwd, sessionDir })
    if (!this.workspaceService.authorizeRuntimeScope(scope)) return {}
    this.preparedIndexes.set(scopeKey(scope), index)
    const recoveredHostOptions: Pick<CreatePiSessionHostOptions, 'sessionManager'> = recovery.sessionManager
      ? { sessionManager: recovery.sessionManager }
      : {}
    return {
      ...recoveredHostOptions,
      nativeExtensionOwnerKey: scopeKey(scope),
    }
  }

  private async runtimeStarted(identity: ActiveWorkspaceRuntime): Promise<() => void> {
    const lease = await this.operations.createGuarded(
      () => this.createRuntimeServices(identity),
      () => !this.disposed
        && this.workspaceService.activeHost === identity.host
        && this.workspaceService.authorizeRuntimeScope(identity.scope),
    )
    if (!lease) throw new Error('The workspace runtime became stale during composition.')
    const { runtime } = lease
    const runtimeScope = runtime.identity.scope
    const { runtimeId } = runtime
    this.services.set(scopeKey(runtimeScope), runtime)
    if (runtime.workerManager) this.workerManagers.set(runtimeId, runtime.workerManager)
    this.launchPolicies.set(runtimeId, runtime.launchPolicy)
    try {
      runtime.usage.watch(runtimeScope)
      this.codemode.watch(runtimeScope)
    } catch (error) {
      this.services.delete(scopeKey(runtimeScope))
      this.workerManagers.delete(runtimeId)
      this.launchPolicies.delete(runtimeId)
      lease.dispose()
      throw error
    }
    return () => {
      this.codemode.dispose()
      this.services.delete(scopeKey(runtimeScope))
      this.workerManagers.delete(runtimeId)
      this.launchPolicies.delete(runtimeId)
      this.preparedIndexes.delete(scopeKey(runtimeScope))
      this.transfer.disposeScope(runtimeScope)
      lease.dispose()
    }
  }

  private async createRuntimeServices(identity: ActiveWorkspaceRuntime): Promise<RuntimeServicesLease> {
    const { scope, host, workspace } = identity
    const runtimeId = `${scope.ownerId}:${scope.generation}`
    const sessionDir = this.sessionDirectory(workspace.id)
    const sessionIndex = this.preparedIndexes.get(scopeKey(scope)) ?? new SessionIndex()
    this.preparedIndexes.delete(scopeKey(scope))
    const sessionContext = { cwd: workspace.path, sessionDir }
    host.setRuntimeOperations(this.operations)
    host.setRuntimeScopeProvider(() => this.workspaceService.activeHost === host
      && this.workspaceService.authorizeRuntimeScope(scope)
      ? scope
      : undefined)

    const modelSettings = new ModelSettingsService(() => host.session.settingsManager, () => host.session)
    const models = new ModelService(() => host.session)
    const providerModelConfig = new ProviderModelConfigService({
      agentDir: this.options.bootstrap.agentDir,
      models,
      authorizeMutation: () => {
        const current = this.services.get(scopeKey(scope))
        return this.workspaceService.activeHost === host
          && this.workspaceService.authorizeRuntimeScope(scope)
          && this.workspaceService.isRuntimeTrusted(scope)
          && current?.host === host
          && current.identity.host === host
          && current.identity.scope.ownerId === scope.ownerId
          && current.identity.scope.generation === scope.generation
          && current.models === models
      },
    })
    const accounts = new AccountService(() => host.session, {
      openExternal: async (url) => {
        if (this.workspaceService.activeHost !== host || !this.workspaceService.authorizeRuntimeScope(scope)) {
          throw new Error('The provider authentication runtime is no longer active.')
        }
        await shell.openExternal(url)
      },
    })
    const usage = new UsageService(this.operations, (requestedRuntimeId, requestedScope) => {
      const current = this.services.get(scopeKey(requestedScope))
      return current?.runtimeId === requestedRuntimeId ? current.workers : undefined
    })
    const launchScope: RuntimeLaunchScope = {
      workspaceRoot: workspace.path,
      agentDir: this.options.bootstrap.agentDir,
      trustDecision: identity.trustDecision,
      runtimeId,
    }
    const launchPolicy = createRuntimeLaunchPolicy(launchScope, () =>
      this.workspaceService.activeHost !== host || !this.workspaceService.isRuntimeTrusted(scope),
    )
    const registry = new WorkerRegistry(scope)
    const subagents = getSubagentsRegistry()
    const workerManager = getWorkerManager(subagents?.manager)
    const workerEvents: TintinwebEventBus = {
      on: (event, handler) => {
        const unsubscribe = subagents?.events?.on(event, handler) ?? (() => {})
        if (event === 'subagents:ready' && subagents?.ready) queueMicrotask(() => handler({}))
        return unsubscribe
      },
    }
    const captureReadyManager = workerEvents.on('subagents:ready', () => {
      if (this.workspaceService.activeHost !== host || !this.workspaceService.authorizeRuntimeScope(scope)) return
      const readyManager = getWorkerManager(getSubagentsRegistry()?.manager)
      if (readyManager) this.workerManagers.set(runtimeId, readyManager)
    })
    const scopedSettings = new ScopedSettingsService({
      user: this.options.bootstrap.agentDir,
      project: workspace.path,
    })
    const herdrSettings = new HerdrSettingsStore(scopedSettings)
    const settings = new NativeSettingsService(() => host.session.settingsManager, {
      projectTrusted: () => this.workspaceService.isRuntimeTrusted(scope),
      models: modelSettings,
      extensions: [
        createSubagentsSettingsProvider(scopedSettings),
        createHerdrSettingsProvider(herdrSettings),
      ],
    })
    const packages = new PackageService({
      cwd: workspace.path,
      agentDir: this.options.bootstrap.agentDir,
      settingsManager: host.session.settingsManager,
      isProjectTrusted: () => this.workspaceService.isRuntimeTrusted(scope),
    })
    const resources = new ResourceService({
      loader: host.runtime.services.resourceLoader,
      cwd: workspace.path,
      agentDir: this.options.bootstrap.agentDir,
      isProjectTrusted: () => this.workspaceService.isRuntimeTrusted(scope),
      reload: () => host.reload(),
      canReload: () => host.session.isIdle,
    })
    const skills = new SkillService({
      cwd: workspace.path,
      agentDir: this.options.bootstrap.agentDir,
      settingsManager: host.session.settingsManager,
      resources,
      isProjectTrusted: () => this.workspaceService.isRuntimeTrusted(scope),
    })
    const configuredDirectories = [
      sessionDir,
      nativeWorkerSessionDirectory(this.options.bootstrap.agentDir, workspace.path),
    ]
    const workerHistory = createWorkerHistoryServices(
      registry,
      [...new Set(configuredDirectories)],
      this.options.userDataDirectory,
      {
        workspaceId: workspace.id,
        workspacePath: resolve(workspace.path),
        runtimeId,
      },
    )
    const workerObserver = createTintinwebObserver({
      events: workerEvents,
      registry,
      scope,
      history: workerHistory,
      recovery: {
        cwd: workspace.path,
        rootSessionId: host.session.sessionId,
        readEntries: () => host.session.sessionManager.getEntries(),
      },
    })
    const definitions = {
      tintinweb: new TintinwebDefinitions({
        agentDir: this.options.bootstrap.agentDir,
        cwd: workspace.path,
        isProjectTrusted: () => this.workspaceService.isRuntimeTrusted(scope),
      }),
      nicobailon: new NicobailonDefinitions({
        agentDir: this.options.bootstrap.agentDir,
        cwd: workspace.path,
        isProjectTrusted: () => this.workspaceService.isRuntimeTrusted(scope),
      }),
      herdr: new HerdrDefinitionStore({
        userRoot: this.options.bootstrap.agentDir,
        ...(identity.trustDecision === 'trusted' ? { projectRoot: workspace.path } : {}),
        projectTrusted: identity.trustDecision === 'trusted',
      }),
    }
    const mcpFacade = this.options.bootstrap.mcpFacade
    let mcp: McpIpcRuntimeBinding | undefined
    let mcpBackend: McpBackendRuntimeBinding | undefined
    if (mcpFacade) {
      const config = new McpConfigService(this.options.bootstrap.agentDir)
      const connections = new McpConnectionService({ facade: mcpFacade })
      const exposure = new McpExposureService({
        native: mcpFacade,
        settings: createScopedMcpExposureSettingsStore({ agentDir: this.options.bootstrap.agentDir }),
      })
      const isProjectTrusted = () => this.workspaceService.isRuntimeTrusted(scope)
      mcp = {
        config,
        connections,
        secrets: this.mcpSecrets,
        cwd: workspace.path,
        isProjectTrusted,
      }
      mcpBackend = {
        scope: Object.freeze({ ...scope }),
        native: mcpFacade,
        config,
        cwd: workspace.path,
        isProjectTrusted,
        exposure,
        authorize: (caller, requestedScope, operation, _server) => {
          const current = this.resolve(caller, requestedScope)
          return current?.host === host
            && this.workspaceService.activeHost === host
            && this.workspaceService.isRuntimeTrusted(requestedScope)
            && current.mcpBackend?.native === mcpFacade
            && current.mcpBackend.exposure === exposure
            && current.mcpBackend.config === config
            && (operation === 'read' || operation === 'update-exposure')
        },
      }
    }
    const runtime: RuntimeServices = {
      identity,
      runtimeId,
      sessionIndex,
      sessionContext,
      chat: this.chat,
      models,
      modelSettings,
      providerModelConfig,
      accounts,
      usage,
      settings,
      packages,
      resources,
      skills,
      definitions,
      ...(mcp ? { mcp } : {}),
      ...(mcpBackend ? { mcpBackend } : {}),
      workers: registry,
      ...(workerManager ? { workerManager } : {}),
      launchPolicy,
      herdrSettings,
      host,
    }
    try {
      await modelSettings.restoreScopedModels(host.session)
      await workerObserver.ready
    } catch (error) {
      captureReadyManager()
      workerObserver.dispose()
      this.disposeRuntimeServices(runtime)
      this.workerManagers.delete(runtimeId)
      this.launchPolicies.delete(runtimeId)
      throw error
    }
    return {
      runtime,
      dispose: () => {
        captureReadyManager()
        workerObserver.dispose()
        this.disposeRuntimeServices(runtime)
      },
    }
  }

  private disposeRuntimeServices(runtime: RuntimeServices): void {
    clearWebAccessNativeOwner(scopeKey(runtime.identity.scope))
    runtime.usage.dispose()
    runtime.packages.dispose()
    runtime.resources.dispose()
    runtime.workers.dispose()
  }

  private currentRuntime(): RuntimeServices | undefined {
    const active = this.workspaceService?.activeRuntime
    if (!active) return undefined
    const runtime = this.services.get(scopeKey(active.scope))
    return runtime?.host === active.host ? runtime : undefined
  }

  private resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): RuntimeServices | undefined {
    if (!this.isAuthorizedRuntime(caller, scope)) return undefined
    return this.services.get(scopeKey(scope))
  }

  private isAuthorizedRuntime(caller: AuthorizedIpcCaller, scope: RuntimeScope): boolean {
    return this.options.authorizeCallerActive(caller)
      && this.workspaceService.authorizeRuntimeScope(scope)
      && this.services.has(scopeKey(scope))
  }

  private operationRuntime(runtime: RuntimeServices): RuntimeOperationRuntime {
    return {
      scope: runtime.identity.scope,
      runtimeId: runtime.runtimeId,
      workspaceRoot: runtime.sessionContext.cwd,
      agentDir: this.options.bootstrap.agentDir,
      trustDecision: runtime.identity.trustDecision,
      host: runtime.host,
    }
  }

  private sessionsService(): SessionsIpcService {
    return {
      list: async (caller, scope) => {
        const runtime = this.requireRuntime(caller, scope)
        return runtime.sessionIndex.list(runtime.sessionContext)
      },
      open: async (caller, scope, request) => {
        const runtime = this.requireRuntime(caller, scope)
        const manager = await runtime.sessionIndex.open(runtime.sessionContext, request.sessionId)
        const sessionFile = manager.getSessionFile()
        if (!sessionFile) return { cancelled: true }
        const result = await this.sessionSwitch.transition({
          kind: 'resume',
          cwd: runtime.sessionContext.cwd,
          sessionFile,
        })
        return result.status === 'cancelled'
          ? { cancelled: true }
          : { cancelled: false, sessionId: result.sessionId }
      },
      history: async (caller, scope, request) => {
        const runtime = this.requireRuntime(caller, scope)
        return runtime.sessionIndex.history(
          runtime.sessionContext,
          request.sessionId,
          request.offset,
          request.limit,
        )
      },
      subscribe: (caller, scope, publish) => {
        const runtime = this.requireRuntime(caller, scope)
        return runtime.host.subscribeSessionEvents(publish)
      },
    }
  }

  private createSessionSwitchPort(): SessionSwitchPort {
    const native = createPiSessionSwitchPort(() => {
      const host = this.workspaceService.activeHost
      return host ? asSessionHost(host) : undefined
    })
    return {
      transition: async (request) => {
        const result = await native.transition(request)
        if (result.status === 'applied') {
          const runtime = this.currentRuntime()
          if (runtime) await runtime.modelSettings.restoreScopedModels(runtime.host.session)
        }
        return result
      },
    }
  }

  private requireRuntime(caller: AuthorizedIpcCaller, scope: RuntimeScope): RuntimeServices {
    const runtime = this.resolve(caller, scope)
    if (!runtime) throw new Error('The requested workspace runtime is unavailable.')
    return runtime
  }

  private modelRouter(): ModelCapabilityRouter {
    return {
      isCallerAuthorized: (caller) => this.options.authorizeCallerActive(caller),
      resolve: (caller, scope) => {
        const runtime = this.resolve(caller, scope)
        return runtime ? { models: runtime.models, settings: runtime.modelSettings } : undefined
      },
    }
  }

  private providerRouter(): ProviderCapabilityRouter {
    return {
      isCallerAuthorized: (caller) => this.options.authorizeCallerActive(caller),
      resolve: (caller, scope) => this.resolve(caller, scope)?.accounts,
      resolveModelConfig: (caller, scope) => this.resolve(caller, scope)?.providerModelConfig,
    }
  }

  private agentDefinitionsRouter(): AgentDefinitionCapabilityRouter {
    const base: AgentDefinitionCapabilityRouter = {
      isCallerAuthorized: (caller) => this.options.authorizeCallerActive(caller),
      resolve: () => null,
    }
    const tintinweb = withTintinwebAgentDefinitions(
      base,
      (caller, scope) => this.resolve(caller, scope)?.definitions.tintinweb ?? null,
    )
    const nicobailon = withNicobailonAgentDefinitions(
      tintinweb,
      (caller, scope) => this.resolve(caller, scope)?.definitions.nicobailon ?? null,
    )
    return withHerdrAgentDefinitions(nicobailon, {
      isCallerAuthorized: (caller) => this.options.authorizeCallerActive(caller),
      resolve: (caller, scope) => this.resolve(caller, scope)?.definitions.herdr ?? null,
    })
  }

  private settingsRouter(): SettingsCapabilityRouter {
    return {
      isCallerAuthorized: (caller) => this.options.authorizeCallerActive(caller),
      resolve: (caller, scope) => this.resolve(caller, scope)?.settings,
    }
  }

  private usageRouter(): UsageIpcService {
    const usage = (caller: AuthorizedIpcCaller, scope: RuntimeScope): UsageService => this.requireRuntime(caller, scope).usage
    return {
      session: (caller, scope, sessionId) => usage(caller, scope).session(caller, scope, sessionId),
      turn: (caller, scope, sessionId) => usage(caller, scope).turn(caller, scope, sessionId),
      workers: (caller, scope, sessionId) => usage(caller, scope).workers(caller, scope, sessionId),
      models: (caller, scope, sessionId) => usage(caller, scope).models(caller, scope, sessionId),
      subscribe: (caller, scope, publish) => usage(caller, scope).subscribe(caller, scope, publish),
    }
  }

  private workerRegistryProxy(): WorkerRegistry {
    const composition = this
    const proxy = {
      isCurrentScope(scope: RuntimeScope): boolean {
        return composition.resolveActiveScope(scope)?.workers.isCurrentScope(scope) ?? false
      },
      list() {
        return composition.currentRuntime()?.workers.list() ?? emptyWorkers()
      },
      snapshot(workerId: string) {
        return composition.currentRuntime()?.workers.snapshot(workerId) ?? null
      },
      subscribe(caller: AuthorizedIpcCaller, scope: RuntimeScope, publish: Parameters<WorkerRegistry['subscribe']>[2]) {
        const runtime = composition.requireRuntime(caller, scope)
        return runtime.workers.subscribe(caller, scope, publish)
      },
    }
    return proxy as unknown as WorkerRegistry
  }

  private resolveActiveScope(scope: RuntimeScope): RuntimeServices | undefined {
    const runtime = this.currentRuntime()
    return runtime && runtime.identity.scope.ownerId === scope.ownerId
      && runtime.identity.scope.generation === scope.generation
      ? runtime
      : undefined
  }

  private hostActionRegistrations(): {
    readonly capabilities: readonly Capability[]
    readonly events: readonly IpcEvent[]
  } {
    const intercom = registerIntercomHostActions({
      resolve: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => {
        const runtime = this.resolve(caller, scope)
        if (!runtime) return null
        return {
          listLocalSessions: () => [{
            id: runtime.host.session.sessionId,
            ...(runtime.host.session.sessionName ? { name: runtime.host.session.sessionName } : {}),
            cwd: runtime.sessionContext.cwd,
            state: runtime.host.session.isIdle ? 'idle' as const : 'active' as const,
          }],
          readOverlayState: () => ({ open: false }),
          createContactSnippet: () => null,
          persistSessionAlias: (_caller, _scope, alias: string) => {
            runtime.host.session.setSessionName(alias)
            return true
          },
          readLocalTransportStatus: () => ({ state: 'unknown' as const, localBrokerAvailable: false }),
        }
      },
    })
    const powerline = registerPowerlineHostActions({
      chatInput: this.chat,
      authorizeRuntimeCaller: (caller, scope) => this.isAuthorizedRuntime(caller, scope),
      bridge: {
        resolve: (caller, scope) => {
          const runtime = this.resolve(caller, scope)
          if (!runtime) return null
          return {
            readStatusText: (_caller, _scope, field) => {
              if (field === 'title') return runtime.host.session.sessionName ?? ''
              if (field === 'model') {
                const model = runtime.host.session.model
                return model ? `${model.provider}/${model.id}` : ''
              }
              return runtime.sessionContext.cwd
            },
          }
        },
      },
    })
    const preview = registerPreviewHostActions({
      authorizeRuntimeCaller: (caller, scope) => this.isAuthorizedRuntime(caller, scope),
      shellOpen: {
        openLocalFile: async ({ filePath }) => (await shell.openPath(filePath)) === '',
      },
    })
    const tasks = registerTasksHostActions({
      authorizeRuntimeCaller: (caller, scope) => this.isAuthorizedRuntime(caller, scope),
      bridge: {
        resolve: (caller, scope) => {
          const runtime = this.resolve(caller, scope)
          if (!runtime) return null
          return {
            cwd: runtime.sessionContext.cwd,
            agentDir: this.options.bootstrap.agentDir,
            sessionId: runtime.host.session.sessionId,
            hasPersistentSession: typeof runtime.host.session.sessionFile === 'string',
          }
        },
      },
    })
    const fff = registerFffHostActions({
      authorizeRuntimeCaller: (caller, scope) => this.isAuthorizedRuntime(caller, scope),
      bridge: {
        resolve: (caller, scope) => this.resolve(caller, scope) ? {
          readMode: () => 'tools-and-ui' as const,
          readHealth: () => ({ available: false, mode: 'tools-and-ui' as const, scanning: false }),
          rescan: () => ({ started: false, alreadyScanning: false }),
        } : null,
      },
    })
    const quota = registerQuotaHostActions({
      authorizeRuntimeCaller: (caller, scope) => this.isAuthorizedRuntime(caller, scope),
      bridge: {
        resolve: (caller, scope) => this.resolve(caller, scope) ? {
          readCachedStatus: () => ({ provider: null, status: 'unsupported' as const }),
          fetchUsage: (_caller, _scope, provider) => ({ provider: provider ?? 'unsupported', status: 'unsupported' as const }),
          extractHar: () => { throw new Error('Quota HAR extraction is unavailable in this desktop host.') },
        } : null,
      },
    })
    const webAccess = registerWebAccessHostActions({
      authorizeRuntimeCaller: (caller, scope) => this.isAuthorizedRuntime(caller, scope),
      bridge: {
        resolve: (caller, scope) => {
          const runtime = this.resolve(caller, scope)
          if (!runtime) return null
          const nativeStatus = bindWebAccessNativeStatusBridge((activeCaller, activeScope) => {
            const activeRuntime = this.resolve(activeCaller, activeScope)
            if (!activeRuntime || activeRuntime.host !== runtime.host) return null
            return resolveWebAccessNativeOwner(scopeKey(activeRuntime.identity.scope))
          })
          return {
            ...nativeStatus,
            runSearch: () => { throw new Error('Foreground web search remains a native extension command.') },
            openExistingCurator: () => false,
          }
        },
      },
    })
    const multiAccount = registerMultiAccountHostActions({
      authorizeRuntimeCaller: (caller, scope) => this.isAuthorizedRuntime(caller, scope),
      agentDir: this.options.bootstrap.agentDir,
      bridge: {
        resolve: (caller, scope) => {
          const runtime = this.resolve(caller, scope)
          if (!runtime) return null
          return {
            readCurrentRoute: () => {
              const model = runtime.host.session.model
              return {
                ...(model ? { provider: model.provider, model: model.id } : {}),
                routeSource: 'unknown' as const,
              }
            },
          }
        },
      },
    })
    return {
      capabilities: [
        ...intercom.capabilities,
        ...powerline,
        ...preview,
        ...tasks,
        ...fff,
        ...quota,
        ...webAccess,
        ...multiAccount,
      ],
      events: intercom.events,
    }
  }

  private createFileService(): PrivilegedFileService {
    return new PrivilegedFileService({
      showSaveDialog: this.options.showSaveDialog,
      getWindow: this.options.getWindow,
      isCallerActive: this.options.authorizeCallerActive,
      tempRoot: join(this.options.userDataDirectory, 'temporary-files'),
      registerTempCleanup: (cleanup) => this.tempCleanups.add(cleanup),
    })
  }

  private sessionDirectory(workspaceId: string): string {
    return join(this.options.userDataDirectory, 'sessions', workspaceId)
  }

  private async handleNativeCommandOutcome(
    host: WorkspaceSessionHost,
    session: AgentSession,
    outcome: NativeCoreCommandOutcome,
  ): Promise<void> {
    if (outcome.type !== 'delegated') return
    const runtime = this.currentRuntime()
    if (!runtime || runtime.host !== host || runtime.host.session !== session) return
    if (outcome.target === 'workspace-trust') {
      await this.workspaceService.setActiveRuntimeTrust(runtime.identity.scope, !outcome.request.projectTrusted)
    } else if (outcome.target === 'application-quit') {
      app.quit()
    }
  }
}

export function createMainComposition(options: CompositionOptions): MainComposition {
  return new MainComposition(options)
}
