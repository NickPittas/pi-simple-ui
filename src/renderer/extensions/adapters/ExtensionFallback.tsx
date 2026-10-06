import type { SemanticViewProps } from './index';
import type { JSONValue } from '@earendil-works/pi-coding-agent';

export function ExtensionFallback({ viewId, version, ownerId, state, onAction }: SemanticViewProps) {
  const stateRecord = state !== null && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, JSONValue>
    : null;
  const cancelActionId = typeof stateRecord?.cancelActionId === 'string' ? stateRecord.cancelActionId : null;
  return <section className="semantic-view extension-fallback" aria-label="Unsupported extension view">
    <header><span className="extension-dialog-kicker">UNSUPPORTED VIEW</span><h2>{viewId} <small>v{version}</small></h2><p>Owner: {ownerId}</p></header>
    <p className="extension-host-note">This view has no graphical adapter yet. Its state is shown read-only.</p>
    <pre aria-label="View state">{JSON.stringify(state, null, 2)}</pre>
    {cancelActionId && <button className="extension-button extension-button-quiet" onClick={() => onAction({ type: 'cancel', id: cancelActionId })}>Close</button>}
  </section>;
}
