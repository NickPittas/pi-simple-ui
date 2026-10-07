import { SessionManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { NativeModelChoice, NativeModelState, NativeModelStateResult, NativePiAck, NativePiEnvelope, NativeSessionsResult, SetModelRequest, SetThinkingRequest } from '../../src/shared/native-pi.ts'

type Identity = { sessionId: string; sessionGeneration: number }
export function bindNativeControls(pi: ExtensionAPI, context: () => ExtensionContext, processGeneration: number, nextSequence: () => number, identity: () => Identity, publish: (event: NativePiEnvelope) => void, piUsable: () => boolean) {
  let queue = Promise.resolve(), disposed = false
  const state = async (): Promise<NativeModelStateResult> => {
    try {
      const ctx = context(), model = ctx.model, registry = ctx.modelRegistry
      if (typeof ctx.isIdle !== 'function' || typeof ctx.hasPendingMessages !== 'function') throw new Error('native busy state unavailable')
      if (!registry || typeof registry.getAvailable !== 'function') throw new Error('model catalogue unavailable')
      const scoped = Array.isArray(ctx.scopedModels) ? ctx.scopedModels : []
      const all = registry.getAvailable()
      const available = scoped.length ? scoped.map(item => item.model) : all
      const toChoice = (item: { provider: string; id: string; name?: string }): NativeModelChoice => ({ provider: item.provider, id: item.id, name: item.name ?? item.id })
      const models: NativeModelChoice[] = available.map(toChoice), allModels: NativeModelChoice[] = all.map(toChoice)
      const target = identity(), level = ctx.thinkingLevel
      if (model && typeof getSupportedThinkingLevels !== 'function') throw new Error('thinking-level catalogue unavailable')
      const thinkingLevels = model ? getSupportedThinkingLevels(model) : []
      return { state: { ...target, processGeneration, sequence: nextSequence(), model: model ? { provider: model.provider, id: model.id, name: model.name ?? model.id } : null, models, allModels, scoped: scoped.length > 0, thinkingLevel: level, thinkingLevels, busy: !ctx.isIdle() || ctx.hasPendingMessages() }, error: null }
    } catch (error) { return { state: null, error: error instanceof Error ? error.message : String(error) } }
  }
  const publishState = async () => {
    const result = await state(), value = result.state
    if (!disposed && value) publish({ version: 1, processGeneration, sequence: value.sequence, sessionId: value.sessionId, sessionGeneration: value.sessionGeneration, kind: 'status', payload: { type: 'model-state', state: value } })
  }
  const current = (req: { sessionId: string; sessionGeneration: number }) => {
    const target = identity()
    return target.sessionId === req.sessionId && target.sessionGeneration === req.sessionGeneration
  }
  const mutate = (req: SetModelRequest | SetThinkingRequest, action: () => Promise<NativePiAck> | NativePiAck) => {
    const run = queue.then(async (): Promise<NativePiAck> => {
      try {
        if (!current(req)) return { requestId: req.requestId, outcome: 'rejected', reason: 'stale session target' }
        const result = await action()
        if (result.outcome === 'accepted') await publishState()
        return result
      } catch (error) {
        return { requestId: req.requestId, outcome: 'rejected', reason: error instanceof Error ? error.message : String(error) }
      }
    })
    queue = run.then(() => {}, () => {})
    return run
  }
  return {
    modelState: state,
    publishState,
    setModel: (req: SetModelRequest) => mutate(req, async () => {
      if (!piUsable()) return { requestId: req.requestId, outcome: 'rejected', reason: 'Pi model selection unavailable after session replacement' }
      const registry = context().modelRegistry
      if (!registry || typeof registry.find !== 'function' || typeof pi.setModel !== 'function') return { requestId: req.requestId, outcome: 'rejected', reason: 'model selection unavailable' }
      const model = registry.find(req.provider, req.modelId)
      if (!model) return { requestId: req.requestId, outcome: 'rejected', reason: `model not found: ${req.provider}/${req.modelId}` }
      return await pi.setModel(model) ? { requestId: req.requestId, outcome: 'accepted', reason: null } : { requestId: req.requestId, outcome: 'rejected', reason: 'authentication not configured for provider' }
    }),
    setThinking: (req: SetThinkingRequest) => mutate(req, () => {
      if (!piUsable()) return { requestId: req.requestId, outcome: 'rejected', reason: 'Pi thinking-level selection unavailable after session replacement' }
      if (typeof pi.setThinkingLevel !== 'function') return { requestId: req.requestId, outcome: 'rejected', reason: 'thinking selection unavailable' }
      pi.setThinkingLevel(req.level)
      return { requestId: req.requestId, outcome: 'accepted', reason: null }
    }),
    sessionsList: async (): Promise<NativeSessionsResult> => {
      try {
        const ctx = context(), manager = ctx.sessionManager
        if (typeof SessionManager.list !== 'function' || typeof manager.getSessionDir !== 'function') throw new Error('session listing unavailable')
        const sessions = await SessionManager.list(ctx.cwd, manager.getSessionDir())
        return { sessions: sessions.map(info => ({ sessionId: info.id, file: info.path, name: info.name ?? null, modified: info.modified.toISOString(), firstMessage: info.firstMessage })), error: null }
      } catch (error) {
        return { sessions: [], error: error instanceof Error ? error.message : String(error) }
      }
    },
    dispose() { disposed = true },
  }
}
