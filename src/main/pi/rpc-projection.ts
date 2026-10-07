import { randomUUID } from 'node:crypto'
import type { NativeModelChoice, NativeModelState, NativeModelStateResult, NativePiEnvelope, NativePiSnapshot, NativeSessionTarget, NativeThinkingLevel, NativeTransportStatus, SnapshotRequest, Stop, Json } from '../../shared/native-pi.ts'
import { isNativeThinkingLevel } from '../../shared/native-pi-validation.ts'
import { createRpcMessageStream } from './rpc-message-stream.ts'
import { readEnabledModelPatterns, resolveScopedModels } from './scoped-models.ts'
import { projectRpcSnapshot } from './rpc-snapshot.ts'
import type { RpcRecord, RpcTransport } from './rpc-transport.ts'

export type RpcProjection = {
  readState(): Promise<RpcRecord>
  target(): NativeSessionTarget | null
  snapshot(request: SnapshotRequest): Promise<NativePiSnapshot>
  modelState(): Promise<NativeModelStateResult>
  refreshModel(): Promise<void>
  subscribe(listener: (event: NativePiEnvelope) => void): Stop
  onStatus(listener: (status: NativeTransportStatus) => void): Stop
  subscribeUi(listener: (record: RpcRecord) => void): Stop
  respondUi(response: RpcRecord & { id: string }): boolean
  exited(code: number): void
  dispose(): void
}

type NativeState = RpcRecord & { sessionId: string; isStreaming: boolean; isCompacting: boolean; pendingMessageCount: number }
type StateCapture = { target: NativeSessionTarget; nativeState: NativeState }
type Baseline = { sequence: number; state: NativeState; target: NativeSessionTarget; partial: Json | null }
const dialogs = new Set(['select', 'confirm', 'input', 'editor'])
const refreshEvents = new Set(['agent_start', 'agent_settled', 'thinking_level_changed', 'session_info_changed', 'queue_update', 'compaction_start', 'compaction_end'])
const json = (value: unknown): value is Json => {
  try { return JSON.stringify(value) !== undefined } catch { return false }
}
const record = (value: unknown): value is RpcRecord => typeof value === 'object' && value !== null && !Array.isArray(value)
const validState = (value: unknown): value is NativeState => record(value)
  && typeof value.sessionId === 'string' && value.sessionId.length > 0
  && typeof value.isStreaming === 'boolean' && typeof value.isCompacting === 'boolean'
  && Number.isSafeInteger(value.pendingMessageCount) && (value.pendingMessageCount as number) >= 0
const choice = (value: unknown): NativeModelChoice | null => record(value)
  && typeof value.provider === 'string' && value.provider.length > 0 && typeof value.id === 'string' && value.id.length > 0
  ? { provider: value.provider, id: value.id, name: typeof value.name === 'string' && value.name ? value.name : value.id } : null
const failure = (error: unknown): string => error instanceof Error ? error.message : 'Invalid Pi RPC response'

export function createRpcProjection(rpc: RpcTransport, processGeneration: number): RpcProjection {
  const stream = createRpcMessageStream()
  const events = new Set<(event: NativePiEnvelope) => void>()
  const statuses = new Set<(status: NativeTransportStatus) => void>()
  const uiListeners = new Set<(record: RpcRecord) => void>()
  const pendingUi = new Map<string, RpcRecord>()
  const uiTimers = new Map<string, NodeJS.Timeout>()
  const expiredUi = new Set<string>()
  const baselines = new WeakMap<object, Baseline>()
  const stateResponses = new WeakMap<object, StateCapture>()
  const stateObjects = new WeakMap<object, StateCapture>()
  let state: NativeState | null = null, sessionGeneration = -1, sequence = 0
  let latestStatus: NativeTransportStatus = { processGeneration, state: 'waiting', reason: null }
  let ended = false, disposed = false, modelRefresh: Promise<void> | null = null, modelRefreshAgain = false

  const status = (next: NativeTransportStatus) => {
    if (disposed) return
    latestStatus = next
    for (const listener of [...statuses]) try { listener(next) } catch {}
  }
  const publish = (kind: NativePiEnvelope['kind'], payload: Json, target = state ? { sessionId: state.sessionId, sessionGeneration } : null): NativePiEnvelope => {
    const envelope: NativePiEnvelope = { version: 1, processGeneration, sequence: ++sequence, sessionId: target?.sessionId ?? null, sessionGeneration: target?.sessionGeneration ?? null, kind, payload }
    for (const listener of [...events]) try { listener(envelope) } catch {}
    return envelope
  }
  const adopt = (next: NativeState): NativeState => {
    const changed = state !== null && state.sessionId !== next.sessionId
    if (state === null || changed) sessionGeneration++
    state = next
    if (changed) {
      stream.reset()
      publish('gap', { type: 'native-active-session-changed' }, { sessionId: next.sessionId, sessionGeneration })
    }
    if (!ended && !disposed && latestStatus.state !== 'connected') status({ processGeneration, state: 'connected', reason: null })
    return next
  }
  const responseData = (response: RpcRecord, command: string): unknown => {
    if (response.type !== 'response' || response.command !== command || response.success !== true) throw new Error(typeof response.error === 'string' ? response.error : `Pi RPC ${command} failed`)
    return response.data
  }
  const captureStateResponse = (response: RpcRecord): StateCapture | null => {
    if (response.type !== 'response' || response.command !== 'get_state' || response.success !== true || !validState(response.data)) return null
    const nativeState = adopt(response.data), capture: StateCapture = { target: { sessionId: nativeState.sessionId, sessionGeneration }, nativeState }
    stateResponses.set(response, capture); stateObjects.set(nativeState, capture); return capture
  }
  const currentState = (capture: StateCapture): boolean => state?.sessionId === capture.target.sessionId && sessionGeneration === capture.target.sessionGeneration
  const stateResponse = async (): Promise<{ response: RpcRecord; data: NativeState }> => {
    const response = await rpc.request({ type: 'get_state' }), data = responseData(response, 'get_state'), capture = stateResponses.get(response)
    if (disposed || ended) throw new Error('Pi RPC projection is not active')
    if (!validState(data)) throw new Error('Invalid Pi RPC get_state data')
    if (!capture || capture.nativeState !== data || !currentState(capture)) throw new Error('Pi session state changed during query')
    return { response, data }
  }
  const requestState = async (): Promise<NativeState> => (await stateResponse()).data
  const uiRecord = (r: RpcRecord) => { for (const listener of [...uiListeners]) try { listener(r) } catch {} }
  const clearUiTimer = (id: string): void => { const timer = uiTimers.get(id); if (timer) clearTimeout(timer); uiTimers.delete(id) }
  const presentationTimeout = (request: RpcRecord): number | null => typeof request.timeout === 'number' && Number.isFinite(request.timeout) && request.timeout > 0 && request.timeout <= 2_147_483_647 && ['select', 'confirm', 'input'].includes(String(request.method)) ? request.timeout : null
  const expireUi = (id: string): void => { clearUiTimer(id); if (!pendingUi.delete(id)) return; expiredUi.add(id); rpc.forgetUi(id); /* Application presentation signal, not a native RPC record. */ uiRecord({ type: 'rpc_ui_timeout', id }) }
  const clearUiTimers = (): void => { for (const timer of uiTimers.values()) clearTimeout(timer); uiTimers.clear() }
  const onRecord = (r: RpcRecord) => {
    if (disposed || ended || r.type === 'response') return
    if (r.type === 'extension_ui_request') {
      if (typeof r.id === 'string' && dialogs.has(String(r.method)) && !expiredUi.has(r.id)) {
        if (!pendingUi.has(r.id)) {
          pendingUi.set(r.id, r); const timeout = presentationTimeout(r)
          if (timeout !== null) { const timer = setTimeout(() => expireUi(r.id as string), timeout); timer.unref?.(); uiTimers.set(r.id, timer) }
        }
      }
      uiRecord(r)
      return
    }
    const payload = stream.receive(r as Json)
    if (json(payload)) publish('event', payload, state ? { sessionId: state.sessionId, sessionGeneration } : null)
    if (typeof r.type === 'string' && refreshEvents.has(r.type)) void refreshModel()
  }
  const stopReader = rpc.subscribe((r) => {
    if (disposed || ended) return
    if (r.type === 'response' && r.command === 'get_state') captureStateResponse(r)
    if (r.type === 'response' && r.command === 'get_entries' && r.success === true && state) {
      baselines.set(r, { sequence, state, target: { sessionId: state.sessionId, sessionGeneration }, partial: stream.partial() })
    }
    onRecord(r)
  })

  const readState = async () => (await stateResponse()).response
  const target = (): NativeSessionTarget | null => state ? { sessionId: state.sessionId, sessionGeneration } : null
  const snapshot = async (request: SnapshotRequest): Promise<NativePiSnapshot> => {
    if (request.cursor) return { snapshotId: randomUUID(), processGeneration, sequence, state: 'unsupported', rootSessionId: target()?.sessionId ?? null, sessions: [], nextCursor: null, error: 'RPC snapshots do not support cursors' }
    try {
      const before = await requestState()
      const beforeCapture = stateObjects.get(before)
      if (!beforeCapture || !currentState(beforeCapture)) throw new Error('Pi session state changed during snapshot')
      const response = await rpc.request({ type: 'get_entries' })
      if (disposed || ended) throw new Error('Pi RPC projection is not active')
      const data = responseData(response, 'get_entries')
      const captured = baselines.get(response)
      if (!captured || !record(data) || !Array.isArray(data.entries) || !json(data.entries) || !(data.leafId === null || typeof data.leafId === 'string')) throw new Error('Invalid Pi RPC get_entries data')
      if (captured.target.sessionId !== beforeCapture.target.sessionId || captured.target.sessionGeneration !== beforeCapture.target.sessionGeneration || !currentState(beforeCapture)) throw new Error('Pi session changed during snapshot')
      return projectRpcSnapshot({ snapshotId: randomUUID(), processGeneration, sequence: captured.sequence, sessionGeneration: captured.target.sessionGeneration, session: { sessionId: captured.target.sessionId, ...(typeof before.sessionFile === 'string' ? { sessionFile: before.sessionFile } : {}), ...(typeof before.sessionName === 'string' ? { sessionName: before.sessionName } : {}) }, entries: data.entries, leafId: data.leafId, partial: captured.partial })
    } catch (error) {
      return { snapshotId: randomUUID(), processGeneration, sequence, state: ended ? 'exited' : 'gap', rootSessionId: target()?.sessionId ?? null, sessions: [], nextCursor: null, error: failure(error) }
    }
  }
  const modelState = async (): Promise<NativeModelStateResult> => {
    try {
      const native = await requestState()
      const nativeCapture = stateObjects.get(native)
      if (!nativeCapture || !currentState(nativeCapture)) throw new Error('Pi session state changed during model refresh')
      const activeTarget = nativeCapture.target
      const [modelsResponse, levelsResponse] = await Promise.all([
        rpc.request({ type: 'get_available_models' }), rpc.request({ type: 'get_available_thinking_levels' }),
      ])
      if (disposed || ended) throw new Error('Pi RPC projection is not active')
      const modelsData = responseData(modelsResponse, 'get_available_models')
      const levelsData = responseData(levelsResponse, 'get_available_thinking_levels')
      if (!record(modelsData) || !Array.isArray(modelsData.models) || !record(levelsData) || !Array.isArray(levelsData.levels)) throw new Error('Invalid Pi RPC model data')
      const models = modelsData.models.map(choice)
      if (models.some((item) => item === null) || !levelsData.levels.every(isNativeThinkingLevel)) throw new Error('Invalid Pi RPC model or thinking-level value')
      const active = choice(native.model)
      const scopedList = resolveScopedModels(await readEnabledModelPatterns(), models as NativeModelChoice[])
      if (native.model !== undefined && native.model !== null && active === null) throw new Error('Invalid Pi RPC active model')
      if (!isNativeThinkingLevel(native.thinkingLevel)) throw new Error('Pi session or model state changed during refresh')
      const thinkingLevel = native.thinkingLevel
      const latest = state, latestModel = choice(latest?.model)
      if (!latest || !currentState(nativeCapture)
        || latestModel?.provider !== active?.provider || latestModel?.id !== active?.id
        || latest.thinkingLevel !== thinkingLevel || latest.isStreaming !== native.isStreaming
        || latest.isCompacting !== native.isCompacting || latest.pendingMessageCount !== native.pendingMessageCount) {
        throw new Error('Pi session or model state changed during refresh')
      }
      const stateValue: NativeModelState = {
        sessionId: native.sessionId, sessionGeneration: activeTarget.sessionGeneration, processGeneration, sequence,
        model: active, models: scopedList.length ? scopedList : models as NativeModelChoice[], allModels: models as NativeModelChoice[], scoped: scopedList.length > 0, thinkingLevel, thinkingLevels: levelsData.levels as NativeThinkingLevel[],
        busy: native.isStreaming || native.isCompacting || native.pendingMessageCount > 0,
      }
      return { state: stateValue, error: null }
    } catch (error) { return { state: null, error: failure(error) } }
  }
  const refreshModel = (): Promise<void> => {
    if (modelRefresh) { modelRefreshAgain = true; return modelRefresh }
    modelRefresh = (async () => {
      const result = await modelState()
      if (disposed || ended || !result.state) return
      publish('status', { type: 'model-state', state: { ...result.state, sequence: sequence + 1 } })
    })().finally(() => {
      modelRefresh = null
      if (modelRefreshAgain && !disposed && !ended) { modelRefreshAgain = false; void refreshModel() }
    })
    return modelRefresh
  }
  return {
    readState, target, snapshot, modelState, refreshModel,
    subscribe(listener) { events.add(listener); return () => { events.delete(listener) } },
    onStatus(listener) { statuses.add(listener); try { listener(latestStatus) } catch {}; return () => { statuses.delete(listener) } },
    subscribeUi(listener) { uiListeners.add(listener); for (const request of pendingUi.values()) try { listener(request) } catch {}; return () => { uiListeners.delete(listener) } },
    respondUi(response) {
      if (disposed || ended || !pendingUi.has(response.id)) return false
      const accepted = rpc.respondExtensionUi(response)
      if (accepted) { pendingUi.delete(response.id); clearUiTimer(response.id) }
      return accepted
    },
    exited(code) { if (disposed || ended) return; ended = true; clearUiTimers(); state = null; stream.reset(); pendingUi.clear(); expiredUi.clear(); status({ processGeneration, state: 'disconnected', reason: `Pi RPC exited (${code})` }) },
    dispose() { if (disposed) return; disposed = true; stopReader(); clearUiTimers(); state = null; stream.reset(); pendingUi.clear(); expiredUi.clear(); latestStatus = { processGeneration, state: 'disposed', reason: null }; for (const listener of [...statuses]) try { listener(latestStatus) } catch {}; events.clear(); uiListeners.clear(); statuses.clear() },
  }
}
