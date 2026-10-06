import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import type { NativeModelState, NativePiEnvelope, NativeSessionSummary, NativeThinkingLevel } from '../../shared/native-pi.ts';
import type { WorkspaceSnapshot } from '../../shared/workspaces.ts';

const events = 'native.pi.events';
const transport = 'native.pi.transport-status';
type Options = { bridge: DesktopBridge; scope?: RuntimeScope; workspaceId: string | null; onSnapshot: (snapshot: WorkspaceSnapshot) => void };
type Controls = { modelState: NativeModelState | null; sessions: NativeSessionSummary[]; loading: boolean; error: string | null; pending: boolean };

export function useNativeChatControls({ bridge, scope, workspaceId, onSnapshot }: Options) {
  const [view, setView] = useState<Controls>({ modelState: null, sessions: [], loading: true, error: null, pending: false });
  const actions = useRef<{ refresh: () => Promise<void>; sessions: () => Promise<void>; model: (provider: string, id: string) => Promise<void>; thinking: (level: NativeThinkingLevel) => Promise<void>; open: (file: string | null) => Promise<void> } | undefined>(undefined);
  const key = `${scope?.ownerId ?? ''}:${scope?.generation ?? ''}:${workspaceId ?? ''}`;
  useEffect(() => {
    let active = true, sequence = -1, busy = false, prior: string | null = null;
    let stopEvents: (() => void) | undefined, stopTransport: (() => void) | undefined;
    let current: NativeModelState | null = null;
    const early: NativePiEnvelope[] = [];
    const update = (patch: Partial<Controls>) => { if (active) setView((value) => ({ ...value, ...patch })); };
    const sessions = async () => {
      const result = await bridge.invoke('native.pi.sessions-list', {}, scope);
      if (!active) return;
      update(result.ok ? { sessions: result.value.sessions, error: result.value.error } : { error: result.error.message });
    };
    const refresh = async () => {
      update({ loading: true });
      const [model, list] = await Promise.all([bridge.invoke('native.pi.model-state', {}, scope), bridge.invoke('native.pi.sessions-list', {}, scope)]);
      if (!active) return;
      if (model.ok && model.value.state && (!current || model.value.state.sessionId !== current.sessionId || model.value.state.sessionGeneration !== current.sessionGeneration || model.value.state.sequence >= sequence)) {
        current = model.value.state; sequence = current.sequence; busy = current.busy; update({ modelState: current });
        for (const event of early.splice(0)) onEvent(event);
      }
      if (list.ok) update({ sessions: list.value.sessions });
      update({ error: model.ok ? model.value.error : model.error.message, loading: false });
      if (list.ok ? list.value.error : list.error.message) update({ error: list.ok ? list.value.error : list.error.message });
    };
    const mutate = async (capability: 'native.pi.set-model' | 'native.pi.set-thinking', value: { provider: string; modelId: string } | { level: NativeThinkingLevel }) => {
      if (!active || !current) return;
      update({ pending: true, error: null });
      const target = { requestId: crypto.randomUUID(), sessionId: current.sessionId, sessionGeneration: current.sessionGeneration };
      const result = capability === 'native.pi.set-model'
        ? await bridge.invoke(capability, { ...target, ...(value as { provider: string; modelId: string }) }, scope)
        : await bridge.invoke(capability, { ...target, ...(value as { level: NativeThinkingLevel }) }, scope);
      if (!active) return;
      const outcome = result.ok ? result.value.outcome === 'accepted' ? null : result.value.reason ?? result.value.outcome : result.error.message;
      update({ pending: false });
      await refresh();
      if (outcome) update({ error: outcome });
    };
    actions.current = {
      refresh, sessions,
      model: (provider, id) => mutate('native.pi.set-model', { provider, modelId: id }),
      thinking: (level) => mutate('native.pi.set-thinking', { level }),
      open: async (file) => {
        if (!current || !workspaceId) return;
        update({ pending: true, error: null });
        const result = await bridge.invoke('native.pi.open-session', { workspaceId, expectedProcessGeneration: current.processGeneration, expectedSessionId: current.sessionId, file });
        if (!active) return;
        if (result.ok) { onSnapshot(result.value.snapshot); update({ error: result.value.reason }); }
        else update({ error: result.error.message });
        update({ pending: false });
      },
    };
    setView({ modelState: null, sessions: [], loading: true, error: null, pending: false });
    const onEvent = (event: NativePiEnvelope) => {
      const payload = event.payload as { type?: string; state?: NativeModelState };
      const state = payload?.type === 'model-state' ? payload.state : undefined;
      if (!current) { if (state) early.push(event); return; }
      if (!state || event.kind !== 'status' || event.processGeneration !== current.processGeneration || event.sessionId !== current.sessionId || event.sessionGeneration !== current.sessionGeneration || state.sequence !== event.sequence || state.sequence <= sequence) return;
      sequence = state.sequence; current = state; update({ modelState: state });
      if (busy && !state.busy) void sessions();
      busy = state.busy;
    };
    const start = async () => {
      const subscribed = await bridge.subscribe(events, scope, onEvent);
      if (!active) { if (subscribed.ok) subscribed.value(); return; }
      if (!subscribed.ok) { update({ loading: false, error: subscribed.error.message }); return; }
      stopEvents = subscribed.value;
      const status = await bridge.subscribe(transport, scope, (value) => {
        if (value.state === 'connected' && prior !== null && prior !== 'connected') void refresh();
        prior = value.state;
      });
      if (!active) { if (status.ok) status.value(); return; }
      if (status.ok) stopTransport = status.value;
      await refresh();
    };
    void start();
    return () => { active = false; stopEvents?.(); stopTransport?.(); actions.current = undefined; };
  }, [bridge, key, onSnapshot]);
  return { ...view, refresh: () => actions.current?.refresh() ?? Promise.resolve(), refreshSessions: () => actions.current?.sessions() ?? Promise.resolve(), setModel: (provider: string, id: string) => actions.current?.model(provider, id), setThinking: (level: NativeThinkingLevel) => actions.current?.thinking(level), openSession: (file: string | null) => actions.current?.open(file) };
}
