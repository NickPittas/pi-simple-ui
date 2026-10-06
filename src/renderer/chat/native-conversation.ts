import type { Json, NativePiEnvelope, NativePiSessionSnapshot, NativeTransportStatus } from '../../shared/native-pi.ts';
import { applyNativeMessageEvent, projectNativeSession } from './native-message.ts';

type NativeMessage = ReturnType<typeof projectNativeSession>[number];
type Gap = { readonly reference: string; readonly source: string };
export type NativeConversationReport = {
  readonly duplicates: readonly string[];
  readonly gaps: readonly Gap[];
  readonly stale: readonly string[];
  readonly droppedLateEvents: readonly string[];
};
export type NativeConversation = {
  readonly sessionId: string | null;
  readonly generation: number;
  readonly root: string | null;
  readonly messages: readonly NativeMessage[];
  readonly pendingPages: readonly string[];
  readonly seq: number;
  readonly transportStatus: NativeTransportStatus | null;
  readonly report: NativeConversationReport;
};
type ConversationPayload = NativePiEnvelope | NativeTransportStatus;
const emptyReport = (): NativeConversationReport => ({ duplicates: [], gaps: [], stale: [], droppedLateEvents: [] });
// Diagnostic records are bounded (last 20 kept), never authoritative content.
const capped = <T>(values: readonly T[]): T[] => values.slice(-20);
const isRecord = (value: Json | undefined): value is { [key: string]: Json } => typeof value === 'object' && value !== null && !Array.isArray(value);

export function createNativeConversation(): NativeConversation {
  return { sessionId: null, generation: 0, root: null, messages: [], pendingPages: [], seq: 0, transportStatus: null, report: emptyReport() };
}

export function reconcileNativeConversation(state: NativeConversation, snapshot: NativePiSessionSnapshot): NativeConversation {
  if (snapshot.sessionGeneration < state.generation) return { ...state, report: { ...state.report, stale: capped([...state.report.stale, `snapshot ${snapshot.sessionId}@${snapshot.sessionGeneration} older than ${state.generation}`]) } };
  const ids = new Set<string>(), duplicates: string[] = [], gaps: Gap[] = [];
  for (const entry of snapshot.entries) if (isRecord(entry) && typeof entry.id === 'string') {
    if (ids.has(entry.id)) duplicates.push(entry.id);
    ids.add(entry.id);
  }
  const reference = (id: string | null, source: string) => { if (id && !ids.has(id)) gaps.push({ reference: id, source }); };
  reference(snapshot.activeLeaf, 'activeLeaf');
  for (const id of snapshot.activeBranch ?? []) reference(id, 'activeBranch');
  for (const entry of snapshot.entries) if (isRecord(entry)) reference(typeof entry.parentId === 'string' ? entry.parentId : null, `parentId:${typeof entry.id === 'string' ? entry.id : 'unknown'}`);
  const allowed = new Set(snapshot.activeBranch ?? []), chain: { id: string; parentId: string | null }[] = [], seen = new Set<string>();
  let cursor = snapshot.activeLeaf;
  while (cursor && !seen.has(cursor) && allowed.has(cursor)) {
    const entry = snapshot.entries.find((item) => isRecord(item) && item.id === cursor);
    if (!isRecord(entry)) break;
    seen.add(cursor);
    const parentId = typeof entry.parentId === 'string' ? entry.parentId : null;
    chain.push({ id: cursor, parentId });
    cursor = parentId;
  }
  const root = chain.length ? chain[chain.length - 1].id : null;
  return { ...state, sessionId: snapshot.sessionId, generation: snapshot.sessionGeneration, root, messages: projectNativeSession(snapshot), pendingPages: [], report: { ...state.report, duplicates: capped([...state.report.duplicates, ...duplicates]), gaps: capped([...state.report.gaps, ...gaps]) } };
}

export function applyNativeConversationEvent(state: NativeConversation, payload: ConversationPayload): NativeConversation {
  if ('state' in payload) return { ...state, transportStatus: payload };
  const mismatch = payload.sessionId !== null && (payload.sessionId !== state.sessionId || payload.sessionGeneration !== state.generation);
  if (mismatch) return { ...state, report: { ...state.report, droppedLateEvents: capped([...state.report.droppedLateEvents, `event ${payload.sequence}: ${payload.sessionId}@${payload.sessionGeneration} does not match ${state.sessionId}@${state.generation}`]) } };
  if (payload.kind !== 'event') return state;
  const seq = state.seq + 1;
  return { ...state, seq, messages: applyNativeMessageEvent([...state.messages], payload.payload, seq) };
}

export function selectMessages(state: NativeConversation): readonly NativeMessage[] { return state.messages; }
export function selectStatus(state: NativeConversation) {
  return { hasRoot: state.root !== null, generation: state.generation, streaming: state.messages.some((message) => message.nativeEntryType === 'pending'), transport: state.transportStatus };
}
export function selectReport(state: NativeConversation): NativeConversationReport { return state.report; }
