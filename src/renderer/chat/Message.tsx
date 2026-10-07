import { useState } from 'react';
import { SafeMarkdown, type MessageSegment, renderMessageSegments } from '../security/SafeMarkdown';
import { subagentRef, type SubagentRef } from './subagents';
import { AttachmentPreview, type AttachmentDescriptor } from '../security/AttachmentPreview';

export type ConversationMessageRole = 'user' | 'assistant' | 'thinking' | 'tool' | 'tool-result' | 'error' | 'system';
export interface ToolCall { readonly name: string; readonly arguments: unknown; readonly status: 'running' | 'completed' | 'error'; readonly result?: string; readonly error?: string; readonly toolCallId?: string; readonly details?: unknown }
export interface ConversationMessageData {
  readonly id: string; readonly role: ConversationMessageRole; readonly content?: string; readonly segments?: readonly MessageSegment[];
  readonly timestamp?: number | string; readonly streaming?: boolean; readonly toolCalls?: readonly ToolCall[];
  readonly attachments?: readonly AttachmentDescriptor[]; readonly marker?: 'compaction' | 'retry'; readonly markerText?: string; readonly customType?: string;
  readonly level?: 'info' | 'warning' | 'error';
}
export interface MessageProps { readonly message: ConversationMessageData; readonly onOpenLink?: (url: string) => void; readonly onRemoveAttachment?: (attachment: AttachmentDescriptor) => void; readonly onDownloadAttachment?: (attachment: AttachmentDescriptor) => void; readonly toolsExpanded?: boolean; readonly onToolsExpandedChange?: (expanded: boolean) => void; readonly onOpenSubagent?: (ref: SubagentRef) => void }

const ROLE_BADGES: Record<ConversationMessageRole, { readonly label: string; readonly icon: string }> = {
  user: { label: 'You', icon: '\uf007' },
  assistant: { label: 'Assistant', icon: '\u{f06a9}' },
  thinking: { label: 'Thinking', icon: '\u{f09d1}' },
  tool: { label: 'Tool', icon: '\uf0ad' },
  'tool-result': { label: 'Tool result', icon: '\uf00c' },
  error: { label: 'Error', icon: '\uf06a' },
  system: { label: 'System', icon: '\uf013' },
};

export function Message({ message, onOpenLink, onRemoveAttachment, onDownloadAttachment, toolsExpanded = true, onToolsExpandedChange, onOpenSubagent }: MessageProps) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const isThinking = message.role === 'thinking';
  const time = typeof message.timestamp === 'number' ? new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : message.timestamp;
  return <article className={`chat-message chat-message-${message.role}${message.customType === 'command-notice' ? ` chat-notice chat-notice-${message.level ?? 'info'}` : ''}`} data-message-id={message.id}>
    {message.marker && <div className={`chat-message-marker chat-marker-${message.marker}`} role="note">{message.markerText ?? (message.marker === 'compaction' ? 'Earlier context compacted' : 'Response retried')}</div>}
    <header className="chat-message-meta"><span className="chat-role-badge"><span className="chat-role-icon" aria-hidden="true">{ROLE_BADGES[message.role].icon}</span>{message.customType === 'command-notice' ? 'Command' : message.customType !== undefined ? (/subagent/i.test(message.customType) ? 'Subagent' : 'Extension') : ROLE_BADGES[message.role].label}</span>{time && <time>{time}</time>}</header>
    {isThinking ? <><button className="chat-thinking-toggle" type="button" aria-expanded={thinkingOpen} onClick={() => setThinkingOpen((open) => !open)}><span className="chat-toggle-chevron" aria-hidden="true">{thinkingOpen ? '\uf078' : '\uf054'}</span> {thinkingOpen ? 'Hide' : 'Show'} reasoning</button>{thinkingOpen && <div className="chat-thinking-body"><SafeMarkdown source={message.content ?? ''} onOpenLink={onOpenLink} collapsedLines={32} /></div>}</> : message.segments ? renderMessageSegments(message.segments, onOpenLink) : message.content && <SafeMarkdown source={message.content} onOpenLink={onOpenLink} collapsedLines={message.role === 'assistant' ? 120 : 32} />}
    {message.toolCalls?.length ? <><button type="button" className="chat-tools-toggle" aria-expanded={toolsExpanded} onClick={() => onToolsExpandedChange?.(!toolsExpanded)}>{toolsExpanded ? 'Hide' : 'Show'} tool details ({message.toolCalls.length})</button>{toolsExpanded && message.toolCalls.map((tool, index) => <section className={`chat-tool-call chat-tool-${tool.status}`} key={tool.toolCallId ?? `${tool.name}-${index}`}>
      <header><strong><span className="chat-role-icon" aria-hidden="true">{'\uf0ad'}</span> {tool.name}</strong><span className="chat-tool-status">{tool.status}</span>{onOpenSubagent && (() => { const ref = subagentRef(tool); return ref ? <button type="button" className="chat-subagent-open" onClick={() => onOpenSubagent(ref)}><span className="chat-role-icon" aria-hidden="true">{'\uf0c0'}</span> View conversation</button> : null; })()}</header><pre className="chat-tool-arguments">{JSON.stringify(tool.arguments, null, 2)}</pre>
      {tool.error !== undefined && <pre className="chat-tool-error" role="alert">{tool.error}</pre>}{tool.result !== undefined && <pre className="chat-tool-result">{tool.result}</pre>}
    </section>)}</> : null}
    {message.attachments?.map((attachment) => <AttachmentPreview key={`${attachment.name}:${attachment.byteLength}`} attachment={attachment} onRemove={onRemoveAttachment ? () => onRemoveAttachment(attachment) : undefined} onDownload={onDownloadAttachment} />)}
    {message.streaming && <span className="chat-streaming-caret" aria-label="Response in progress" />}
  </article>;
}
