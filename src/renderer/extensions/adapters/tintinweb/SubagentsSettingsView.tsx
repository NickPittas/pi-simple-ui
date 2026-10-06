import type { JSONValue } from '@earendil-works/pi-coding-agent';
import type { SemanticViewProps } from '../index';

interface Item { id: string; label: string; description?: string; currentValue: JSONValue; values?: JSONValue[] }
function record(value: JSONValue): Record<string, JSONValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JSONValue> : null;
}

export function SubagentsSettingsView({ state, onAction }: SemanticViewProps) {
  const data = record(state);
  const items = Array.isArray(data?.items) ? data.items.map(record).filter((item): item is Record<string, JSONValue> => item !== null) : [];
  const title = typeof data?.title === 'string' ? data.title : 'Subagent Settings';
  return <section className="semantic-view settings-view" aria-label={title}>
    <header className="semantic-view-heading"><span className="extension-dialog-kicker">PI-SUBAGENTS</span><h2>{title}</h2></header>
    <div className="settings-rows">{items.map((raw) => {
      const item = raw as unknown as Partial<Item>;
      if (typeof item.id !== 'string' || typeof item.label !== 'string') return null;
      const itemId = item.id;
      const itemLabel = item.label;
      return <div className="settings-row" key={item.id}><div className="settings-copy"><strong>{item.label}</strong>{item.description && <p>{item.description}</p>}</div>
        {Array.isArray(item.values) && <select aria-label={itemLabel} value={String(item.currentValue ?? '')} onChange={(event) => onAction({ type: 'set', id: itemId, value: event.target.value } as JSONValue)}>
          {item.values.map((value) => <option key={String(value)} value={String(value)}>{String(value)}</option>)}
        </select>}
        {!Array.isArray(item.values) && <><span className="settings-value">{String(item.currentValue ?? '')}</span><button type="button" className="extension-button extension-button-quiet" onClick={() => onAction({ type: 'edit', fieldId: itemId } as JSONValue)}>Edit</button></>}
      </div>;
    })}</div>
    <footer className="semantic-view-actions"><button type="button" className="extension-button extension-button-quiet" onClick={() => onAction({ type: 'cancel' })}>Close</button></footer>
  </section>;
}
