import { describe, expect, it } from 'vitest';
import type { Json, NativePiSessionSnapshot } from '../../shared/native-pi.ts';
import { applyNativeMessageEvent, projectNativeSession } from './native-message.ts';

type Msgs = ReturnType<typeof projectNativeSession>;

const snap = (entries: Json[], activeLeaf: string | null, activeBranch: string[] | null, partial: Json | null = null): NativePiSessionSnapshot => ({
  sessionId: 's', sessionGeneration: 1, name: null, file: null, cwd: null, classification: 'root', parentSessionId: null, entries, activeLeaf, activeBranch, partial, metadata: null,
});
const msg = (id: string, parentId: string | null, message: Json, extra: { [k: string]: Json } = {}): Json => ({ id, parentId, type: 'message', message, ...extra });
const user = (id: string, parentId: string | null, text: string) => msg(id, parentId, { role: 'user', content: text });

describe('projectNativeSession', () => {
  it('walks the active branch only and honours activeBranchOnly:false', () => {
    const entries = [user('a', null, 'A'), user('b', 'a', 'B'), user('c', 'b', 'C')];
    const s = snap(entries, 'c', ['b', 'c']);
    expect(projectNativeSession(s).map((m) => m.id)).toEqual(['b', 'c']);
    expect(projectNativeSession(s, { activeBranchOnly: false }).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('terminates on cycles and stops at a missing entry', () => {
    const cyc = snap([user('a', 'b', 'A'), user('b', 'a', 'B')], 'a', ['a', 'b']);
    expect(projectNativeSession(cyc).map((m) => m.id)).toEqual(['b', 'a']);
    const missing = snap([user('b', 'gone', 'B')], 'b', ['b', 'gone']);
    expect(projectNativeSession(missing).map((m) => m.id)).toEqual(['b']);
  });

  it('uses the entry id for string content and derives ids for multi-block assistants', () => {
    const s = snap([
      user('u', null, 'hi'),
      msg('a1', 'u', { role: 'assistant', content: [
        { type: 'text', text: 'ok' },
        { type: 'thinking', thinking: 'hmm' },
        { type: 'toolCall', id: 't1', name: 'bash', arguments: { c: 1 } },
      ] }),
    ], 'a1', ['u', 'a1']);
    const out = projectNativeSession(s);
    expect(out[0]).toMatchObject({ id: 'u', role: 'user', content: 'hi' });
    expect(out.slice(1).map((m) => [m.id, m.role])).toEqual([['a1', 'assistant'], ['a1:thinking:1', 'thinking'], ['a1:tool:2', 'assistant']]);
    expect(out[3].toolCalls?.[0]).toMatchObject({ toolCallId: 't1', name: 'bash', status: 'running' });
  });

  it('uses plain-string toolResult content as the tool call result', () => {
    const s = snap([
      msg('a', null, { role: 'assistant', content: [{ type: 'toolCall', id: 't-a', name: 'x', arguments: null }] }),
      msg('r', 'a', { role: 'toolResult', toolCallId: 't-a', content: 'plain text' }),
    ], 'r', ['a', 'r']);
    expect(projectNativeSession(s)[0].toolCalls?.[0]).toMatchObject({ status: 'completed', result: 'plain text' });
  });

  it('resolves tool status from tool results', () => {
    const call = (id: string, parent: string | null) => msg(id, parent, { role: 'assistant', content: [{ type: 'toolCall', id: `t-${id}`, name: 'x', arguments: null }] });
    const s = snap([
      call('a', null),
      msg('r', 'a', { role: 'toolResult', toolCallId: 't-a', content: [{ type: 'text', text: 'out' }], details: { n: 1 } }),
      call('b', 'r'),
      msg('r2', 'b', { role: 'toolResult', toolCallId: 't-b', content: [{ type: 'text', text: 'bad' }], isError: true }),
    ], 'r2', ['a', 'r', 'b', 'r2']);
    const out = projectNativeSession(s);
    expect(out[0].toolCalls?.[0]).toMatchObject({ status: 'completed', result: 'out', details: { n: 1 } });
    expect(out[1]).toMatchObject({ role: 'tool-result', content: 'out' });
    expect(out[2].toolCalls?.[0]).toMatchObject({ status: 'error', result: 'bad' });
  });

  it('reports unknown roles and unsupported blocks', () => {
    const s = snap([
      msg('x', null, { role: 'x' }),
      msg('i', 'x', { role: 'assistant', content: [{ type: 'image', data: 'z' }] }),
    ], 'i', ['x', 'i']);
    const out = projectNativeSession(s);
    expect(out[0]?.content).toBe('Unknown message role "x"');
    expect(out[1]?.content).toMatch(/^Unsupported content \(image\): /);
  });

  it('handles custom_message, compaction, usage and other entry types', () => {
    const s = snap([
      { id: 'c1', parentId: null, type: 'custom_message', customType: 'ext', content: 'hello', display: true },
      { id: 'c2', parentId: 'c1', type: 'custom_message', customType: 'ext', content: 'hidden', display: false },
      { id: 'k', parentId: 'c2', type: 'compaction', summary: 'sum' },
      { id: 'u', parentId: 'k', type: 'usage', kind: 'tokens', usage: 'abc' },
      { id: 'o', parentId: 'u', type: 'weird' },
    ], 'o', ['c1', 'c2', 'k', 'u', 'o']);
    const out = projectNativeSession(s);
    expect(out.map((m) => m.id)).toEqual(['c1', 'k', 'u', 'o']);
    expect(out[0]).toMatchObject({ role: 'system', customType: 'ext', content: 'hello' });
    expect(out[1]).toMatchObject({ marker: 'compaction' });
    expect(out[2].content).toBe('Usage (tokens): abc');
    expect(out[3].content).toBe('Native session entry: weird');
  });

  it('copies timestamp only when string or number', () => {
    const s = snap([
      { ...(user('a', null, 'A') as object), timestamp: 5 } as Json,
      { ...(user('b', 'a', 'B') as object), timestamp: null } as Json,
      { ...(user('c', 'b', 'C') as object), timestamp: 'now' } as Json,
    ], 'c', ['a', 'b', 'c']);
    const out = projectNativeSession(s);
    expect(out[0].timestamp).toBe(5);
    expect('timestamp' in out[1]).toBe(false);
    expect(out[2].timestamp).toBe('now');
  });

  it('projects a non-persisted partial as pending and does not duplicate a persisted one', () => {
    const partial = { id: 'p', role: 'assistant', content: 'streaming' };
    const out = projectNativeSession(snap([user('u', null, 'hi')], 'u', ['u'], partial));
    expect(out[1]).toMatchObject({ id: 'pending:p', nativeEntryType: 'pending', streaming: true, content: 'streaming' });
    const persisted = snap([user('u', null, 'hi'), msg('m', 'u', { id: 'p', role: 'assistant', content: 'done' })], 'm', ['u', 'm'], partial);
    expect(projectNativeSession(persisted).map((m) => m.id)).toEqual(['u', 'm']);
  });
});

describe('applyNativeMessageEvent', () => {
  const start = (m: Json): Json => ({ type: 'message_start', message: m });

  it('runs the message lifecycle with an id', () => {
    let msgs: Msgs = [];
    msgs = applyNativeMessageEvent(msgs, start({ id: 'n1', role: 'assistant', content: 'a' }), 1);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ id: 'n1', nativeEntryType: 'pending', streaming: true, content: 'a' });
    msgs = applyNativeMessageEvent(msgs, { type: 'message_update', message: { id: 'n1', role: 'assistant', content: 'ab' } }, 2);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('ab');
    msgs = applyNativeMessageEvent(msgs, { type: 'message_end', message: { id: 'n1', role: 'assistant', content: 'abc' } }, 3);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ id: 'n1', content: 'abc' });
    expect(msgs.some((m) => m.nativeEntryType === 'pending')).toBe(false);
  });

  it('keys an id-less message_start by pending:<seq>', () => {
    const msgs = applyNativeMessageEvent([], start({ role: 'assistant', content: 'x' }), 7);
    expect(msgs[0]).toMatchObject({ id: 'pending:7', nativeEntryId: 'pending:7', nativeEntryType: 'pending' });
  });

  it('updates tool calls through execution events', () => {
    let msgs = projectNativeSession(snap([msg('a', null, { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'bash', arguments: null }] })], 'a', ['a']));
    msgs = applyNativeMessageEvent(msgs, { type: 'tool_execution_start', toolCallId: 't', toolName: 'bash', args: { c: 1 } });
    expect(msgs[0].toolCalls?.[0]).toMatchObject({ status: 'running', arguments: { c: 1 } });
    msgs = applyNativeMessageEvent(msgs, { type: 'tool_execution_update', toolCallId: 't', partialResult: 'part' });
    expect(msgs[0].toolCalls?.[0]).toMatchObject({ status: 'running', result: 'part' });
    msgs = applyNativeMessageEvent(msgs, { type: 'tool_execution_end', toolCallId: 't', result: 'boom', isError: true });
    expect(msgs[0].toolCalls?.[0]).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('returns the same array when a tool event has no owner', () => {
    const msgs: Msgs = [];
    expect(applyNativeMessageEvent(msgs, { type: 'tool_execution_start', toolCallId: 'zz' })).toBe(msgs);
  });

  it('adds retry and compaction markers', () => {
    const retry = applyNativeMessageEvent([], { type: 'auto_retry_start' }, 4);
    expect(retry[0]).toMatchObject({ id: 'event:4', marker: 'retry' });
    const comp = applyNativeMessageEvent([], { type: 'compaction_start' }, 5);
    expect(comp[0]).toMatchObject({ id: 'event:5', marker: 'compaction' });
  });

  it('handles entry_appended', () => {
    const base = projectNativeSession(snap([msg('a', null, { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'x', arguments: null }] })], 'a', ['a']));
    const updated = applyNativeMessageEvent(base, { type: 'entry_appended', entry: msg('r', 'a', { role: 'toolResult', toolCallId: 't', content: 'done' }) });
    expect(updated[0].toolCalls?.[0]).toMatchObject({ status: 'completed', result: 'done' });
    const entry = user('n', 'a', 'new');
    const appended = applyNativeMessageEvent(base, { type: 'entry_appended', entry }, 9);
    expect(appended.map((m) => m.id)).toEqual(['a', 'n']);
    expect(applyNativeMessageEvent(appended, { type: 'entry_appended', entry })).toBe(appended);
  });

  it('appends custom messages only on message_end and honours display:false', () => {
    const custom = (display: Json): Json => ({ role: 'custom', customType: 'ext', content: 'hi', display });
    expect(applyNativeMessageEvent([], { type: 'message_start', message: custom(true) }, 1)).toEqual([]);
    expect(applyNativeMessageEvent([], { type: 'message_update', message: custom(true) }, 1)).toEqual([]);
    const out = applyNativeMessageEvent([], { type: 'message_end', message: custom(true) }, 2);
    expect(out[0]).toMatchObject({ role: 'system', customType: 'ext', content: 'hi' });
    expect(applyNativeMessageEvent([], { type: 'message_end', message: custom(false) }, 3)).toEqual([]);
  });

  it('turns an error-role message_end into an error message', () => {
    const out = applyNativeMessageEvent([], { type: 'message_end', message: { role: 'error', content: 'bad' } }, 6);
    expect(out[0]).toMatchObject({ id: 'event:6', role: 'error', content: 'bad' });
  });

  it('returns input unchanged for agent_end and non-record payloads', () => {
    const msgs: Msgs = [];
    expect(applyNativeMessageEvent(msgs, { type: 'agent_end' })).toBe(msgs);
    expect(applyNativeMessageEvent(msgs, 'text')).toBe(msgs);
    expect(applyNativeMessageEvent(msgs, null)).toBe(msgs);
  });
});
