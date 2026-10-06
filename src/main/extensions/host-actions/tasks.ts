import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { RuntimeScope } from '../../../shared/ipc-contracts.ts'
import {
  HOST_ACTIONS,
  HOST_ACTION_LIMITS,
  isEmptyHostActionRequest,
  isTasksItemReadRequest,
  isTasksItemReadResponse,
  isTasksListReadRequest,
  isTasksListReadResponse,
  isTasksStatusReadResponse,
  type EmptyHostActionRequest,
  type InstalledTaskStatus,
  type InstalledTaskSummary,
  type TasksBackingStore,
  type TasksItemReadRequest,
  type TasksItemReadResponse,
  type TasksListReadRequest,
  type TasksListReadResponse,
  type TasksStatusReadResponse,
} from '../../../shared/host-actions.ts'
import type { AuthorizedIpcCaller, CapabilityDefinition } from '../../ipc/register.ts'

type NativeTaskRecord = Readonly<Record<string, unknown>>
type TaskScope = 'memory' | 'session' | 'session-global' | 'project'

export interface TasksRuntimeBridge {
  readonly cwd: string
  readonly agentDir: string
  readonly sessionId?: string
  /** False for --no-session or other sessions which have no persisted transcript. */
  readonly hasPersistentSession: boolean
  /** Captured PI_TASKS value for this extension instance; omitted means inherit the main process env. */
  readonly tasksOverride?: string
  /** Optional live accessor for the native TaskStore in memory mode. */
  readInMemoryTasks?(caller: AuthorizedIpcCaller, scope: RuntimeScope): Promise<readonly NativeTaskRecord[]> | readonly NativeTaskRecord[]
}

/** Requires-runtime-bridge accessor for the active task extension context; file stores are read natively below. */
export interface TasksRequiresRuntimeBridgeAccessor {
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): TasksRuntimeBridge | null
}

export interface TasksHostActionOptions {
  readonly bridge: TasksRequiresRuntimeBridgeAccessor
  readonly authorizeRuntimeCaller: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => boolean
}

interface TaskSnapshot {
  readonly store: TasksBackingStore
  readonly tasks: readonly InstalledTaskSummary[]
}

const MAX_TASK_FILE_BYTES = 8 * 1024 * 1024

function requireBridge(
  options: TasksHostActionOptions,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): { readonly scope: RuntimeScope; readonly bridge: TasksRuntimeBridge } {
  if (!scope || !options.authorizeRuntimeCaller(caller, scope)) throw new Error('A current authorized runtime scope is required for tasks actions.')
  const bridge = options.bridge.resolve(caller, scope)
  if (!bridge) throw new Error('Tasks runtime bridge is unavailable.')
  return { scope, bridge }
}

function readConfigTaskScope(agentDir: string, cwd: string): TaskScope {
  const read = (path: string): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  const global = read(join(agentDir, 'tasks-config.json'))
  const project = read(join(cwd, '.pi', 'tasks-config.json'))
  const configured = project.taskScope ?? global.taskScope
  return configured === 'memory' || configured === 'session-global' || configured === 'project' || configured === 'session'
    ? configured
    : 'session'
}

function projectKey(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

function nativeTaskFile(bridge: TasksRuntimeBridge): string | null {
  const cwd = resolve(bridge.cwd)
  const override = bridge.tasksOverride ?? process.env.PI_TASKS
  if (override === 'off') return null
  if (override && isAbsolute(override)) return override
  if (override?.startsWith('.')) return resolve(cwd, override)
  // pi-tasks intentionally anchors named stores to homedir(), unlike taskScope files.
  if (override) return join(homedir(), '.pi', 'tasks', `${override}.json`)

  const taskScope = readConfigTaskScope(bridge.agentDir, cwd)
  if (taskScope === 'memory') return null
  if (taskScope === 'project') return join(cwd, '.pi', 'tasks', 'tasks.json')
  const sessionId = bridge.sessionId
  if (!bridge.hasPersistentSession || !sessionId || !/^[a-zA-Z0-9._-]{1,256}$/.test(sessionId)) return null
  const workspaceFile = join(cwd, '.pi', 'tasks', `tasks-${sessionId}.json`)
  if (taskScope === 'session') return workspaceFile
  return existsSync(workspaceFile)
    ? workspaceFile
    : join(bridge.agentDir, 'tasks', 'sessions', projectKey(cwd), `tasks-${sessionId}.json`)
}

function safeText(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maximum)
    : ''
}

function normalizedTask(value: NativeTaskRecord): InstalledTaskSummary | null {
  if (typeof value.id !== 'string' || !value.id || !['pending', 'in_progress', 'completed'].includes(value.status as string)) return null
  const status = value.status as InstalledTaskStatus
  const blocks = Array.isArray(value.blocks) ? value.blocks.filter((id): id is string => typeof id === 'string').slice(0, HOST_ACTION_LIMITS.taskDependencyCount) : []
  const blockedBy = Array.isArray(value.blockedBy) ? value.blockedBy.filter((id): id is string => typeof id === 'string').slice(0, HOST_ACTION_LIMITS.taskDependencyCount) : []
  const activeForm = safeText(value.activeForm, HOST_ACTION_LIMITS.taskSubjectCharacters)
  const owner = safeText(value.owner, HOST_ACTION_LIMITS.taskIdCharacters)
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : 0
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt
  return {
    id: safeText(value.id, HOST_ACTION_LIMITS.taskIdCharacters),
    subject: safeText(value.subject, HOST_ACTION_LIMITS.taskSubjectCharacters),
    description: safeText(value.description, HOST_ACTION_LIMITS.taskDescriptionCharacters),
    status,
    ...(activeForm ? { activeForm } : {}),
    ...(owner ? { owner } : {}),
    blocks: blocks.map((id) => safeText(id, HOST_ACTION_LIMITS.taskIdCharacters)),
    blockedBy: blockedBy.map((id) => safeText(id, HOST_ACTION_LIMITS.taskIdCharacters)),
    createdAt,
    updatedAt,
  }
}

function sortNativeTasks(tasks: InstalledTaskSummary[]): InstalledTaskSummary[] {
  return tasks.sort((left, right) => {
    const leftId = Number(left.id)
    const rightId = Number(right.id)
    return Number.isFinite(leftId) && Number.isFinite(rightId)
      ? leftId - rightId
      : left.id.localeCompare(right.id)
  })
}

async function readTaskSnapshot(
  bridge: TasksRuntimeBridge,
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope,
): Promise<TaskSnapshot> {
  const file = nativeTaskFile(bridge)
  if (!file) {
    if (!bridge.readInMemoryTasks) return { store: 'unavailable', tasks: [] }
    try {
      const tasks = await bridge.readInMemoryTasks(caller, scope)
      return { store: 'memory', tasks: sortNativeTasks(tasks.map(normalizedTask).filter((task): task is InstalledTaskSummary => task !== null)) }
    } catch {
      return { store: 'unavailable', tasks: [] }
    }
  }

  try {
    if (!existsSync(file)) return { store: 'file', tasks: [] }
    if (statSync(file).size > MAX_TASK_FILE_BYTES) return { store: 'unavailable', tasks: [] }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { store: 'unavailable', tasks: [] }
    const rawTasks = (parsed as { tasks?: unknown }).tasks
    if (!Array.isArray(rawTasks)) return { store: 'unavailable', tasks: [] }
    const tasks = rawTasks
      .filter((task): task is NativeTaskRecord => task !== null && typeof task === 'object' && !Array.isArray(task))
      .map(normalizedTask)
      .filter((task): task is InstalledTaskSummary => task !== null)
    return { store: 'file', tasks: sortNativeTasks(tasks) }
  } catch {
    return { store: 'unavailable', tasks: [] }
  }
}

function summaryCounts(snapshot: TaskSnapshot): Omit<TasksStatusReadResponse, 'mutationDispatchHint'> {
  const pending = snapshot.tasks.filter((task) => task.status === 'pending').length
  const inProgress = snapshot.tasks.filter((task) => task.status === 'in_progress').length
  const completed = snapshot.tasks.filter((task) => task.status === 'completed').length
  return { store: snapshot.store, total: snapshot.tasks.length, pending, inProgress, completed }
}

/** Read-only mirror of pi-tasks' JSON store. Mutations remain native through the /tasks command. */
export function registerTasksHostActions(options: TasksHostActionOptions): readonly CapabilityDefinition<any, any>[] {
  const listRead: CapabilityDefinition<TasksListReadRequest, TasksListReadResponse> = {
    id: HOST_ACTIONS.tasks.listRead,
    scope: 'runtime',
    validateRequest: isTasksListReadRequest,
    validateResponse: isTasksListReadResponse,
    handle: async ({ caller, scope }, request) => {
      const { scope: runtimeScope, bridge } = requireBridge(options, caller, scope)
      const snapshot = await readTaskSnapshot(bridge, caller, runtimeScope)
      const filtered = request.status ? snapshot.tasks.filter((task) => task.status === request.status) : [...snapshot.tasks]
      const limit = request.limit ?? Math.min(HOST_ACTION_LIMITS.tasksCount, filtered.length)
      const tasks = filtered.slice(0, limit)
      return {
        tasks,
        total: filtered.length,
        truncated: tasks.length < filtered.length,
        store: snapshot.store,
        mutationDispatchHint: '/tasks',
      }
    },
  }

  const itemRead: CapabilityDefinition<TasksItemReadRequest, TasksItemReadResponse> = {
    id: HOST_ACTIONS.tasks.itemRead,
    scope: 'runtime',
    validateRequest: isTasksItemReadRequest,
    validateResponse: isTasksItemReadResponse,
    handle: async ({ caller, scope }, request) => {
      const { scope: runtimeScope, bridge } = requireBridge(options, caller, scope)
      const snapshot = await readTaskSnapshot(bridge, caller, runtimeScope)
      return {
        task: snapshot.tasks.find((task) => task.id === request.id) ?? null,
        store: snapshot.store,
        mutationDispatchHint: '/tasks',
      }
    },
  }

  const statusRead: CapabilityDefinition<EmptyHostActionRequest, TasksStatusReadResponse> = {
    id: HOST_ACTIONS.tasks.statusRead,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isTasksStatusReadResponse,
    handle: async ({ caller, scope }) => {
      const { scope: runtimeScope, bridge } = requireBridge(options, caller, scope)
      return { ...summaryCounts(await readTaskSnapshot(bridge, caller, runtimeScope)), mutationDispatchHint: '/tasks' }
    },
  }

  return [listRead, itemRead, statusRead]
}
