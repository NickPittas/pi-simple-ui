import type { ConversationMessageData, ToolCall } from './Message.tsx';
import type { Json, NativePiSessionSnapshot } from '../../shared/native-pi.ts';

type RecordJson = { [key: string]: Json };
type NativeToolCall = ToolCall & { readonly id: string };
type NativeConversationMessage = ConversationMessageData & {
  readonly raw: Json;
  readonly nativeEntryType: string;
  readonly nativeEntryId: string;
  readonly toolCalls?: readonly NativeToolCall[];
};

const isRecord = (value: Json): value is RecordJson => typeof value === 'object' && value !== null && !Array.isArray(value);
const detailsOf = (value: Json | undefined): { readonly details?: Json } => isRecord(value ?? null) && (value as RecordJson).details !== undefined ? { details: (value as RecordJson).details } : {};
const textOf = (value: Json): string => {
  if (typeof value === 'string') return value;
  const blocks = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.content) ? value.content : [];
  const text = blocks.flatMap((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []);
  if (text.length) return text.join('\n');
  return value === null ? '' : `Structured content: ${JSON.stringify(value)}`;
};

export function projectNativeSession(
  snapshot: NativePiSessionSnapshot,
  opts?: { activeBranchOnly?: boolean },
): NativeConversationMessage[] {
  const entries = new Map<string, RecordJson>();
  for (const value of snapshot.entries) {
    if (isRecord(value) && typeof value.id === 'string') entries.set(value.id, value);
  }

  const allowed = new Set(snapshot.activeBranch ?? []);
  const chain: RecordJson[] = [];
  const seen = new Set<string>();
  let id = snapshot.activeLeaf;
  while (id && !seen.has(id) && (opts?.activeBranchOnly === false || allowed.has(id))) {
    const entry = entries.get(id);
    if (!entry) break;
    seen.add(id);
    chain.push(entry);
    id = typeof entry.parentId === 'string' ? entry.parentId : null;
  }
  chain.reverse();
  const results = new Map<string, Json>();
  for (const entry of chain) {
    const message = entry.message;
    if (entry.type === 'message' && isRecord(message) && message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      results.set(message.toolCallId, message);
    }
  }

  const projected: NativeConversationMessage[] = [];
  const emitted = new Set<RecordJson>();
  const push = (entry: RecordJson, suffix: string, role: ConversationMessageData['role'], content: string, extra: Partial<NativeConversationMessage> = {}) => {
    const nativeId = typeof entry.id === 'string' ? entry.id : 'unknown';
    const messageId = emitted.has(entry) ? `${nativeId}:${suffix}` : nativeId;
    emitted.add(entry);
    projected.push({ id: messageId, role, content, raw: entry, nativeEntryId: nativeId, nativeEntryType: typeof entry.type === 'string' ? entry.type : 'unknown', ...(typeof entry.timestamp === 'string' || typeof entry.timestamp === 'number' ? { timestamp: entry.timestamp } : {}), ...extra });
  };

  for (const entry of chain) {
    const kind = typeof entry.type === 'string' ? entry.type : 'unknown';
    if (kind === 'message' && isRecord(entry.message)) {
      const native = entry.message;
      if (native.role === 'toolResult') {
        push(entry, '', 'tool-result', textOf(native.content ?? null));
        continue;
      }
      const role = native.role === 'user' ? 'user' : native.role === 'assistant' ? 'assistant' : native.role === 'system' ? 'system' : native.role === 'error' ? 'error' : null;
      const blocks = Array.isArray(native.content) ? native.content : typeof native.content === 'string' ? [{ type: 'text', text: native.content } as Json] : [];
      let index = 0;
      for (const block of blocks) {
        if (!isRecord(block)) {
          push(entry, `unknown:${index++}`, 'system', `Unknown content block: ${textOf(block)}`);
          continue;
        }
        if (block.type === 'text' && typeof block.text === 'string') push(entry, `text:${index++}`, role ?? 'system', block.text);
        else if (block.type === 'thinking' && typeof block.thinking === 'string') push(entry, `thinking:${index++}`, 'thinking', block.thinking);
        else if (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
          const result = results.get(block.id);
          const tool: NativeToolCall = { id: block.id, toolCallId: block.id, name: block.name, arguments: block.arguments ?? null, status: result === undefined ? 'running' : isRecord(result) && result.isError === true ? 'error' : 'completed', ...(result === undefined ? {} : { result: textOf(isRecord(result) && result.content !== undefined ? result.content : result), ...detailsOf(result) }) };
          push(entry, `tool:${index++}`, 'assistant', '', { toolCalls: [tool] });
        } else push(entry, `unknown:${index++}`, 'system', `Unsupported content (${String(block.type ?? 'missing')}): ${textOf(block)}`);
      }
      if (!blocks.length && role) push(entry, '', role, typeof native.content === 'string' ? native.content : role === 'error' ? textOf(native.errorMessage ?? native.message ?? native) : '');
      if (!role && !blocks.length) push(entry, '', 'system', `Unknown message role "${String(native.role ?? 'missing')}"`);
      continue;
    }
    if (kind === 'custom_message') {
      if (entry.display === false || typeof entry.customType !== 'string') continue;
      push(entry, '', 'system', textOf(entry.content ?? null), { customType: entry.customType });
    } else if (kind === 'compaction') push(entry, '', 'system', `Earlier context compacted${typeof entry.summary === 'string' ? `: ${entry.summary}` : ''}`, { marker: 'compaction', markerText: 'Earlier context compacted' });
    else if (kind === 'usage') push(entry, '', 'system', `Usage${typeof entry.kind === 'string' ? ` (${entry.kind})` : ''}: ${textOf(entry.usage ?? null)}`);
    else push(entry, '', 'system', `Native session entry: ${kind}`);
  }
  if (snapshot.partial && isRecord(snapshot.partial)) {
    const partial = snapshot.partial;
    const partialId = typeof partial.id === 'string' ? partial.id : 'partial';
    const persisted = chain.some((entry) => isRecord(entry.message) && (entry.message.id === partialId
      || (typeof partial.id !== 'string' && typeof partial.role === 'string' && partial.content !== undefined && entry.message.role === partial.role
        && JSON.stringify(entry.message.content) === JSON.stringify(partial.content))));
    if (!persisted) {
      const partialEntryId = `pending:${partialId}`;
      const partialEntry = { id: partialEntryId, type: 'message', message: partial } as RecordJson;
      projected.push(...projectNativeSession({ ...snapshot, entries: [partialEntry], activeLeaf: partialEntryId, activeBranch: [partialEntryId], partial: null }).map((message) => ({ ...message, id: `${partialEntryId}${message.id === partialEntryId ? '' : `:${message.id}`}`, nativeEntryId: partialEntryId, nativeEntryType: 'pending', streaming: true })));
    }
  }
  return projected;
}

export function applyNativeMessageEvent(messages: NativeConversationMessage[], payload: Json, seq?: number): NativeConversationMessage[] {
  if (!isRecord(payload)) return messages;
  const type = payload.type;
  const toolId = typeof payload.toolCallId === 'string' ? payload.toolCallId : null;
  if (typeof type === 'string' && toolId && ['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(type)) {
    const owner = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.toolCalls?.some(tool => tool.toolCallId === toolId)).at(-1)
      ?? messages.map((message, index) => ({ message, index })).filter(({ message }) => message.nativeEntryType === 'pending').at(-1);
    if (!owner) return messages;
    const current = owner.message;
    const tools = [...(current.toolCalls ?? [])];
    const index = tools.findIndex(tool => tool.toolCallId === toolId);
    const old = index < 0 ? null : tools[index];
    const result = type === 'tool_execution_update' ? payload.partialResult : type === 'tool_execution_end' ? payload.result : undefined;
    const error = type === 'tool_execution_end' && payload.isError === true;
    const tool: NativeToolCall = { id: toolId, toolCallId: toolId, name: typeof payload.toolName === 'string' ? payload.toolName : old?.name ?? 'tool', arguments: payload.args ?? old?.arguments ?? null, status: type === 'tool_execution_end' ? error ? 'error' : 'completed' : 'running', ...(result === undefined ? { ...(old?.result ? { result: old.result } : {}), ...(old?.details !== undefined ? { details: old.details } : {}) } : { result: textOf(result), ...detailsOf(result) }), ...(error ? { error: typeof result === 'string' ? result : 'Tool failed' } : {}) };
    if (index < 0) tools.push(tool); else tools[index] = tool;
    return messages.map((message, i) => i === owner.index ? { ...message, toolCalls: tools } : message);
  }
  if (type === 'agent_end') return messages;
  if (typeof type === 'string' && ['auto_retry_start', 'auto_retry_end', 'summarization_retry_scheduled', 'summarization_retry_attempt_start', 'summarization_retry_finished'].includes(type)) return [...messages, { id: `event:${seq ?? messages.length}`, role: 'system', content: `Retry: ${type}`, raw: payload, nativeEntryId: `event:${seq ?? messages.length}`, nativeEntryType: type, marker: 'retry', markerText: 'Response retried' }];
  if (type === 'compaction_start' || type === 'compaction_end') return [...messages, { id: `event:${seq ?? messages.length}`, role: 'system', content: 'Earlier context compacted', raw: payload, nativeEntryId: `event:${seq ?? messages.length}`, nativeEntryType: 'compaction', marker: 'compaction', markerText: 'Earlier context compacted' }];
  if (type === 'entry_appended' && isRecord(payload.entry)) {
    const entry = payload.entry;
    if (entry.type === 'message' && isRecord(entry.message) && entry.message.role === 'toolResult' && typeof entry.message.toolCallId === 'string') {
      const nativeResult = entry.message;
      const result = textOf(nativeResult.content ?? null);
      return messages.map(message => ({ ...message, toolCalls: message.toolCalls?.map(tool => tool.toolCallId === nativeResult.toolCallId ? { ...tool, status: nativeResult.isError === true ? 'error' : 'completed', result, ...detailsOf(nativeResult), ...(nativeResult.isError === true ? { error: result } : {}) } : tool) as NativeToolCall[] | undefined }));
    }
    if (entry.type === 'usage' || entry.type === 'compaction' || (entry.type === 'message' && isRecord(entry.message))) {
      if (typeof entry.id === 'string' && messages.some(message => message.nativeEntryId === entry.id)) return messages;
      const id = typeof entry.id === 'string' ? entry.id : `event:${seq ?? messages.length}`;
      return [...messages, ...projectNativeSession({ sessionId: '', sessionGeneration: 0, name: null, file: null, cwd: null, classification: 'unknown', parentSessionId: null, entries: [entry], activeLeaf: id, activeBranch: [id], partial: null, metadata: null })];
    }
  }
  if (isRecord(payload.message) && payload.message.role === 'custom' && ['message_start', 'message_update', 'message_end'].includes(String(type))) {
    // Extension custom messages carry no id and are already complete; append once on message_end (a later snapshot reconciles with the persisted entry).
    if (type !== 'message_end') return messages;
    const native = payload.message;
    const id = `event:${seq ?? messages.length}`;
    return [...messages, ...projectNativeSession({ sessionId: '', sessionGeneration: 0, name: null, file: null, cwd: null, classification: 'unknown', parentSessionId: null, entries: [{ id, type: 'custom_message', customType: native.customType ?? null, content: native.content ?? null, display: native.display, timestamp: native.timestamp ?? null } as RecordJson], activeLeaf: id, activeBranch: [id], partial: null, metadata: null })];
  }
  if (type === 'message_end' && isRecord(payload.message) && payload.message.role === 'error') {
    const native = isRecord(payload.message) ? payload.message : payload;
    return [...messages, { id: `event:${seq ?? messages.length}`, role: 'error', content: textOf(native.content ?? native.error ?? native), raw: payload, nativeEntryId: `event:${seq ?? messages.length}`, nativeEntryType: 'error' }];
  }
  if (!isRecord(payload.message) || !['message_start', 'message_update', 'message_end'].includes(String(type))) return messages;
  const native = payload.message;
  const nativeId = typeof native.id === 'string' ? native.id : null;
  // ID-keyed matching is primary; this last-pending fallback assumes Pi has at most one anonymous assistant message in flight per turn.
  // If violated, it misattributes updates/ends; callers with multi-message concurrency must key by native id.
  let pending: NativeConversationMessage | undefined;
  for (const message of messages) if (message.nativeEntryType === 'pending') pending = message;
  const nextSeq = seq ?? messages.reduce((max, message) => message.id.startsWith('pending:') ? Math.max(max, Number(message.id.slice(8)) + 1) : max, 0);
  const key = payload.type === 'message_start' ? nativeId ?? `pending:${nextSeq}` : messages.find(message => message.nativeEntryType === 'pending' && message.nativeEntryId === nativeId)?.nativeEntryId ?? pending?.nativeEntryId ?? nativeId;
  if (!key) return messages;
  const entry = { id: key, type: 'message', message: native } as Json;
  const projected = projectNativeSession({ sessionId: '', sessionGeneration: 0, name: null, file: null, cwd: null, classification: 'unknown', parentSessionId: null, entries: [entry], activeLeaf: key, activeBranch: [key], partial: null, metadata: null });
  const replacement = payload.type === 'message_end' ? projected.map(message => ({ ...message, id: nativeId ?? message.id, raw: native, nativeEntryId: key })) : projected.map((message, index) => ({ ...message, id: index ? `${key}:${index}` : key, raw: native, nativeEntryType: 'pending', streaming: true }));
  const withoutPending = messages.filter(message => payload.type === 'message_end' ? message.nativeEntryId !== key : message.nativeEntryType !== 'pending' || message.nativeEntryId !== key);
  return [...withoutPending, ...replacement];
}
