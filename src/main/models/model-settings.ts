import { createHash } from 'node:crypto'
import type {
  AgentSession,
  ModelRuntime,
  ScopedModel,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { resolveModelScopeWithDiagnostics } from '@earendil-works/pi-coding-agent'
import type {
  EnabledModelGroup,
  EnabledModelsMutationResult,
  EnabledModelsState,
  ModelReference,
  ModelThinkingLevel,
  ScopedModelsState,
} from '../../shared/models.ts'

export type SettingsManagerAccessor = () => SettingsManager | undefined
export type SettingsSessionAccessor = () => AgentSession | undefined

interface EnabledSettingsValues {
  readonly effective: readonly string[] | undefined
  readonly global: readonly string[] | undefined
  readonly project: readonly string[] | undefined
}

const settingsWriteLocks = new WeakMap<SettingsManager, Promise<void>>()

function copyPatterns(patterns: readonly string[] | undefined): readonly string[] | undefined {
  return patterns === undefined ? undefined : [...patterns]
}

function readValues(manager: SettingsManager): EnabledSettingsValues {
  return {
    effective: copyPatterns(manager.getEnabledModels()),
    global: copyPatterns(manager.getGlobalSettings().enabledModels),
    project: copyPatterns(manager.getProjectSettings().enabledModels),
  }
}

function revision(values: EnabledSettingsValues): number {
  const content = JSON.stringify({
    effective: values.effective === undefined ? { present: false } : { present: true, value: values.effective },
    global: values.global === undefined ? { present: false } : { present: true, value: values.global },
    project: values.project === undefined ? { present: false } : { present: true, value: values.project },
  })
  return Number.parseInt(createHash('sha256').update(content).digest('hex').slice(0, 12), 16)
}

function samePatterns(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.length === right.length && left.every((value, index) => value === right[index])
}

function modelReferences(models: readonly ScopedModel[]): readonly ModelReference[] {
  return models.map((scoped) => ({
    provider: scoped.model.provider,
    id: scoped.model.id,
    ...(scoped.thinkingLevel ? { thinkingLevel: scoped.thinkingLevel as ModelThinkingLevel } : {}),
  }))
}

function groupsFor(references: readonly ModelReference[]): readonly EnabledModelGroup[] {
  const groups = new Map<string, string[]>()
  for (const model of references) {
    const ids = groups.get(model.provider) ?? []
    ids.push(model.id)
    groups.set(model.provider, ids)
  }
  return [...groups].map(([provider, ids]) => ({ provider, ids }))
}

async function withSettingsLock<T>(manager: SettingsManager, operation: () => Promise<T>): Promise<T> {
  const previous = settingsWriteLocks.get(manager) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => { release = resolve })
  settingsWriteLocks.set(manager, next)
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
    if (settingsWriteLocks.get(manager) === next) settingsWriteLocks.delete(manager)
  }
}

/** Native enabledModels persistence and distinct in-memory AgentSession scope. */
export class ModelSettingsService {
  private readonly getSettingsManager: SettingsManagerAccessor
  private readonly getSession: SettingsSessionAccessor

  constructor(getSettingsManager: SettingsManagerAccessor, getSession: SettingsSessionAccessor) {
    this.getSettingsManager = getSettingsManager
    this.getSession = getSession
  }

  async readEnabled(): Promise<EnabledModelsState> {
    const manager = this.requireSettingsManager()
    const values = readValues(manager)
    return this.enabledSnapshot(values)
  }

  /** Read/discard is deliberately write-free; renderer drafts remain renderer-local. */
  discardEnabledDraft(): Promise<EnabledModelsState> {
    return this.readEnabled()
  }

  async updateEnabled(expectedRevision: number, update: {
    readonly action: 'set'
    readonly patterns: readonly string[]
  } | { readonly action: 'enable-all' } | { readonly action: 'clear' }): Promise<EnabledModelsMutationResult> {
    const manager = this.requireSettingsManager()
    return withSettingsLock(manager, async () => {
      await manager.flush()
      await manager.reload()
      const before = readValues(manager)
      if (revision(before) !== expectedRevision) {
        return { outcome: 'conflict', state: await this.enabledSnapshot(before) }
      }

      let next: readonly string[] | undefined
      if (update.action === 'set') {
        next = [...update.patterns]
      } else if (update.action === 'enable-all') {
        const runtime = this.requireSession().modelRuntime
        next = runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`)
      }

      manager.setEnabledModels(next === undefined ? undefined : [...next])
      await manager.flush()
      await manager.reload()
      const after = readValues(manager)
      if (!samePatterns(after.global, next)) {
        throw new Error('The native SettingsManager did not persist enabledModels.')
      }
      return { outcome: 'saved', state: await this.enabledSnapshot(after) }
    })
  }

  readScoped(): ScopedModelsState {
    const session = this.requireSession()
    return { orderedIds: modelReferences(session.scopedModels) }
  }

  updateScoped(orderedIds: readonly ModelReference[]): ScopedModelsState {
    const session = this.requireSession()
    const runtime = session.modelRuntime
    const available = new Set(runtime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`))
    const seen = new Set<string>()
    const scopedModels: ScopedModel[] = orderedIds.map((reference) => {
      const key = `${reference.provider}\0${reference.id}`
      if (seen.has(key)) throw new TypeError('Scoped model references must be unique.')
      seen.add(key)
      const model = runtime.getModel(reference.provider, reference.id)
      if (!model || !available.has(key)) throw new TypeError('A scoped model is not currently available in the native model runtime.')
      return {
        model,
        ...(reference.thinkingLevel ? { thinkingLevel: reference.thinkingLevel } : {}),
      }
    })
    session.setScopedModels(scopedModels)
    return this.readScoped()
  }

  /** Rebuild session-only cycle scope using Pi's exported native model-pattern resolver. */
  async restoreScopedModels(session = this.requireSession()): Promise<ScopedModelsState> {
    const patterns = this.requireSettingsManager().getEnabledModels()
    if (!patterns?.length) {
      session.setScopedModels([])
      return { orderedIds: [] }
    }
    const { scopedModels } = await resolveModelScopeWithDiagnostics([...patterns], session.modelRuntime)
    session.setScopedModels(scopedModels)
    return { orderedIds: modelReferences(session.scopedModels) }
  }

  private async enabledSnapshot(values: EnabledSettingsValues): Promise<EnabledModelsState> {
    const runtime = this.getSession()?.modelRuntime
    let orderedIds: readonly ModelReference[] = []
    let diagnostics: readonly string[] = []
    if (runtime && values.effective?.length) {
      const resolved = await resolveModelScopeWithDiagnostics([...values.effective], runtime)
      orderedIds = modelReferences(resolved.scopedModels)
      diagnostics = resolved.diagnostics.map((entry) => entry.message)
    }
    return {
      revision: revision(values),
      patterns: values.effective === undefined ? null : [...values.effective],
      globalPatterns: values.global === undefined ? null : [...values.global],
      projectPatterns: values.project === undefined ? null : [...values.project],
      orderedIds,
      orderedIdsByProvider: groupsFor(orderedIds),
      diagnostics,
    }
  }

  private requireSettingsManager(): SettingsManager {
    const manager = this.getSettingsManager()
    if (!manager) throw new Error('The native SettingsManager is unavailable.')
    return manager
  }

  private requireSession(): AgentSession {
    const session = this.getSession()
    if (!session) throw new Error('No active agent session is available for model settings.')
    return session
  }
}
