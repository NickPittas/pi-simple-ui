import { useState } from 'react';
import type { JSONValue } from '@earendil-works/pi-coding-agent';
import type { SemanticViewProps } from '../index';

function asRecord(value: JSONValue): Record<string, JSONValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JSONValue> : null;
}
function relativeTime(value: JSONValue | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  return seconds < 60 ? 'just now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
}

export function FleetView({ state, onAction }: SemanticViewProps) {
  const [steering, setSteering] = useState<string | null>(null);
  const [confirmAbort, setConfirmAbort] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const data = asRecord(state);
  const agents = Array.isArray(data?.agents) ? data.agents.map(asRecord).filter((agent): agent is Record<string, JSONValue> => agent !== null) : [];
  return <section className="semantic-view fleet-view" aria-label="Subagent fleet">
    <header className="semantic-view-heading fleet-heading"><div><span className="extension-dialog-kicker">PI-SUBAGENTS</span><h2>Agent fleet</h2></div><button className="extension-button extension-button-quiet" type="button" onClick={() => onAction({ type: 'refresh' })}>Refresh</button></header>
    {agents.length === 0 ? <p className="fleet-empty">No agents are currently in the fleet.</p> : <div className="fleet-list">{agents.map((agent, index) => {
      const id = typeof agent.id === 'string' ? agent.id : `agent-${index}`;
      const status = typeof agent.status === 'string' ? agent.status : 'unknown';
      const isRunning = status === 'running' || status === 'queued';
      return <article className="fleet-row" key={id}>
        <span className={`fleet-status fleet-status-${status}`} aria-label={`Status: ${status}`} title={status} />
        <div className="fleet-agent-copy"><strong>{String(agent.name ?? id)}</strong><span>{String(agent.type ?? 'Agent')} · {status}</span>
          {typeof agent.activity === 'string' && <p>{agent.activity}</p>}
          {agent.startedAt !== undefined && <small>Started {relativeTime(agent.startedAt)}</small>}
        </div>
        <div className="fleet-actions">{isRunning && <>
          {confirmAbort === id ? <div role="group" aria-label={`Confirm abort ${String(agent.name ?? id)}`} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setConfirmAbort(null); } }}><span className="fleet-confirm-label">Abort this agent?</span><button className="extension-button extension-button-quiet" type="button" onClick={() => { onAction({ type: 'abort', agentId: id }); setConfirmAbort(null); }}>Confirm abort</button><button className="extension-button extension-button-quiet" type="button" onClick={() => setConfirmAbort(null)}>Keep running</button></div> : <button className="extension-button extension-button-quiet" type="button" onClick={() => setConfirmAbort(id)}>Abort</button>}
          <button className="extension-button extension-button-quiet" type="button" aria-expanded={steering === id} aria-controls={`fleet-steer-${id}`} onClick={() => { setSteering(steering === id ? null : id); setMessage(''); }}>Steer</button>
        </>}</div>
        {steering === id && <form id={`fleet-steer-${id}`} className="fleet-steer-form" onSubmit={(event) => { event.preventDefault(); const trimmed = message.trim(); if (!trimmed) return; onAction({ type: 'steer', agentId: id, message: trimmed }); setSteering(null); setMessage(''); }}>
          <label htmlFor={`fleet-steer-${id}`}>Message for {String(agent.name ?? id)}</label><input id={`fleet-steer-${id}`} autoFocus value={message} onChange={(event) => setMessage(event.target.value)} />
          <button className="extension-button extension-button-primary" type="submit" disabled={!message.trim()}>Send steer</button><button className="extension-button extension-button-quiet" type="button" onClick={() => setSteering(null)}>Cancel</button>
        </form>}
      </article>;
    })}</div>}
  </section>;
}
