import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import type { NativePiEnvelope, NativePiSnapshot, NativeTransportStatus } from '../../shared/native-pi.ts';
import {
  applyNativeConversationEvent,
  createNativeConversation,
  reconcileNativeConversation,
  selectReport,
  type NativeConversation,
  type NativeConversationReport,
} from './native-conversation.ts';

const BUFFER_LIMIT = 256;
const EVENT_CHANNEL = 'native.pi.events';
const STATUS_CHANNEL = 'native.pi.transport-status';

export interface NativeConversationsOptions {
  readonly bridge: DesktopBridge;
  readonly scope?: RuntimeScope;
  readonly sessionId?: string;
}

export interface NativeConversationsResult {
  readonly state: NativeConversation;
  readonly report: NativeConversationReport;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

// Call once in the parent that owns all conversation consumers: one subscription/state owner.
export function useNativeConversations({ bridge, scope, sessionId }: NativeConversationsOptions): NativeConversationsResult {
  const [state, setState] = useState(createNativeConversation);
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const scopeKey = scope ? `${scope.ownerId}:${scope.generation}` : 'no-scope';

  useEffect(() => {
    let active = true;
    let ready = false;
    let recovering = false;
    let snapshotInFlight = false;
    let snapshotAgain = false;
    let reconnectPending = false;
    let stopEvents: (() => void) | undefined;
    let stopStatus: (() => void) | undefined;
    let cutoff: { processGeneration: number; sequence: number } | undefined;
    let priorTransport: NativeTransportStatus['state'] | null = null;
    const buffered: NativePiEnvelope[] = [];
    setState(createNativeConversation());
    setError(null);

    const apply = (envelope: NativePiEnvelope) => setState((current) => applyNativeConversationEvent(current, envelope));
    const isSettlement = (event: NativePiEnvelope) => event.kind === 'event' && typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
      && (event.payload.type === 'turn_end' || event.payload.type === 'entry_appended');
    // No local processGeneration gate: main publish gate + scopeKey effect re-run protect this lifetime.
    // Callers must re-scope when processGeneration changes.
    const isBeforeCutoff = (event: NativePiEnvelope) => cutoff !== undefined
      && event.processGeneration === cutoff.processGeneration && event.sequence <= cutoff.sequence;
    const enqueue = (event: NativePiEnvelope) => {
      if (buffered.length === BUFFER_LIMIT) {
        buffered.shift();
        setError(`Native event buffer full (${BUFFER_LIMIT}); dropped oldest event.`);
      }
      buffered.push(event);
    };
    const chooseSession = (snapshot: NativePiSnapshot) => snapshot.sessions.find((item) => item.sessionId === sessionId)
      ?? snapshot.sessions.find((item) => item.sessionId === snapshot.rootSessionId)
      ?? snapshot.sessions[0];

    const requestSnapshot = async (): Promise<void> => {
      if (!active) return;
      if (snapshotInFlight) { snapshotAgain = true; return; }
      snapshotInFlight = true;
      recovering = true;
      let refreshAgain = false;
      try {
        const result = await bridge.invoke('native.pi.snapshot', {}, scope);
        if (!active) return;
        if (!result.ok) { setError(result.error.message); return; }
        const snapshot = result.value;
        const session = chooseSession(snapshot);
        if (!session) { setError('Native snapshot contains no conversation session.'); return; }
        cutoff = { processGeneration: snapshot.processGeneration, sequence: snapshot.sequence };
        setState((current) => reconcileNativeConversation(current, session));
        ready = true;
        let sawGap = false;
        for (const event of buffered.splice(0)) {
          // Already in the snapshot baseline; skip pre-cutoff envelopes as deduplication by design.
          if (isBeforeCutoff(event)) continue;
          if (event.kind === 'gap') { sawGap = true; continue; }
          apply(event);
          if (isSettlement(event)) refreshAgain = true;
        }
        if (sawGap || reconnectPending || snapshotAgain) { reconnectPending = false; snapshotAgain = false; refreshAgain = true; }
        // Clear only on an actual applied snapshot; failures above keep their own error.
        setError(null);
      } catch {
        if (active) setError('Could not load the native conversation snapshot.');
      } finally {
        snapshotInFlight = false;
        recovering = false;
        if (snapshotAgain) { snapshotAgain = false; refreshAgain = true; }
        if (active && refreshAgain) void requestSnapshot();
      }
    };

    refreshRef.current = requestSnapshot;
    const onEvent = (event: NativePiEnvelope) => {
      if (!active) return;
      if (!ready || recovering) { enqueue(event); if (isSettlement(event)) snapshotAgain = true; return; }
      // Already in the snapshot baseline; skip pre-cutoff envelopes as deduplication by design.
      if (isBeforeCutoff(event)) return;
      if (event.kind === 'gap') { void requestSnapshot(); return; }
      apply(event);
      if (isSettlement(event)) void requestSnapshot();
    };
    const onStatus = (status: NativeTransportStatus) => {
      if (!active) return;
      setState((current) => applyNativeConversationEvent(current, status));
      if (status.state === 'connected' && priorTransport !== null && priorTransport !== 'connected') {
        if (ready && !recovering) void requestSnapshot();
        else {
          // reconnectPending is only consumed by a completed snapshot, so a snapshot attempt must
          // be (re)triggered here; otherwise a snapshot that failed before the bridge connected
          // (normal startup ordering) deadlocks the conversation in its initial error state.
          reconnectPending = true;
          void requestSnapshot();
        }
      }
      priorTransport = status.state;
    };

    const start = async () => {
      // Subscribe before requesting the baseline; pre-snapshot events remain buffered.
      const events = await bridge.subscribe(EVENT_CHANNEL, scope, onEvent);
      if (!active) { if (events.ok) events.value(); return; }
      if (!events.ok) { setError(events.error.message); return; }
      stopEvents = events.value;
      const statuses = await bridge.subscribe(STATUS_CHANNEL, scope, onStatus);
      if (!active) { if (statuses.ok) statuses.value(); return; }
      if (!statuses.ok) { setError(statuses.error.message); stopEvents(); stopEvents = undefined; return; }
      stopStatus = statuses.value;
      await requestSnapshot();
    };
    void start().catch(() => { if (active) setError('Could not subscribe to native conversation updates.'); });
    return () => {
      active = false;
      ready = false;
      buffered.length = 0;
      refreshRef.current = async () => undefined;
      stopEvents?.();
      stopStatus?.();
    };
  }, [bridge, scopeKey, sessionId]);

  return { state, report: selectReport(state), error, refresh: () => refreshRef.current() };
}
