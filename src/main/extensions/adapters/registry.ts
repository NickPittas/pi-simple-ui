import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { JSONValue, ResolvedSemanticView } from '@earendil-works/pi-coding-agent'
import { hasExactKeys, isPlainRecord } from '../../../shared/ipc-contracts.ts'

export interface SemanticViewAdapter {
  readonly viewId: string
  readonly version: number
  readonly actionIds: readonly string[]
  /** Native owner/provenance policy. It never receives renderer-supplied identity. */
  readonly owns: (view: ResolvedSemanticView<unknown>) => boolean
  readonly validateState: (state: JSONValue) => boolean
  readonly authorizeAction: (action: JSONValue) => boolean
}

function adapterKey(viewId: string, version: number): string {
  return `${viewId}\0${version}`
}

export class SemanticViewAdapterRegistry {
  private readonly adapters = new Map<string, SemanticViewAdapter>()

  register(adapter: SemanticViewAdapter): () => void {
    if (!adapter.viewId || !Number.isSafeInteger(adapter.version) || adapter.version < 1
      || adapter.actionIds.length === 0
      || new Set(adapter.actionIds).size !== adapter.actionIds.length) {
      throw new TypeError('Semantic view adapters require a unique view/version and action list.')
    }
    const key = adapterKey(adapter.viewId, adapter.version)
    if (this.adapters.has(key)) throw new TypeError('A semantic view adapter is already registered for this view version.')
    this.adapters.set(key, adapter)
    return () => {
      if (this.adapters.get(key) === adapter) this.adapters.delete(key)
    }
  }

  resolve(view: ResolvedSemanticView<unknown>): SemanticViewAdapter | undefined {
    const adapter = this.adapters.get(adapterKey(view.definition.id, view.definition.version))
    if (!adapter) return undefined
    try {
      return adapter.owns(view) ? adapter : undefined
    } catch {
      return undefined
    }
  }
}

const NUMERIC_SETTING_IDS = new Set([
  'maxConcurrent',
  'maxConcurrentForeground',
  'defaultMaxTurns',
  'maxSubagentDepth',
  'graceTurns',
])

function isSubagentsSettingsState(value: JSONValue): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['title', 'items'])
    || value.title !== 'Subagent Settings' || !Array.isArray(value.items)) return false
  return value.items.every((item) => {
    if (!isPlainRecord(item)
      || Object.keys(item).some((key) => !['id', 'label', 'description', 'currentValue', 'values'].includes(key))
      || typeof item.id !== 'string'
      || typeof item.label !== 'string'
      || typeof item.currentValue !== 'string'
      || (item.description !== undefined && typeof item.description !== 'string')
      || (item.values !== undefined && (!Array.isArray(item.values) || !item.values.every((entry) => typeof entry === 'string')))) {
      return false
    }
    return true
  })
}

function isSubagentsSettingsAction(value: JSONValue): boolean {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'cancel') return hasExactKeys(value, ['type'])
  if (value.type === 'edit') {
    return hasExactKeys(value, ['type', 'fieldId'])
      && typeof value.fieldId === 'string'
      && NUMERIC_SETTING_IDS.has(value.fieldId)
  }
  if (value.type === 'set') {
    return hasExactKeys(value, ['type', 'id', 'value'])
      && typeof value.id === 'string'
      && !NUMERIC_SETTING_IDS.has(value.id)
      && typeof value.value === 'string'
  }
  return false
}

function isAgentsMenuState(value: JSONValue): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['sections']) || !Array.isArray(value.sections)) return false
  return value.sections.every((section) => {
    if (!isPlainRecord(section) || !hasExactKeys(section, ['id', 'label', 'options'])
      || typeof section.id !== 'string' || typeof section.label !== 'string'
      || !Array.isArray(section.options)) return false
    return section.options.every((option) => isPlainRecord(option)
      && Object.keys(option).every((key) => ['id', 'label', 'description'].includes(key))
      && typeof option.id === 'string'
      && typeof option.label === 'string'
      && (option.description === undefined || typeof option.description === 'string'))
  })
}

function isAgentsMenuAction(value: JSONValue): boolean {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'cancel') return hasExactKeys(value, ['type'])
  return value.type === 'select'
    && hasExactKeys(value, ['type', 'optionId'])
    && typeof value.optionId === 'string'
}

function isFleetState(value: JSONValue): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['agents']) || !Array.isArray(value.agents)) return false
  return value.agents.every((agent) => isPlainRecord(agent)
    && Object.keys(agent).every((key) => ['id', 'name', 'type', 'status', 'activity', 'startedAt'].includes(key))
    && typeof agent.id === 'string'
    && typeof agent.name === 'string'
    && typeof agent.type === 'string'
    && typeof agent.status === 'string'
    && (agent.activity === undefined || typeof agent.activity === 'string')
    && (agent.startedAt === undefined || typeof agent.startedAt === 'number'))
}

function isFleetAction(value: JSONValue): boolean {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'refresh') return hasExactKeys(value, ['type'])
  if (value.type === 'abort') {
    return hasExactKeys(value, ['type', 'agentId']) && typeof value.agentId === 'string'
  }
  if (value.type === 'steer') {
    return hasExactKeys(value, ['type', 'agentId', 'message'])
      && typeof value.agentId === 'string'
      && typeof value.message === 'string'
      && value.message.trim() !== ''
  }
  return false
}

function isWorkflowMenuItem(value: JSONValue): boolean {
  return isPlainRecord(value)
    && Object.keys(value).every((key) => ['id', 'name', 'description', 'stepCount'].includes(key))
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && (value.description === undefined || typeof value.description === 'string')
    && (value.stepCount === undefined || (typeof value.stepCount === 'number' && Number.isInteger(value.stepCount)))
}

function isWorkflowsState(value: JSONValue): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ['workflows', 'running'])
    && Array.isArray(value.workflows)
    && value.workflows.every(isWorkflowMenuItem)
    && Array.isArray(value.running)
    && value.running.every(isWorkflowMenuItem)
}

function isWorkflowsAction(value: JSONValue): boolean {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'cancel') {
    return hasExactKeys(value, ['type'])
      || (hasExactKeys(value, ['type', 'workflowId']) && typeof value.workflowId === 'string')
  }
  return ['open', 'run', 'edit', 'delete'].includes(value.type)
    && hasExactKeys(value, ['type', 'workflowId'])
    && typeof value.workflowId === 'string'
}

const CONVERSATION_ENTRY_KINDS = new Set([
  'user', 'assistant', 'thinking', 'tool', 'tool-result', 'error', 'status',
])

function isConversationEntry(value: JSONValue): boolean {
  return isPlainRecord(value)
    && Object.keys(value).every((key) => [
      'kind', 'id', 'parentId', 'text', 'toolName', 'args', 'result', 'isError', 'timestamp',
    ].includes(key))
    && typeof value.kind === 'string'
    && CONVERSATION_ENTRY_KINDS.has(value.kind)
    && typeof value.id === 'string'
    && (value.parentId === undefined || typeof value.parentId === 'string')
    && (value.text === undefined || typeof value.text === 'string')
    && (value.toolName === undefined || typeof value.toolName === 'string')
    && (value.result === undefined || typeof value.result === 'string')
    && (value.isError === undefined || typeof value.isError === 'boolean')
    && (value.timestamp === undefined || typeof value.timestamp === 'number')
}

function isConversationState(value: JSONValue): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ['agentId', 'title', 'entries', 'running', 'canAbort', 'canSteer'])
    && typeof value.agentId === 'string'
    && typeof value.title === 'string'
    && Array.isArray(value.entries)
    && value.entries.every(isConversationEntry)
    && typeof value.running === 'boolean'
    && typeof value.canAbort === 'boolean'
    && typeof value.canSteer === 'boolean'
}

function isConversationAction(value: JSONValue): boolean {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'abort' || value.type === 'close') return hasExactKeys(value, ['type'])
  return value.type === 'steer'
    && hasExactKeys(value, ['type', 'message'])
    && typeof value.message === 'string'
    && value.message.trim() !== ''
}

const WEB_ACCESS_EXTENSION_PATH = [
  '../../../../vendor/pi-web-access/index.ts',
  '../../../vendor/pi-web-access/index.ts',
  '../../vendor/pi-web-access/index.ts',
].map((relativePath) => resolve(dirname(fileURLToPath(import.meta.url)), relativePath))
  .find((path) => existsSync(path))

const WEB_ACCESS_WORKFLOWS = new Set(['none', 'summary-review', 'auto-summary'])
const WEB_ACCESS_TOOL_ACTIVATIONS = new Set(['auto', 'dynamic', 'eager'])

function isBoundedSafeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function isWebAccessActivityState(value: JSONValue): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'activityVisible', 'workflow', 'toolActivation', 'commands', 'shortcuts',
    'entries', 'rateLimit', 'curators', 'cachedResults',
  ])
    || typeof value.activityVisible !== 'boolean'
    || typeof value.workflow !== 'string' || !WEB_ACCESS_WORKFLOWS.has(value.workflow)
    || typeof value.toolActivation !== 'string' || !WEB_ACCESS_TOOL_ACTIVATIONS.has(value.toolActivation)
    || !Array.isArray(value.entries) || value.entries.length > 10
    || !Array.isArray(value.curators) || value.curators.length > 8
    || !Array.isArray(value.cachedResults) || value.cachedResults.length > 20) return false

  if (!isPlainRecord(value.commands) || !hasExactKeys(value.commands, ['websearch', 'curator', 'search', 'googleAccount'])
    || !Object.values(value.commands).every((enabled) => typeof enabled === 'boolean')) return false
  if (!isPlainRecord(value.shortcuts) || !hasExactKeys(value.shortcuts, ['toggleActivity', 'reviewSearchResults'])
    || typeof value.shortcuts.toggleActivity !== 'string' || value.shortcuts.toggleActivity.length > 64
    || typeof value.shortcuts.reviewSearchResults !== 'string' || value.shortcuts.reviewSearchResults.length > 64) return false
  if (!isPlainRecord(value.rateLimit) || !hasExactKeys(value.rateLimit, ['used', 'max', 'resetMs'])
    || !isBoundedSafeInteger(value.rateLimit.used, 0, 100_000)
    || !isBoundedSafeInteger(value.rateLimit.max, 1, 100_000)
    || !isBoundedSafeInteger(value.rateLimit.resetMs, 0, 60_000)) return false

  const entriesValid = value.entries.every((entry) => isPlainRecord(entry)
    && hasExactKeys(entry, ['id', 'type', 'target', 'status', 'error', 'durationMs'])
    && typeof entry.id === 'string' && entry.id.length <= 80
    && (entry.type === 'api' || entry.type === 'fetch')
    && typeof entry.target === 'string' && entry.target.length <= 200
    && (entry.status === null || isBoundedSafeInteger(entry.status, 0, 599))
    && (entry.error === null || typeof entry.error === 'string' && entry.error.length <= 240)
    && isBoundedSafeInteger(entry.durationMs, 0, 86_400_000))
  if (!entriesValid) return false

  const curatorsValid = value.curators.every((curator) => isPlainRecord(curator)
    && hasExactKeys(curator, [
      'id', 'phase', 'queryCount', 'completedCount', 'resultCount', 'errorCount',
      'browserConnected', 'lastHeartbeatAgeMs',
    ])
    && typeof curator.id === 'string' && curator.id.length <= 80
    && (curator.phase === 'searching' || curator.phase === 'curating')
    && isBoundedSafeInteger(curator.queryCount, 0, 200)
    && isBoundedSafeInteger(curator.completedCount, 0, 200)
    && isBoundedSafeInteger(curator.resultCount, 0, 2_000)
    && isBoundedSafeInteger(curator.errorCount, 0, 200)
    && typeof curator.browserConnected === 'boolean'
    && (curator.lastHeartbeatAgeMs === null || isBoundedSafeInteger(curator.lastHeartbeatAgeMs, 0, 86_400_000)))
  if (!curatorsValid) return false

  return value.cachedResults.every((result) => isPlainRecord(result)
    && hasExactKeys(result, ['id', 'type', 'timestamp', 'title', 'summary'])
    && typeof result.id === 'string' && result.id.length <= 80
    && (result.type === 'search' || result.type === 'fetch' || result.type === 'research')
    && isBoundedSafeInteger(result.timestamp, 0, Number.MAX_SAFE_INTEGER)
    && typeof result.title === 'string' && result.title.length <= 256
    && typeof result.summary === 'string' && result.summary.length <= 512)
}

function isWebAccessActivityAction(value: JSONValue): boolean {
  if (!isPlainRecord(value) || typeof value.type !== 'string') return false
  return (value.type === 'toggle-activity' || value.type === 'review-search-results')
    && hasExactKeys(value, ['type'])
}

function isPiWebAccessPackageOwner(view: ResolvedSemanticView<unknown>): boolean {
  return WEB_ACCESS_EXTENSION_PATH !== undefined
    && isAbsolute(view.extensionPath)
    && resolve(view.extensionPath) === WEB_ACCESS_EXTENSION_PATH
    && view.sourceInfo.path === view.extensionPath
}

function isPackageExtensionPath(path: string): boolean {
  if (!isAbsolute(path) || path.startsWith('<') || path.startsWith('builtin:')) return false
  const extension = resolve(path)
  return extension.endsWith('.ts') || extension.endsWith('.js')
}

function isPiSubagentsPackageOwner(view: ResolvedSemanticView<unknown>): boolean {
  const source = view.sourceInfo.source
  const expectedSource = 'npm:@tintinweb/pi-subagents'
  return view.sourceInfo.origin === 'package'
    && (source === expectedSource || source.startsWith(`${expectedSource}@`))
    && view.sourceInfo.path === view.extensionPath
    && isPackageExtensionPath(view.extensionPath)
}

/** Known, owner-bound adapter for the native pi-subagents Settings controller. */
export function createSubagentsSettingsAdapter(
  owns: SemanticViewAdapter['owns'] = isPiSubagentsPackageOwner,
): SemanticViewAdapter {
  return {
    viewId: 'pi-subagents.settings',
    version: 1,
    actionIds: ['set', 'edit', 'cancel'],
    owns,
    validateState: isSubagentsSettingsState,
    authorizeAction: isSubagentsSettingsAction,
  }
}

/** Owner-bound policy for the native pi-subagents Agents menu controller. */
export function createSubagentsAgentsMenuAdapter(
  owns: SemanticViewAdapter['owns'] = isPiSubagentsPackageOwner,
): SemanticViewAdapter {
  return {
    viewId: 'pi-subagents.agents-menu',
    version: 1,
    actionIds: ['select', 'cancel'],
    owns,
    validateState: isAgentsMenuState,
    authorizeAction: isAgentsMenuAction,
  }
}

/** Owner-bound policy for the native pi-subagents Fleet widget controller. */
export function createSubagentsFleetAdapter(
  owns: SemanticViewAdapter['owns'] = isPiSubagentsPackageOwner,
): SemanticViewAdapter {
  return {
    viewId: 'pi-subagents.fleet',
    version: 1,
    actionIds: ['abort', 'steer', 'refresh'],
    owns,
    validateState: isFleetState,
    authorizeAction: isFleetAction,
  }
}

/** Owner-bound policy for the native pi-subagents Workflows controller. */
export function createSubagentsWorkflowsAdapter(
  owns: SemanticViewAdapter['owns'] = isPiSubagentsPackageOwner,
): SemanticViewAdapter {
  return {
    viewId: 'pi-subagents.workflows',
    version: 1,
    actionIds: ['open', 'run', 'edit', 'delete', 'cancel'],
    owns,
    validateState: isWorkflowsState,
    authorizeAction: isWorkflowsAction,
  }
}

/** Owner-bound policy for the native pi-subagents conversation controller. */
export function createSubagentsConversationAdapter(
  owns: SemanticViewAdapter['owns'] = isPiSubagentsPackageOwner,
): SemanticViewAdapter {
  return {
    viewId: 'pi-subagents.conversation',
    version: 1,
    actionIds: ['abort', 'steer', 'close'],
    owns,
    validateState: isConversationState,
    authorizeAction: isConversationAction,
  }
}

/** Owner-bound adapter for the app-local pi-web-access activity view. */
export function createWebAccessActivityAdapter(
  owns: SemanticViewAdapter['owns'] = isPiWebAccessPackageOwner,
): SemanticViewAdapter {
  return {
    viewId: 'pi-web-access.activity',
    version: 1,
    actionIds: ['toggle-activity', 'review-search-results'],
    owns,
    validateState: isWebAccessActivityState,
    authorizeAction: isWebAccessActivityAction,
  }
}

export function createDefaultSemanticViewAdapterRegistry(): SemanticViewAdapterRegistry {
  const registry = new SemanticViewAdapterRegistry()
  registry.register(createSubagentsSettingsAdapter())
  registry.register(createSubagentsAgentsMenuAdapter())
  registry.register(createSubagentsFleetAdapter())
  registry.register(createSubagentsWorkflowsAdapter())
  registry.register(createSubagentsConversationAdapter())
  registry.register(createWebAccessActivityAdapter())
  return registry
}
