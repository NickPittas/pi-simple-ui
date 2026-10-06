import type { JSONValue } from '@earendil-works/pi-coding-agent';
import type { SemanticViewProps } from '../index';

function asRecord(value: JSONValue): Record<string, JSONValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JSONValue> : null;
}

export function WorkflowsView({ state, onAction }: SemanticViewProps) {
  const data = asRecord(state);
  const saved = Array.isArray(data?.workflows) ? data.workflows.map(asRecord).filter((item): item is Record<string, JSONValue> => item !== null) : [];
  const running = Array.isArray(data?.running) ? data.running.map(asRecord).filter((item): item is Record<string, JSONValue> => item !== null) : [];
  const notices = Array.isArray(data?.notifications) ? data.notifications.filter((note): note is string => typeof note === 'string') : [];
  const invoke = (type: string, id: JSONValue) => onAction({ type, workflowId: id });
  return <section className="semantic-view workflows-view" aria-label="Workflows">
    <header className="semantic-view-heading"><span className="extension-dialog-kicker">PI-SUBAGENTS</span><h2>Workflows</h2></header>
    {notices.map((notice, index) => <p className="workflow-notice" role="status" key={`${index}-${notice}`}>{notice}</p>)}
    <section className="workflow-group" aria-labelledby="workflow-saved-heading"><h3 id="workflow-saved-heading">Saved workflows</h3>
      {saved.length === 0 ? <p className="workflow-empty">No saved workflows.</p> : saved.map((item, index) => {
        const id = item.id ?? `workflow-${index}`;
        return <article className="workflow-row" key={String(id)}><div className="workflow-copy"><strong>{String(item.name ?? 'Untitled workflow')}</strong>{typeof item.description === 'string' && <p>{item.description}</p>}{typeof item.stepCount === 'number' && <small>{item.stepCount} steps</small>}</div><div className="workflow-actions">
          <button type="button" className="extension-button extension-button-quiet" onClick={() => invoke('open', id)}>Open</button><button type="button" className="extension-button extension-button-primary" onClick={() => invoke('run', id)}>Run</button><button type="button" className="extension-button extension-button-quiet" onClick={() => invoke('edit', id)}>Edit</button><button type="button" className="extension-button extension-button-quiet" onClick={() => invoke('delete', id)}>Delete</button>
        </div></article>;
      })}
    </section>
    <section className="workflow-group" aria-labelledby="workflow-running-heading"><h3 id="workflow-running-heading">Running</h3>
      {running.length === 0 ? <p className="workflow-empty">No workflows are running.</p> : running.map((item, index) => {
        const id = item.id ?? `running-${index}`;
        return <article className="workflow-row" key={String(id)}><div className="workflow-copy"><strong>{String(item.name ?? id)}</strong>{typeof item.description === 'string' && <p>{item.description}</p>}{typeof item.status === 'string' && <small>{item.status}</small>}</div><button type="button" className="extension-button extension-button-quiet" onClick={() => invoke('cancel', id)}>Cancel</button></article>;
      })}
    </section>
  </section>;
}
