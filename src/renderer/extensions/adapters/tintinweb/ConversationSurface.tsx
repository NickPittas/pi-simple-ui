import { useState } from 'react';
import type { JSONValue } from '@earendil-works/pi-coding-agent';
import type { SemanticViewProps } from '../index';

// Pending producer support: this surface is registered, but no conversation semantic view is emitted yet.
export function ConversationSurface({ state, onAction }: SemanticViewProps) {
  const data = state !== null && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, JSONValue> : {};
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const agentId = typeof data.agentId === 'string' ? data.agentId : '';
  const running = data.running === true;
  const [steerOpen, setSteerOpen] = useState(false);
  const [message, setMessage] = useState('');
  return <section className="semantic-view conversation-surface" aria-label="Agent conversation">
    {typeof data.title === 'string' && <header className="semantic-view-heading"><span className="extension-dialog-kicker">AGENT SESSION · {agentId}</span><h2>{data.title}</h2></header>}
    <div className="conversation-messages">{entries.map((entryValue, index) => {
      if (!entryValue || typeof entryValue !== 'object' || Array.isArray(entryValue)) return null;
      const entry = entryValue as Record<string, JSONValue>;
      const kind = typeof entry.kind === 'string' ? entry.kind : 'entry';
      return <article className={`conversation-message conversation-${kind}`} key={String(entry.id ?? index)}><span className="conversation-role">{kind}{typeof entry.toolName === 'string' ? ` · ${entry.toolName}` : ''}</span>
        {typeof entry.text === 'string' && <p>{entry.text}</p>}{entry.args !== undefined && <pre>{JSON.stringify(entry.args, null, 2)}</pre>}{entry.result !== undefined && <pre className={entry.isError === true ? 'conversation-entry-error' : undefined}>{typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result, null, 2)}</pre>}
        {typeof entry.timestamp === 'number' && <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
      </article>;
    })}</div>
    <footer className="semantic-view-actions">{data.canSteer === true && <button type="button" className="extension-button extension-button-quiet" aria-expanded={steerOpen} aria-controls={`conversation-steer-${agentId}`} onClick={() => setSteerOpen((open) => !open)}>Steer</button>}{data.canAbort === true && running && <button type="button" className="extension-button extension-button-quiet" onClick={() => onAction({ type: 'abort' })}>Abort</button>}<button type="button" className="extension-button extension-button-quiet" onClick={() => onAction({ type: 'close' })}>Close</button></footer>
    {steerOpen && <form id={`conversation-steer-${agentId}`} className="fleet-steer-form" onSubmit={(event) => { event.preventDefault(); const value = message.trim(); if (value) { onAction({ type: 'steer', message: value }); setMessage(''); setSteerOpen(false); } }}><label htmlFor={`conversation-steer-input-${agentId}`}>Steering message</label><input id={`conversation-steer-input-${agentId}`} autoFocus value={message} onChange={(event) => setMessage(event.target.value)} /><button type="submit" className="extension-button extension-button-primary" disabled={!message.trim()}>Send</button></form>}
  </section>;
}
