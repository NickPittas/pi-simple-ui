import type { EventDefinition, CapabilityDefinition, AuthorizedIpcCaller } from './register.ts'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { ChatInputService } from '../pi/input-service.ts'
import {
  registerIntercomHostActions,
  type IntercomRequiresRuntimeBridgeAccessor,
} from '../extensions/host-actions/intercom.ts'
import {
  registerPreviewHostActions,
  type PreviewPdfRequiresRuntimeBridgeAccessor,
  type PreviewShellOpenService,
} from '../extensions/host-actions/preview.ts'
import {
  registerPowerlineHostActions,
  type PowerlineRequiresRuntimeBridgeAccessor,
} from '../extensions/host-actions/powerline.ts'
import {
  registerTasksHostActions,
  type TasksRequiresRuntimeBridgeAccessor,
} from '../extensions/host-actions/tasks.ts'
import {
  registerFffHostActions,
  type FffRequiresRuntimeBridgeAccessor,
} from '../extensions/host-actions/fff.ts'
import {
  registerQuotaHostActions,
  type QuotaRequiresRuntimeBridgeAccessor,
} from '../extensions/host-actions/quota.ts'
import {
  registerWebAccessHostActions,
  type WebAccessRequiresRuntimeBridgeAccessor,
} from '../extensions/host-actions/web-access.ts'
import {
  registerMultiAccountHostActions,
  type MultiAccountRequiresRuntimeBridgeAccessor,
} from '../extensions/host-actions/multi-account.ts'

export interface HostActionRegistrationOptions {
  readonly chatInput: ChatInputService
  readonly intercom: IntercomRequiresRuntimeBridgeAccessor
  readonly powerline: PowerlineRequiresRuntimeBridgeAccessor
  readonly tasks: TasksRequiresRuntimeBridgeAccessor
  readonly fff: FffRequiresRuntimeBridgeAccessor
  readonly quota: QuotaRequiresRuntimeBridgeAccessor
  readonly webAccess: WebAccessRequiresRuntimeBridgeAccessor
  readonly multiAccount: MultiAccountRequiresRuntimeBridgeAccessor
  readonly agentDir?: string
  readonly shellOpen?: PreviewShellOpenService
  readonly nativePreviewPdf?: PreviewPdfRequiresRuntimeBridgeAccessor
  /** Must check the active runtime generation and bind access to this authorized caller. */
  readonly authorizeRuntimeCaller: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => boolean
}

export interface HostActionRegistrations {
  readonly capabilities: readonly CapabilityDefinition<any, any>[]
  readonly events: readonly EventDefinition<any>[]
}

/** Compose family registrations for the application's single registerIpcCapabilities call. */
export function registerHostActionCapabilities(options: HostActionRegistrationOptions): HostActionRegistrations {
  const intercom = registerIntercomHostActions(options.intercom)
  const preview = registerPreviewHostActions({
    authorizeRuntimeCaller: options.authorizeRuntimeCaller,
    ...(options.shellOpen ? { shellOpen: options.shellOpen } : {}),
    ...(options.nativePreviewPdf ? { nativePdf: options.nativePreviewPdf } : {}),
  })
  const powerline = registerPowerlineHostActions({
    chatInput: options.chatInput,
    bridge: options.powerline,
    authorizeRuntimeCaller: options.authorizeRuntimeCaller,
  })
  const tasks = registerTasksHostActions({
    bridge: options.tasks,
    authorizeRuntimeCaller: options.authorizeRuntimeCaller,
  })
  const fff = registerFffHostActions({
    bridge: options.fff,
    authorizeRuntimeCaller: options.authorizeRuntimeCaller,
  })
  const quota = registerQuotaHostActions({
    bridge: options.quota,
    authorizeRuntimeCaller: options.authorizeRuntimeCaller,
  })
  const webAccess = registerWebAccessHostActions({
    bridge: options.webAccess,
    authorizeRuntimeCaller: options.authorizeRuntimeCaller,
  })
  const multiAccount = registerMultiAccountHostActions({
    bridge: options.multiAccount,
    authorizeRuntimeCaller: options.authorizeRuntimeCaller,
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
  })

  return {
    capabilities: [
      ...intercom.capabilities,
      ...preview,
      ...powerline,
      ...tasks,
      ...fff,
      ...quota,
      ...webAccess,
      ...multiAccount,
    ],
    events: [...intercom.events],
  }
}
