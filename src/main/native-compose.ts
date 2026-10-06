import { app, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type OpenDialogOptions, type OpenDialogReturnValue } from 'electron'
import { join } from 'node:path'
import type { AppPreferencesStore } from './config/app-preferences.ts'
import { registerAppPreferenceCapabilities } from './ipc/preferences.ts'
import { registerIpcCapabilities, type AuthorizedIpcCaller } from './ipc/register.ts'
import { registerNativeConfigCapabilities } from './ipc/native-config.ts'
import { registerNativeSubagentCapabilities } from './ipc/native-subagents.ts'
import { registerNativeUsageCapabilities } from './usage/native-usage.ts'
import { registerNativeResourceCapabilities } from './ipc/native-resources.ts'
import { NativeSkillPromptService } from './packages/native-skill-prompt-service.ts'
import { NativeResourcesOverviewService, registerNativeResourcesOverviewCapabilities } from './packages/native-resources-overview.ts'
import { NativeConfigFiles } from './config/native-config-files.ts'
import { registerNativeAgentDefinitionCapabilities } from './agents/native-agent-definitions.ts'
import { registerNativePiCapabilities, registerNativePiEvents } from './ipc/native-pi.ts'
import { NativeMcpConfig, registerNativeMcpCapabilities } from './mcp/native-mcp-config.ts'
import { registerWorkspaceCapabilities, type WorkspaceOperations } from './ipc/workspaces.ts'
import { createNativeFolderPicker } from './workspaces/folder-picker.ts'
import { NativeWorkspaceRegistry } from './workspaces/native-workspace-registry.ts'
import { NativeWorkspaceService } from './workspaces/native-workspace-service.ts'
import { createRpcUiBridge } from './pi/rpc-ui.ts'
import type { WorkspaceOperationResult, WorkspaceSnapshot } from '../shared/workspaces.ts'

export interface NativeMainCompositionOptions {
  readonly appPreferences: AppPreferencesStore
  readonly ipcMain: IpcMain
  readonly authorizeCaller: (event: IpcMainInvokeEvent) => AuthorizedIpcCaller | null
  readonly isCallerActive: (caller: AuthorizedIpcCaller) => boolean
  readonly getWindow: (caller: AuthorizedIpcCaller) => BrowserWindow | null
  readonly showOpenDialog: (window: BrowserWindow, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>
}

const NATIVE_OWNER_ID = 'native-pi'

export function createNativeMainComposition(options: NativeMainCompositionOptions) {
  const registry = new NativeWorkspaceRegistry(join(app.getPath('userData'), 'native-workspaces.json'))
  const workspaces = new NativeWorkspaceService(registry)
  const ui = createRpcUiBridge(() => workspaces.activeHost() ?? null, options.isCallerActive)
  const snapshot = (): WorkspaceSnapshot => {
    const host = workspaces.activeHost()
    const generation = host?.scope.processGeneration ?? 0
    const entries = workspaces.list()
    const activeWorkspaceId = host
      ? entries.find((workspace) => workspaces.getRuntimeScope(workspace.path) === host.scope)?.id ?? null
      : null
    return {
      generation,
      runtimeScope: { ownerId: NATIVE_OWNER_ID, generation },
      activeWorkspaceId,
      pendingPath: null,
      workspaces: entries,
    }
  }
  const operationResult = (outcome: WorkspaceOperationResult['outcome']): WorkspaceOperationResult => ({
    outcome,
    snapshot: snapshot(),
  })
  const mapOpen = async (result: Awaited<ReturnType<NativeWorkspaceService['open']>>): Promise<WorkspaceOperationResult> => {
    if (result.outcome === 'opened') return operationResult('opened')
    if (result.reason === 'missing') return operationResult('missing')
    if (result.reason === 'superseded') return operationResult('cancelled')
    // The true moved status is carried by the list projection (info statuses + movedFrom); the open-result union has no moved member.
    if (result.reason === 'moved') return operationResult('missing')
    // Invalid and unavailable are errors surfaced via the existing INTERNAL envelope, never a workspace-state claim.
    throw new Error('native workspace open failed: ' + result.reason)
  }
  const workspaceOperations: WorkspaceOperations = {
    list: async () => snapshot(),
    open: async (path) => mapOpen(await workspaces.open(path)),
    openRecent: async (workspaceId) => mapOpen(await workspaces.openRecent(workspaceId)),
    cancel: async () => {
      await workspaces.cancel()
      return operationResult('cancelled')
    },
  }
  const nativePiOperations = {
    activeHost: () => workspaces.activeHost(),
    workspaceSnapshot: snapshot,
    openSession: async (request: import('../shared/native-pi.ts').OpenSessionRequest) => {
      const result = await workspaces.openSession(request)
      return result.outcome === 'opened'
        ? { outcome: 'opened' as const, processGeneration: result.processGeneration }
        : { outcome: 'failed' as const, reason: result.reason }
    },
  }
  const configFiles = new NativeConfigFiles(() => {
    const host = workspaces.activeHost()
    if (!host) return null
    const active = workspaces.list().find((workspace) => workspaces.getRuntimeScope(workspace.path) === host.scope)
    return active ? active.path : null
  })
  const activeWorkspacePath = (): string | null => {
    const host = workspaces.activeHost()
    if (!host) return null
    return workspaces.list().find((workspace) => workspaces.getRuntimeScope(workspace.path) === host.scope)?.path ?? null
  }
  // Skills/templates are file-based; "loaded" is Pi's own get_commands answer (sourceInfo), never an in-process loader.
  const skillPrompts = new NativeSkillPromptService({
    activeWorkspacePath,
    loadedCommands: async () => {
      const host = workspaces.activeHost()
      if (!host) return null
      const reply = await host.controlRequest({ operation: 'commands-list', payload: {} })
      const value = reply.value as import('../shared/native-pi.ts').NativeCommandsResult
      return value && Array.isArray(value.commands) && value.error === null ? value.commands : null
    },
  })
  // Read-only Resources overview: settings.json packages + Pi's own get_commands attribution; never installs or writes.
  const resourcesOverview = new NativeResourcesOverviewService({
    activeWorkspacePath,
    loadedCommands: async () => {
      const host = workspaces.activeHost()
      if (!host) return null
      const reply = await host.controlRequest({ operation: 'commands-list', payload: {} })
      const value = reply.value as import('../shared/native-pi.ts').NativeCommandsResult
      return value && Array.isArray(value.commands) && value.error === null ? value.commands : null
    },
  })
  const folderPicker = createNativeFolderPicker({
    showOpenDialog: options.showOpenDialog,
    getWindow: options.getWindow,
    isCallerActive: options.isCallerActive,
  })
  const registration = registerIpcCapabilities({
    ipcMain: options.ipcMain,
    authorizeCaller: options.authorizeCaller,
    isCallerActive: options.isCallerActive,
    authorizeRuntimeScope: (_caller, scope) => scope.ownerId === NATIVE_OWNER_ID
      && workspaces.activeHost()?.scope.processGeneration === scope.generation,
    capabilities: [
      ...registerAppPreferenceCapabilities(options.appPreferences),
      ...registerWorkspaceCapabilities(workspaceOperations, folderPicker),
      ...registerNativePiCapabilities(nativePiOperations),
      ...registerNativeConfigCapabilities(configFiles, () => workspaces.restartActive()),
      ...registerNativeSubagentCapabilities(),
      ...registerNativeUsageCapabilities({
        currentSessionFile: async () => workspaces.activeHost()?.sessionFile() ?? null,
        activeWorkspacePath: () => {
          const host = workspaces.activeHost()
          if (!host) return null
          return workspaces.list().find((workspace) => workspaces.getRuntimeScope(workspace.path) === host.scope)?.path ?? null
        },
      }),
      // Config-only MCP management: edits the pi-mcp-adapter JSON files; Pi owns connections and OAuth.
      ...registerNativeMcpCapabilities(new NativeMcpConfig(() => {
        const host = workspaces.activeHost()
        if (!host) return null
        return workspaces.list().find((workspace) => workspaces.getRuntimeScope(workspace.path) === host.scope)?.path ?? null
      })),
      ...registerNativeResourceCapabilities(skillPrompts),
      ...registerNativeResourcesOverviewCapabilities(resourcesOverview),
      ...registerNativeAgentDefinitionCapabilities({
        isCallerActive: options.isCallerActive,
        // Same active-workspace lookup as native config: project scope exists only while a workspace host is active.
        activeWorkspacePath: () => {
          const host = workspaces.activeHost()
          if (!host) return null
          return workspaces.list().find((workspace) => workspaces.getRuntimeScope(workspace.path) === host.scope)?.path ?? null
        },
      }),
      ...ui.capabilities,
    ],
    events: [...registerNativePiEvents(workspaces), ...ui.events],
  })
  let disposal: Promise<void> | undefined
  return {
    workspaces,
    disposeCaller(webContentsId: number) {
      ui.disposeCaller(webContentsId)
      registration.disposeCaller(webContentsId)
    },
    dispose(): Promise<void> {
      if (!disposal) {
        ui.dispose()
        registration.dispose()
        disposal = workspaces.dispose()
      }
      return disposal
    },
  }
}
