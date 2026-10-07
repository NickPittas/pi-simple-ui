import { describe, expect, it } from 'vitest';
import type { Json, NativePiEnvelope, NativePiSessionSnapshot } from '../../shared/native-pi.ts';
import { applyNativeConversationEvent, createNativeConversation, reconcileNativeConversation, selectReport, selectStatus } from './native-conversation.ts';
import { projectNativeSession } from './native-message.ts';

const user = (id: string, parentId: string | null): Json => ({ id, parentId, type: 'message', message: { role: 'user', content: id } });
const snap = (over: Partial<NativePiSessionSnapshot> = {}): NativePiSessionSnapshot => ({
  sessionId: 's', sessionGeneration: 2, name: null, file: null, cwd: null, classification: 'root', parentSessionId: null,
  entries: [user('a', null), user('b', 'a')], activeLeaf: 'b', activeBranch: ['a', 'b'], partial: null, metadata: null, ...over,
});
const env = (over: Partial<NativePiEnvelope> = {}): NativePiEnvelope => ({
  version: 1, processGeneration: 1, sequence: 10, sessionId: 's', sessionGeneration: 2, kind: 'event', payload: null, ...over,
});

describe('createNativeConversation', () => {
  it('returns the empty initial shape', () => {
    expect(createNativeConversation()).toEqual({
      sessionId: null, generation: 0, root: null, messages: [], pendingPages: [], seq: 0, transportStatus: null,
      report: { duplicates: [], gaps: [], stale: [], droppedLateEvents: [] },
    });
  });
});

describe('reconcileNativeConversation', () => {
  it('records stale snapshots without changing messages or sessionId', () => {
    const state = reconcileNativeConversation(createNativeConversation(), snap());
    const next = reconcileNativeConversation(state, snap({ sessionGeneration: 1 }));
    expect(next.report.stale).toHaveLength(1);
    expect(next.messages).toBe(state.messages);
    expect(next.sessionId).toBe('s');
    expect(next.generation).toBe(2);
  });

  it('reports duplicate entry ids', () => {
    const next = reconcileNativeConversation(createNativeConversation(), snap({ entries: [user('a', null), user('a', null), user('b', 'a')] }));
    expect(next.report.duplicates).toEqual(['a']);
  });

  it('reports gaps with their sources', () => {
    const next = reconcileNativeConversation(createNativeConversation(), snap({
      entries: [user('b', 'missingParent')], activeLeaf: 'missingLeaf', activeBranch: ['b', 'missingBranch'],
    }));
    expect(next.report.gaps).toEqual([
      { reference: 'missingLeaf', source: 'activeLeaf' },
      { reference: 'missingBranch', source: 'activeBranch' },
      { reference: 'missingParent', source: 'parentId:b' },
    ]);
  });

  it('sets root, resets pendingPages and projects messages', () => {
    const s = snap();
    const base = { ...createNativeConversation(), pendingPages: ['p1'] };
    const next = reconcileNativeConversation(base, s);
    expect(next.root).toBe('a');
    expect(next.pendingPages).toEqual([]);
    expect(next.sessionId).toBe('s');
    expect(next.generation).toBe(2);
    expect(next.messages).toEqual(projectNativeSession(s));
  });

  it('caps reports at the last 20 entries', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `d${i}`);
    const entries = ids.flatMap((id) => [user(id, null), user(id, null)]);
    const next = reconcileNativeConversation(createNativeConversation(), snap({ entries, activeLeaf: null, activeBranch: null }));
    expect(next.report.duplicates).toEqual(ids.slice(-20));
  });
});

describe('applyNativeConversationEvent', () => {
  const ready = () => reconcileNativeConversation(createNativeConversation(), snap());

  it('sets transportStatus only for status payloads', () => {
    const state = ready();
    const status = { processGeneration: 1, state: 'connected' as const, reason: null };
    const next = applyNativeConversationEvent(state, status);
    expect(next).toEqual({ ...state, transportStatus: status });
  });

  it('drops events with a mismatched session id or generation', () => {
    const state = ready();
    expect(applyNativeConversationEvent(state, env({ sessionId: 'other' })).report.droppedLateEvents).toHaveLength(1);
    const gen = applyNativeConversationEvent(state, env({ sessionGeneration: 1 }));
    expect(gen.report.droppedLateEvents).toHaveLength(1);
    expect(gen.seq).toBe(0);
  });

  it('does not treat sessionId:null as a mismatch', () => {
    const state = ready();
    const next = applyNativeConversationEvent(state, env({ sessionId: null, sessionGeneration: null, payload: { type: 'compaction_start' } }));
    expect(next.report.droppedLateEvents).toEqual([]);
    expect(next.seq).toBe(1);
  });

  it('returns the same state for non-event kinds', () => {
    const state = ready();
    expect(applyNativeConversationEvent(state, env({ kind: 'snapshot' }))).toBe(state);
  });

  it('increments seq and applies the payload with event:<seq> ids', () => {
    const state = ready();
    const next = applyNativeConversationEvent(state, env({ payload: { type: 'compaction_start' } }));
    expect(next.seq).toBe(1);
    expect(next.messages.at(-1)?.id).toBe('event:1');
    expect(next.messages).toHaveLength(state.messages.length + 1);
  });
});

describe('selectors', () => {
  it('selectStatus reports streaming and hasRoot', () => {
    const empty = createNativeConversation();
    expect(selectStatus(empty)).toMatchObject({ hasRoot: false, streaming: false });
    const ready = reconcileNativeConversation(empty, snap());
    expect(selectStatus(ready)).toMatchObject({ hasRoot: true, streaming: false, generation: 2 });
    const streaming = applyNativeConversationEvent(ready, env({ payload: { type: 'message_start', message: { id: 'n', role: 'assistant', content: 'x' } } }));
    expect(selectStatus(streaming).streaming).toBe(true);
  });

  it('selectReport returns state.report', () => {
    const state = createNativeConversation();
    expect(selectReport(state)).toBe(state.report);
  });
});
