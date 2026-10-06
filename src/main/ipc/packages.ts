import type { AuthorizedIpcCaller, CapabilityContext, CapabilityDefinition, EventDefinition } from './register.ts'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import {
  isPackageInstallRequest,
  isPackageListRequest,
  isPackageListResponse,
  isPackageMutationResponse,
  isPackageRemoveRequest,
  isPackageUpdateRequest,
  isPackagesEventPayload,
  isResourceListRequest,
  isResourceListResponse,
  isResourceReloadRequest,
  isResourceReloadResponse,
  isSkillCreateRequest,
  isSkillDeleteRequest,
  isSkillDocumentView,
  isSkillEnableRequest,
  isSkillEnableResponse,
  isSkillMutationResponse,
  isSkillReadRequest,
  isSkillUpdateRequest,
  isTemplateCreateRequest,
  isTemplateDeleteRequest,
  isTemplateDocumentView,
  isTemplateMutationResponse,
  isTemplateReadRequest,
  isTemplateUpdateRequest,
  PACKAGES_IPC,
  type PackagesCapabilities,
  type PackagesEventPayload,
  type PackageInstallRequest,
  type PackageRemoveRequest,
  type PackageUpdateRequest,
  type SkillCreateRequest,
  type SkillDeleteRequest,
  type SkillEnableRequest,
  type SkillReadRequest,
  type SkillUpdateRequest,
  type TemplateCreateRequest,
  type TemplateDeleteRequest,
  type TemplateReadRequest,
  type TemplateUpdateRequest,
} from '../../shared/packages.ts'
import type { PackageService } from '../packages/package-service.ts'
import type { ResourceService } from '../packages/resource-service.ts'
import type { SkillService } from '../packages/skill-service.ts'

export type PackagesCapabilityDefinition = {
  [K in keyof PackagesCapabilities]: CapabilityDefinition<
    PackagesCapabilities[K]['request'],
    PackagesCapabilities[K]['response']
  >
}[keyof PackagesCapabilities]

export interface PackagesIpcRuntimeBinding {
  readonly packages: PackageService
  readonly resources: ResourceService
  readonly skills: SkillService
}

/** Resolve only the runtime currently owned by this authenticated caller and scope. */
export type PackagesRuntimeResolver = (
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope,
) => PackagesIpcRuntimeBinding | undefined

function binding(
  context: CapabilityContext,
  resolveRuntime: PackagesRuntimeResolver,
): PackagesIpcRuntimeBinding {
  if (!context.scope) throw new Error('A current runtime scope is required.')
  const runtime = resolveRuntime(context.caller, context.scope)
  if (!runtime) throw new Error('The requested package runtime is stale.')
  return runtime
}

export function createPackagesIpcDefinitions(resolveRuntime: PackagesRuntimeResolver): {
  readonly capabilities: readonly PackagesCapabilityDefinition[]
  readonly events: readonly EventDefinition<PackagesEventPayload>[]
} {
  const capabilities: readonly PackagesCapabilityDefinition[] = [
    {
      id: PACKAGES_IPC.list,
      scope: 'runtime',
      validateRequest: isPackageListRequest,
      validateResponse: isPackageListResponse,
      handle: (context: CapabilityContext) => binding(context, resolveRuntime).packages.list(),
    },
    {
      id: PACKAGES_IPC.install,
      scope: 'runtime',
      validateRequest: isPackageInstallRequest,
      validateResponse: isPackageMutationResponse,
      handle: (context: CapabilityContext, request: PackageInstallRequest) => binding(context, resolveRuntime).packages.install(request),
    },
    {
      id: PACKAGES_IPC.update,
      scope: 'runtime',
      validateRequest: isPackageUpdateRequest,
      validateResponse: isPackageMutationResponse,
      handle: (context: CapabilityContext, request: PackageUpdateRequest) => binding(context, resolveRuntime).packages.update(request),
    },
    {
      id: PACKAGES_IPC.remove,
      scope: 'runtime',
      validateRequest: isPackageRemoveRequest,
      validateResponse: isPackageMutationResponse,
      handle: (context: CapabilityContext, request: PackageRemoveRequest) => binding(context, resolveRuntime).packages.remove(request),
    },
    {
      id: PACKAGES_IPC.resourcesList,
      scope: 'runtime',
      validateRequest: isResourceListRequest,
      validateResponse: isResourceListResponse,
      handle: (context: CapabilityContext) => binding(context, resolveRuntime).resources.list(),
    },
    {
      id: PACKAGES_IPC.resourcesReload,
      scope: 'runtime',
      validateRequest: isResourceReloadRequest,
      validateResponse: isResourceReloadResponse,
      handle: (context: CapabilityContext) => binding(context, resolveRuntime).resources.reload(),
    },
    {
      id: PACKAGES_IPC.skillsRead,
      scope: 'runtime',
      validateRequest: isSkillReadRequest,
      validateResponse: isSkillDocumentView,
      handle: (context: CapabilityContext, request: SkillReadRequest) => binding(context, resolveRuntime).skills.readSkill(request),
    },
    {
      id: PACKAGES_IPC.skillsCreate,
      scope: 'runtime',
      validateRequest: isSkillCreateRequest,
      validateResponse: isSkillMutationResponse,
      handle: (context: CapabilityContext, request: SkillCreateRequest) => binding(context, resolveRuntime).skills.createSkill(request),
    },
    {
      id: PACKAGES_IPC.skillsUpdate,
      scope: 'runtime',
      validateRequest: isSkillUpdateRequest,
      validateResponse: isSkillMutationResponse,
      handle: (context: CapabilityContext, request: SkillUpdateRequest) => binding(context, resolveRuntime).skills.updateSkill(request),
    },
    {
      id: PACKAGES_IPC.skillsDelete,
      scope: 'runtime',
      validateRequest: isSkillDeleteRequest,
      validateResponse: isSkillMutationResponse,
      handle: (context: CapabilityContext, request: SkillDeleteRequest) => binding(context, resolveRuntime).skills.deleteSkill(request),
    },
    {
      id: PACKAGES_IPC.skillsEnable,
      scope: 'runtime',
      validateRequest: isSkillEnableRequest,
      validateResponse: isSkillEnableResponse,
      handle: (context: CapabilityContext, request: SkillEnableRequest) => binding(context, resolveRuntime).skills.setSkillEnabled(request),
    },
    {
      id: PACKAGES_IPC.templatesRead,
      scope: 'runtime',
      validateRequest: isTemplateReadRequest,
      validateResponse: isTemplateDocumentView,
      handle: (context: CapabilityContext, request: TemplateReadRequest) => binding(context, resolveRuntime).skills.readTemplate(request),
    },
    {
      id: PACKAGES_IPC.templatesCreate,
      scope: 'runtime',
      validateRequest: isTemplateCreateRequest,
      validateResponse: isTemplateMutationResponse,
      handle: (context: CapabilityContext, request: TemplateCreateRequest) => binding(context, resolveRuntime).skills.createTemplate(request),
    },
    {
      id: PACKAGES_IPC.templatesUpdate,
      scope: 'runtime',
      validateRequest: isTemplateUpdateRequest,
      validateResponse: isTemplateMutationResponse,
      handle: (context: CapabilityContext, request: TemplateUpdateRequest) => binding(context, resolveRuntime).skills.updateTemplate(request),
    },
    {
      id: PACKAGES_IPC.templatesDelete,
      scope: 'runtime',
      validateRequest: isTemplateDeleteRequest,
      validateResponse: isTemplateMutationResponse,
      handle: (context: CapabilityContext, request: TemplateDeleteRequest) => binding(context, resolveRuntime).skills.deleteTemplate(request),
    },
  ]

  const events: readonly EventDefinition<PackagesEventPayload>[] = [{
    id: PACKAGES_IPC.events,
    scope: 'runtime',
    validatePayload: isPackagesEventPayload,
    subscribe: (context, publish) => {
      const runtime = binding(context, resolveRuntime)
      const stopPackages = runtime.packages.subscribe(publish)
      const stopResources = runtime.resources.subscribe(publish)
      return () => {
        stopPackages()
        stopResources()
      }
    },
  }]

  return { capabilities, events }
}
