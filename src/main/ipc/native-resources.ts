import type { CapabilityDefinition } from './register.ts'
import type { NativeSkillPromptService } from '../packages/native-skill-prompt-service.ts'
import {
  isResourceListRequest,
  isResourceListResponse,
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
  isTemplateEnableRequest,
  isTemplateEnableResponse,
  isTemplateMutationResponse,
  isTemplateReadRequest,
  isTemplateUpdateRequest,
  PACKAGES_IPC,
} from '../../shared/packages.ts'

/**
 * Skills and prompt-template capabilities for the native composition. Deliberately NOT registered here:
 * package install/update/remove, resources.reload (Pi has no RPC reload; mutations report restartRequired) and packages.events.
 */
export function registerNativeResourceCapabilities(service: NativeSkillPromptService): CapabilityDefinition<any, any>[] {
  return [
    { id: PACKAGES_IPC.resourcesList, scope: 'runtime', validateRequest: isResourceListRequest, validateResponse: isResourceListResponse, handle: () => service.list() },
    { id: PACKAGES_IPC.skillsRead, scope: 'runtime', validateRequest: isSkillReadRequest, validateResponse: isSkillDocumentView, handle: (_context, request) => service.readSkill(request) },
    { id: PACKAGES_IPC.skillsCreate, scope: 'runtime', validateRequest: isSkillCreateRequest, validateResponse: isSkillMutationResponse, handle: (_context, request) => service.createSkill(request) },
    { id: PACKAGES_IPC.skillsUpdate, scope: 'runtime', validateRequest: isSkillUpdateRequest, validateResponse: isSkillMutationResponse, handle: (_context, request) => service.updateSkill(request) },
    { id: PACKAGES_IPC.skillsDelete, scope: 'runtime', validateRequest: isSkillDeleteRequest, validateResponse: isSkillMutationResponse, handle: (_context, request) => service.deleteSkill(request) },
    { id: PACKAGES_IPC.skillsEnable, scope: 'runtime', validateRequest: isSkillEnableRequest, validateResponse: isSkillEnableResponse, handle: (_context, request) => service.setSkillEnabled(request) },
    { id: PACKAGES_IPC.templatesRead, scope: 'runtime', validateRequest: isTemplateReadRequest, validateResponse: isTemplateDocumentView, handle: (_context, request) => service.readTemplate(request) },
    { id: PACKAGES_IPC.templatesCreate, scope: 'runtime', validateRequest: isTemplateCreateRequest, validateResponse: isTemplateMutationResponse, handle: (_context, request) => service.createTemplate(request) },
    { id: PACKAGES_IPC.templatesUpdate, scope: 'runtime', validateRequest: isTemplateUpdateRequest, validateResponse: isTemplateMutationResponse, handle: (_context, request) => service.updateTemplate(request) },
    { id: PACKAGES_IPC.templatesDelete, scope: 'runtime', validateRequest: isTemplateDeleteRequest, validateResponse: isTemplateMutationResponse, handle: (_context, request) => service.deleteTemplate(request) },
    { id: PACKAGES_IPC.templatesEnable, scope: 'runtime', validateRequest: isTemplateEnableRequest, validateResponse: isTemplateEnableResponse, handle: (_context, request) => service.setTemplateEnabled(request) },
  ]
}
