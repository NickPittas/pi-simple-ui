import { basename, relative, resolve, sep } from 'node:path'
import type { ResourceLoader } from '@earendil-works/pi-coding-agent'
import type {
  ContextFileResourceView,
  ExtensionResourceView,
  PackagesEventPayload,
  PromptTemplateResourceView,
  ResourceListResponse,
  ResourceProvenanceView,
  ResourceReloadResponse,
  ResourceScope,
  ResourceSource,
  SkillResourceView,
  ThemeResourceView,
} from '../../shared/packages.ts'

export interface ResourceServiceOptions {
  readonly loader: ResourceLoader
  readonly cwd: string
  readonly agentDir: string
  readonly isProjectTrusted: () => boolean
  /** Must be the native session reload adapter, not ResourceLoader.reload(). */
  readonly reload: () => Promise<void>
  readonly canReload?: () => boolean
}

type LoaderSourceInfo = {
  readonly source?: string
  readonly scope?: string
  readonly origin?: string
}

function isWithin(parentPath: string, candidatePath: string): boolean {
  const path = relative(resolve(parentPath), resolve(candidatePath))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep))
}

function trustIsLive(check: () => boolean): boolean {
  try {
    return check() === true
  } catch {
    return false
  }
}

function sourceScope(info: LoaderSourceInfo | undefined): ResourceScope {
  if (info?.scope === 'user' || info?.scope === 'project' || info?.scope === 'temporary') return info.scope
  return 'unknown'
}

function resourceSource(path: string, info: LoaderSourceInfo | undefined): ResourceSource {
  if (path.startsWith('builtin:')) return 'builtin'
  if (info?.origin === 'package') return 'package'
  if (info?.scope === 'user' || info?.scope === 'project' || info?.scope === 'temporary') return info.scope
  return 'unknown'
}

function sourceDetail(info: LoaderSourceInfo | undefined): string | undefined {
  if (typeof info?.source !== 'string' || info.source.length === 0) return undefined
  return info.source
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .slice(0, 2048)
}

function provenance(path: string, info: LoaderSourceInfo | undefined): ResourceProvenanceView {
  const source = resourceSource(path, info)
  const detail = sourceDetail(info)
  return {
    path,
    source,
    scope: sourceScope(info),
    ...(detail ? { sourceDetail: detail } : {}),
  }
}

function hasTrustedProjectSource(scope: ResourceScope, projectTrusted: boolean): boolean {
  return scope !== 'project' || projectTrusted
}

export class ResourceService {
  readonly cwd: string
  readonly agentDir: string
  private readonly loader: ResourceLoader
  private readonly reloadNativeSession: () => Promise<void>
  private readonly isProjectTrusted: () => boolean
  private readonly canReload: () => boolean
  private readonly listeners = new Set<(event: PackagesEventPayload) => void>()
  private reloadQueue: Promise<void> = Promise.resolve()
  private generationValue = 0
  private pendingReloads = 0
  private disposed = false

  constructor(options: ResourceServiceOptions) {
    this.loader = options.loader
    this.cwd = resolve(options.cwd)
    this.agentDir = resolve(options.agentDir)
    this.isProjectTrusted = options.isProjectTrusted
    this.reloadNativeSession = options.reload
    this.canReload = options.canReload ?? (() => true)
  }

  get generation(): number {
    return this.generationValue
  }

  list(): ResourceListResponse {
    this.assertActive()
    const trusted = trustIsLive(this.isProjectTrusted)
    const extensions: ExtensionResourceView[] = this.loader.getExtensions().extensions.flatMap((extension) => {
      const view = provenance(extension.path, extension.sourceInfo)
      return hasTrustedProjectSource(view.scope, trusted) ? [{ ...view, enabled: true }] : []
    })
    const skills: SkillResourceView[] = this.loader.getSkills().skills.flatMap((skill) => {
      const view = provenance(skill.filePath, skill.sourceInfo)
      return hasTrustedProjectSource(view.scope, trusted)
        ? [{ ...view, name: skill.name.slice(0, 1024), description: skill.description.slice(0, 8192) }]
        : []
    })
    const promptTemplates: PromptTemplateResourceView[] = this.loader.getPrompts().prompts.flatMap((prompt) => {
      const view = provenance(prompt.filePath, prompt.sourceInfo)
      return hasTrustedProjectSource(view.scope, trusted)
        ? [{ ...view, name: prompt.name.slice(0, 1024), description: prompt.description.slice(0, 8192) }]
        : []
    })
    const themes: ThemeResourceView[] = this.loader.getThemes().themes.flatMap((theme) => {
      const path = theme.sourcePath ?? theme.sourceInfo?.path ?? theme.name ?? 'unknown-theme'
      const view = provenance(path, theme.sourceInfo)
      return hasTrustedProjectSource(view.scope, trusted)
        ? [{ ...view, name: (theme.name ?? basename(path)).slice(0, 1024) }]
        : []
    })
    const contextFiles: ContextFileResourceView[] = this.loader.getAgentsFiles().agentsFiles.flatMap((file) => {
      // The loader does not expose SourceInfo for context files. Treat paths outside the native
      // agent directory as project-scoped, so they are not disclosed before trust is granted.
      const scope = isWithin(this.agentDir, file.path) ? 'user' as const : 'project' as const
      if (!hasTrustedProjectSource(scope, trusted)) return []
      return [{
        path: file.path,
        source: scope,
        scope,
        name: basename(file.path).slice(0, 1024),
      }]
    })

    return {
      generation: this.generationValue,
      loading: this.pendingReloads > 0,
      extensions,
      skills,
      promptTemplates,
      themes,
      contextFiles,
    }
  }

  async reload(): Promise<ResourceReloadResponse> {
    this.assertActive()
    let mayReload = false
    try {
      mayReload = this.canReload() === true
    } catch {
      mayReload = false
    }
    if (!mayReload) return { outcome: 'busy', generation: this.generationValue }

    const generation = ++this.generationValue
    this.pendingReloads += 1
    this.publish({ type: 'resources-reload', generation, phase: 'started' })
    const operation = this.reloadQueue.then(async (): Promise<ResourceReloadResponse> => {
      if (generation !== this.generationValue) return { outcome: 'superseded', generation }
      try {
        await this.reloadNativeSession()
        if (generation !== this.generationValue) return { outcome: 'superseded', generation }
        this.publish({ type: 'resources-reload', generation, phase: 'completed' })
        return { outcome: 'reloaded', generation }
      } catch {
        if (generation === this.generationValue) {
          this.publish({ type: 'resources-reload', generation, phase: 'failed', message: 'Native resource reload failed.' })
        }
        return { outcome: 'failed', generation }
      }
    })
    this.reloadQueue = operation.then(() => undefined, () => undefined)
    try {
      return await operation
    } finally {
      this.pendingReloads = Math.max(0, this.pendingReloads - 1)
    }
  }

  subscribe(listener: (event: PackagesEventPayload) => void): () => void {
    this.assertActive()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  private publish(event: PackagesEventPayload): void {
    if (this.disposed) return
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // An event consumer must not break a native reload.
      }
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('The resource service has been disposed.')
  }
}
