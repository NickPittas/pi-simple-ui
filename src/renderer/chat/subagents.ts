import type { ConversationMessageData, ToolCall } from './Message.tsx';

export type SubagentState = 'running' | 'finished' | 'failed' | 'unknown';
export interface SubagentRef { readonly file: string; readonly label: string; readonly agentType: string | null; readonly status: ToolCall['status']; readonly state: SubagentState }

/*
 * Per-subagent state. Background runs complete their parent TOOL CALL immediately, so tool status alone is not "finished".
 * Precedence: (1) explicit details status, (2) later completion message in the conversation, (3) parent tool status.
 * pi-herdr-agents (pi-extension/subagents/index.ts):
 *   - async `subagent` returns details.status === 'started' (SubagentStartedDetails ~1217, returned ~3633) -> 'unknown' (background).
 *   - sync/resume results are SubagentResultDetails (~1179-1195): exitCode===0 && no error/errorMessage -> 'finished', else 'failed' (same rule as renderer ~4480-4484, 2934, 4091).
 *   - details.status 'failed' (~2060) -> failed; 'stopped' (~3497) -> failed.
 *   - completion later arrives as a `subagent_result` custom message whose text has `Session: <file>` and `Sub-agent "x" completed (` / `failed (exit code` / `(provider/agent error)` (~1305, 1329-1331).
 * @tintinweb/pi-subagents (src/index.ts, AgentDetails in src/ui/agent-widget.ts:66-88):
 *   - details.status: queued|running -> running; completed -> finished; steered -> finished (turn-limit wrap-up); error|aborted|stopped -> failed; background -> unknown (~2016, 2122).
 *   - completion later arrives as a `subagent-notification` message (~479-520, formatTaskNotification ~171-196) with `<output-file>FILE</output-file>` and `<status>Done|Error: ..|Aborted ..|Wrapped up ..|Stopped</status>` (getStatusLabel ~160-167).
 * Parent tool status fallback: running -> running, error -> failed, completed -> 'finished' only for non-background tools, else 'unknown'.
 */
const EXPLICIT_STATE: Record<string, SubagentState> = {
  queued: 'running', running: 'running', completed: 'finished', steered: 'finished', error: 'failed', aborted: 'failed', stopped: 'failed', failed: 'failed', background: 'unknown', started: 'unknown'
};
const isBackground = (tool: ToolCall, details: Record<string, unknown> | null): boolean => {
  const args = record(tool.arguments);
  return details?.status === 'started' || details?.status === 'background' || args?.run_in_background === true || args?.async === true;
};
function toolState(tool: ToolCall): SubagentState {
  const details = record(tool.details);
  if (tool.status === 'error') return 'failed';
  const explicit = typeof details?.status === 'string' ? EXPLICIT_STATE[details.status] : undefined;
  if (explicit) return explicit;
  if (tool.status === 'running') return 'running';
  if (details && (typeof details.exitCode === 'number' || text(details.errorMessage) || text(details.error))) return details.exitCode === 0 && !text(details.errorMessage) && !text(details.error) ? 'finished' : 'failed';
  return isBackground(tool, details) ? 'unknown' : 'finished';
}
/** Completion messages observed in the conversation text, keyed by transcript file. Best effort; only runs on message content. */
function completionSignals(messages: readonly ConversationMessageData[]): Map<string, SubagentState> {
  const out = new Map<string, SubagentState>();
  for (const message of messages) {
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content) continue;
    for (const match of content.matchAll(/<output-file>([^<]+)<\/output-file>\s*<status>([^<]*)<\/status>/g)) {
      const status = match[2]!.trim();
      out.set(match[1]!.trim(), /^(Done|Wrapped up)/.test(status) ? 'finished' : 'failed');
    }
    const session = /^Session: (\S+)$/m.exec(content);
    if (session) {
      if (/Sub-agent "[^"\n]*" completed \(/.test(content)) out.set(session[1]!, 'finished');
      else if (/Sub-agent "[^"\n]*" failed \(exit code|\(provider\/agent error\)/.test(content)) out.set(session[1]!, 'failed');
    }
  }
  return out;
}

const SUBAGENT_TOOLS = new Set(['Agent', 'subagent', 'subagent_resume', 'subagent_send']);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const truncate = (value: string, max = 80): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const isAbsoluteTranscript = (value: string): boolean => (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) && /\.(jsonl|output)$/.test(value);

/** Read-only detection: a subagent session is only referenced when the tool result itself reports a transcript path. */
export function subagentRef(tool: ToolCall): SubagentRef | null {
  if (!SUBAGENT_TOOLS.has(tool.name)) return null;
  const details = record(tool.details);
  const args = record(tool.arguments);
  const file = [text(details?.sessionFile), text(details?.outputFile)].find((candidate): candidate is string => candidate !== null && isAbsoluteTranscript(candidate)) ?? null;
  if (!file) return null;
  const task = text(details?.task) ?? text(args?.task);
  const label = text(details?.description) ?? text(args?.description) ?? text(details?.name) ?? text(args?.name) ?? (task ? truncate(task) : null) ?? tool.name;
  const agentType = text(details?.subagent_type) ?? text(details?.agent) ?? text(args?.subagent_type) ?? text(args?.agent);
  return { file, label, agentType, status: tool.status, state: toolState(tool) };
}

export function collectSubagents(messages: readonly ConversationMessageData[]): SubagentRef[] {
  const byFile = new Map<string, SubagentRef>();
  const signals = completionSignals(messages);
  for (const message of messages) for (const tool of message.toolCalls ?? []) {
    const ref = subagentRef(tool);
    if (ref) byFile.set(ref.file, byFile.has(ref.file) ? { ...ref, label: byFile.get(ref.file)!.label, agentType: byFile.get(ref.file)!.agentType ?? ref.agentType } : ref);
  }
  return [...byFile.values()].map((ref) => { const signal = signals.get(ref.file); return signal && ref.state !== 'failed' ? { ...ref, state: signal } : ref; });
}
