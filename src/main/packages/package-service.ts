import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { DefaultPackageManager, type ProgressEvent, type SettingsManager } from '@earendil-works/pi-coding-agent'
import { formatPackageCommand } from '../../shared/packages.ts'
import type {
  PackageEventScope,
  PackageInstallRequest,
  PackageListResponse,
  PackageMutationResponse,
  PackageRemoveRequest,
  PackageScope,
  PackageUpdateRequest,
  PackagesEventPayload,
} from '../../shared/packages.ts'

export interface PackageServiceOptions {
  readonly cwd: string
  readonly agentDir: string
  readonly settingsManager: SettingsManager
  readonly isProjectTrusted: () => boolean
}

function trustIsLive(check: () => boolean): boolean {
  try {
    return check() === true
  } catch {
    return false
  }
}

function safeProgressMessage(value: string): string {
  return value
    .replace(/((?:authorization|access[-_]?token|refresh[-_]?token|client[-_]?secret|api[-_]?key|password|credential|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .slice(0, 8192)
}

export class PackageService {
  private readonly nativePackageManager: DefaultPackageManager
  private readonly settingsManager: SettingsManager
  private readonly isProjectTrusted: () => boolean
  private readonly cwd: string
  private readonly listeners = new Set<(event: PackagesEventPayload) => void>()
  private operationQueue: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(options: PackageServiceOptions) {
    this.settingsManager = options.settingsManager
    this.isProjectTrusted = options.isProjectTrusted
    this.cwd = resolve(options.cwd)
    this.nativePackageManager = new DefaultPackageManager({
      cwd: this.cwd,
      agentDir: options.agentDir,
      settingsManager: options.settingsManager,
    })
  }

  list(): PackageListResponse {
    this.assertActive()
    const projectTrusted = this.projectIsTrusted()
    return {
      packages: this.nativePackageManager.listConfiguredPackages()
        .filter((pkg) => pkg.scope !== 'project' || projectTrusted)
        .map((pkg) => ({
          source: pkg.source.slice(0, 2048),
          scope: pkg.scope,
          filtered: pkg.filtered,
          installed: pkg.installedPath !== undefined,
          ...(pkg.installedPath ? { installedPath: pkg.installedPath.slice(0, 4096) } : {}),
        })),
    }
  }

  install(request: PackageInstallRequest): Promise<PackageMutationResponse> {
    if (request.consent !== true) throw new Error('Explicit package-install consent is required.')
    const { source, scope } = request
    this.assertScopeTrusted(scope)
    const local = scope === 'project'
    const command = formatPackageCommand('install', source, scope, this.cwd)
    return this.runOperation('install', source, scope, command, async () => {
      await this.nativePackageManager.installAndPersist(source, { local })
      return true
    }, () => this.assertScopeTrusted(scope))
  }

  update(request: PackageUpdateRequest): Promise<PackageMutationResponse> {
    if (request.consent !== true) throw new Error('Explicit package-update consent is required.')
    const { source } = request
    const configured = this.nativePackageManager.listConfiguredPackages()
    const matches = configured.filter((pkg) => pkg.source === source)
    const command = formatPackageCommand('update', source, undefined, this.cwd)
    if (matches.length === 0) {
      return Promise.resolve({ outcome: 'not-found', action: 'update', target: source, scope: 'all', command })
    }
    const assertUpdateTrust = (): void => {
      const latest = this.nativePackageManager.listConfiguredPackages()
      const currentMatches = latest.filter((pkg) => pkg.source === source)
      if (currentMatches.length === 0) throw new Error('The configured package is no longer available.')
      if (currentMatches.some((pkg) => pkg.scope === 'project')) this.assertScopeTrusted('project')
      else if (!this.projectIsTrusted() && latest.some((pkg) => pkg.scope === 'project')) {
        throw new Error('Project package updates require workspace trust.')
      }
    }
    assertUpdateTrust()
    return this.runOperation('update', source, 'all', command, async () => {
      await this.nativePackageManager.update(source)
      return true
    }, assertUpdateTrust)
  }

  remove(request: PackageRemoveRequest): Promise<PackageMutationResponse> {
    if (request.consent !== true) throw new Error('Explicit package-removal consent is required.')
    const { source, scope } = request
    this.assertScopeTrusted(scope)
    const configured = this.nativePackageManager.listConfiguredPackages()
    if (!configured.some((pkg) => pkg.source === source && pkg.scope === scope)) {
      return Promise.resolve({
        outcome: 'not-found',
        action: 'remove',
        target: source,
        scope,
        command: formatPackageCommand('remove', source, scope, this.cwd),
      })
    }
    const local = scope === 'project'
    const command = formatPackageCommand('remove', source, scope, this.cwd)
    return this.runOperation(
      'remove', source, scope, command,
      () => this.nativePackageManager.removeAndPersist(source, { local }),
      () => this.assertScopeTrusted(scope),
    )
  }

  subscribe(listener: (event: PackagesEventPayload) => void): () => void {
    this.assertActive()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.nativePackageManager.setProgressCallback(undefined)
  }

  private runOperation(
    action: 'install' | 'update' | 'remove',
    target: string,
    scope: PackageEventScope,
    command: string,
    operation: () => Promise<boolean>,
    preflight: () => void = () => undefined,
  ): Promise<PackageMutationResponse> {
    this.assertActive()
    const run = async (): Promise<PackageMutationResponse> => {
      this.assertActive()
      preflight()
      const operationId = randomUUID()
      this.publish({ type: 'package-progress', operationId, action, target, scope, command, phase: 'started' })
      this.nativePackageManager.setProgressCallback((event) => this.publishNativeProgress(
        event,
        operationId,
        action,
        target,
        scope,
        command,
      ))
      try {
        const changed = await operation()
        const outcome = changed ? 'completed' : 'not-found'
        this.publish({
          type: 'package-progress', operationId, action, target, scope, command, phase: 'completed',
          message: outcome === 'completed' ? 'Pi package operation completed.' : 'Package was not configured at this scope.',
        })
        return { outcome, action, target, scope, command }
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Pi package operation failed.'
        this.publish({
          type: 'package-progress', operationId, action, target, scope, command, phase: 'failed',
          message: safeProgressMessage(detail),
        })
        throw new Error('Pi package operation failed.')
      } finally {
        this.nativePackageManager.setProgressCallback(undefined)
      }
    }
    const result = this.operationQueue.then(run)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private publishNativeProgress(
    event: ProgressEvent,
    operationId: string,
    action: 'install' | 'update' | 'remove',
    target: string,
    scope: PackageEventScope,
    command: string,
  ): void {
    const message = event.message
      ?? (event.type === 'complete' ? 'Native package-manager step completed.' : `Native package-manager step ${event.type}.`)
    this.publish({
      type: 'package-progress',
      operationId,
      action,
      target,
      scope,
      command,
      phase: 'progress',
      message: safeProgressMessage(message),
    })
  }

  private assertScopeTrusted(scope: PackageScope): void {
    if (scope === 'project' && !this.projectIsTrusted()) {
      throw new Error('Project package operations require workspace trust.')
    }
  }

  private projectIsTrusted(): boolean {
    return trustIsLive(this.isProjectTrusted) && this.settingsManager.isProjectTrusted()
  }

  private publish(event: PackagesEventPayload): void {
    if (this.disposed) return
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Event consumers must not interrupt a package operation.
      }
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('The package service has been disposed.')
  }
}
