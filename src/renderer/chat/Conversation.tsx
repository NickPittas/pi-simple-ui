import { useEffect, useRef, useState } from 'react';
import type { SubagentRef } from './subagents';
import { Message, type ConversationMessageData } from './Message';

export type ConversationLifecycle = 'idle' | 'streaming' | 'compacting' | 'error';
export interface ConversationProps { readonly messages: readonly ConversationMessageData[]; readonly streamingEvent?: unknown; readonly lifecycle: ConversationLifecycle; readonly onOpenLink?: (url: string) => void; readonly onRemoveAttachment?: Parameters<typeof Message>[0]['onRemoveAttachment']; readonly onDownloadAttachment?: Parameters<typeof Message>[0]['onDownloadAttachment']; readonly toolsExpanded?: boolean; readonly onToolsExpandedChange?: (expanded: boolean) => void; readonly onOpenSubagent?: (ref: SubagentRef) => void }

export function Conversation({ messages, streamingEvent, lifecycle, onOpenLink, onRemoveAttachment, onDownloadAttachment, toolsExpanded = true, onToolsExpandedChange, onOpenSubagent }: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  useEffect(() => { if (pinned && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, streamingEvent, pinned]);
  const statuses: Record<ConversationLifecycle, string> = { idle: 'Ready', streaming: 'Generating response', compacting: 'Updating context', error: 'Conversation error' };
  return <section className="conversation-surface" aria-label="Conversation">
    <div className={`conversation-status conversation-status-${lifecycle}`} role="status">{statuses[lifecycle]}</div>
     <div ref={scrollRef} className="conversation-scroll" onScroll={(event) => { const node = event.currentTarget; setPinned(node.scrollHeight - node.scrollTop - node.clientHeight < 48); }}>
       {messages.length === 0 ? <div className="conversation-empty">No messages in this conversation.</div> : messages.map((message) => <Message key={message.id} message={message} onOpenLink={onOpenLink} onRemoveAttachment={onRemoveAttachment} onDownloadAttachment={onDownloadAttachment} toolsExpanded={toolsExpanded} onToolsExpandedChange={onToolsExpandedChange} onOpenSubagent={onOpenSubagent} />)}
    </div>
    {!pinned && <button className="conversation-jump-latest" type="button" onClick={() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; setPinned(true); }}>Jump to latest</button>}
  </section>;
}
