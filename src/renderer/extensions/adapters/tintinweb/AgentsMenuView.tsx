import type { JSONValue } from '@earendil-works/pi-coding-agent';
import type { SemanticViewProps } from '../index';

// Pending producer support: showAgentsMenu currently uses native select(), not semantic state.
export function AgentsMenuView({ state, onAction }: SemanticViewProps) {
  const data = state !== null && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, JSONValue> : {};
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const breadcrumbs = Array.isArray(data.breadcrumbs) ? data.breadcrumbs.filter((crumb): crumb is string => typeof crumb === 'string') : [];
  return <section className="semantic-view agents-menu-view" aria-label="Agents menu">
    <header className="semantic-view-heading"><span className="extension-dialog-kicker">PI-SUBAGENTS</span><h2>Agents</h2></header>
    {breadcrumbs.length > 0 && <nav className="agents-menu-breadcrumbs" aria-label="Menu path">{breadcrumbs.map((crumb, index) => <span key={`${index}-${crumb}`}>{index > 0 && <span aria-hidden="true"> / </span>}{crumb}</span>)}</nav>}
    {sections.map((section, index) => {
      if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
      const entry = section as Record<string, JSONValue>;
      const options = Array.isArray(entry.options) ? entry.options : [];
      return <div className="agents-menu-section" key={index}><h3>{String(entry.label ?? '')}</h3>{options.map((option, optionIndex) => {
        if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
        const item = option as Record<string, JSONValue>;
        const id = typeof item.id === 'string' ? item.id : '';
        return <button type="button" className="extension-option" key={id || optionIndex} disabled={!id} onClick={() => { if (id) onAction({ type: 'select', id }); }}><span><strong>{String(item.label ?? '')}</strong>{typeof item.description === 'string' && <small>{item.description}</small>}</span><span aria-hidden="true">→</span></button>;
      })}</div>;
    })}
    <footer className="semantic-view-actions"><button type="button" className="extension-button extension-button-quiet" onClick={() => onAction({ type: 'cancel' })}>Cancel</button></footer>
  </section>;
}
