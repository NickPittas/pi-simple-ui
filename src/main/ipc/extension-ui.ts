import type { CapabilityDefinition, EventDefinition } from './register.ts'
import type {
  ExtensionUIBridge,
} from '../extensions/extension-ui-bridge.ts'
import {
  EXTENSION_UI_IPC,
  type ExtensionUIEvent,
  type SemanticViewActionAck,
  type SemanticViewActionRequest,
  type NativeCustomUIActionAck,
  type NativeCustomUIActionRequest,
  type ExtensionUIReplyAck,
  type ExtensionUIReplyRequest,
  type ExtensionUIStateUpdateAck,
  type ExtensionUIStateUpdateRequest,
} from '../../shared/extension-ui.ts'

type ReplyCapability = CapabilityDefinition<ExtensionUIReplyRequest, ExtensionUIReplyAck>
type ActionCapability = CapabilityDefinition<SemanticViewActionRequest, SemanticViewActionAck>
type CustomActionCapability = CapabilityDefinition<NativeCustomUIActionRequest, NativeCustomUIActionAck>
type StateCapability = CapabilityDefinition<ExtensionUIStateUpdateRequest, ExtensionUIStateUpdateAck>
type UIEventDefinition = EventDefinition<ExtensionUIEvent>

export interface ExtensionUIBridgeRouter {
  readonly capabilities: readonly [ReplyCapability, ActionCapability, CustomActionCapability, StateCapability]
  readonly events: readonly UIEventDefinition[]
  setActive(bridge: ExtensionUIBridge | undefined): void
}

/** Stable descriptors route into the selected workspace bridge without adding handlers per switch. */
export function createExtensionUIBridgeRouter(): ExtensionUIBridgeRouter {
  let activeBridge: ExtensionUIBridge | undefined
  const subscriptions = new Set<() => void>()

  const activeReply = (): ReplyCapability | undefined => {
    const capability = activeBridge?.capabilities.find((candidate) => candidate.id === EXTENSION_UI_IPC.reply)
    return capability?.id === EXTENSION_UI_IPC.reply ? capability as ReplyCapability : undefined
  }
  const activeAction = (): ActionCapability | undefined => {
    const capability = activeBridge?.capabilities.find((candidate) => candidate.id === EXTENSION_UI_IPC.action)
    return capability?.id === EXTENSION_UI_IPC.action ? capability as ActionCapability : undefined
  }
  const activeCustomAction = (): CustomActionCapability | undefined => {
    const capability = activeBridge?.capabilities.find((candidate) => candidate.id === EXTENSION_UI_IPC.customAction)
    return capability?.id === EXTENSION_UI_IPC.customAction ? capability as CustomActionCapability : undefined
  }
  const activeState = (): StateCapability | undefined => {
    const capability = activeBridge?.capabilities.find((candidate) => candidate.id === EXTENSION_UI_IPC.state)
    return capability?.id === EXTENSION_UI_IPC.state ? capability as StateCapability : undefined
  }
  const activeEvent = (): UIEventDefinition | undefined => activeBridge?.events.find(
    (event) => event.id === EXTENSION_UI_IPC.event,
  )

  const reply: ReplyCapability = {
    id: EXTENSION_UI_IPC.reply,
    scope: 'runtime',
    validateRequest: (value): value is ExtensionUIReplyRequest => activeReply()?.validateRequest(value) ?? false,
    validateResponse: (value): value is ExtensionUIReplyAck => activeReply()?.validateResponse(value) ?? false,
    authorize: (caller, request) => activeReply()?.authorize?.(caller, request) === true,
    handle: (context, request) => {
      const capability = activeReply()
      if (!capability) throw new Error('No extension UI bridge is active.')
      return capability.handle(context, request)
    },
  }

  const action: ActionCapability = {
    id: EXTENSION_UI_IPC.action,
    scope: 'runtime',
    validateRequest: (value): value is SemanticViewActionRequest => activeAction()?.validateRequest(value) ?? false,
    validateResponse: (value): value is SemanticViewActionAck => activeAction()?.validateResponse(value) ?? false,
    authorize: (caller, request) => activeAction()?.authorize?.(caller, request) === true,
    handle: (context, request) => {
      const capability = activeAction()
      if (!capability) throw new Error('No extension UI bridge is active.')
      return capability.handle(context, request)
    },
  }

  const state: StateCapability = {
    id: EXTENSION_UI_IPC.state,
    scope: 'runtime',
    validateRequest: (value): value is ExtensionUIStateUpdateRequest => activeState()?.validateRequest(value) ?? false,
    validateResponse: (value): value is ExtensionUIStateUpdateAck => activeState()?.validateResponse(value) ?? false,
    authorize: (caller, request) => activeState()?.authorize?.(caller, request) === true,
    handle: (context, request) => {
      const capability = activeState()
      if (!capability) throw new Error('No extension UI bridge is active.')
      return capability.handle(context, request)
    },
  }

  const customAction: CustomActionCapability = {
    id: EXTENSION_UI_IPC.customAction,
    scope: 'runtime',
    validateRequest: (value): value is NativeCustomUIActionRequest => activeCustomAction()?.validateRequest(value) ?? false,
    validateResponse: (value): value is NativeCustomUIActionAck => activeCustomAction()?.validateResponse(value) ?? false,
    authorize: (caller, request) => activeCustomAction()?.authorize?.(caller, request) === true,
    handle: (context, request) => {
      const capability = activeCustomAction()
      if (!capability) throw new Error('No extension UI bridge is active.')
      return capability.handle(context, request)
    },
  }

  const event: UIEventDefinition = {
    id: EXTENSION_UI_IPC.event,
    scope: 'runtime',
    validatePayload: (value): value is ExtensionUIEvent => activeEvent()?.validatePayload(value) ?? false,
    subscribe: (context, publish) => {
      const definition = activeEvent()
      if (!definition) throw new Error('No extension UI bridge is active.')
      const stopInner = definition.subscribe(context, publish)
      let stopped = false
      const stop = (): void => {
        if (stopped) return
        stopped = true
        subscriptions.delete(stop)
        stopInner?.()
      }
      subscriptions.add(stop)
      return stop
    },
  }

  return {
    capabilities: [reply, action, customAction, state],
    events: [event],
    setActive(bridge) {
      if (activeBridge === bridge) return
      for (const stop of [...subscriptions]) stop()
      activeBridge = bridge
    },
  }
}
