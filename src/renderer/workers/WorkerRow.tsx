import type { WorkerSummary } from '../../shared/workers.ts';
import type { CSSProperties } from 'react';

export interface WorkerRowProps { readonly worker: WorkerSummary; readonly depth: number; readonly selected: boolean; readonly tabIndex?: number; readonly onSelect: () => void }
function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function WorkerRow({ worker, depth, selected, tabIndex = 0, onSelect }: WorkerRowProps) {
  return <button type="button" role="option" aria-selected={selected} tabIndex={tabIndex} aria-label={`${worker.name || worker.type}, ${worker.status}${worker.description ? `, ${worker.description}` : ''}`} className={`worker-row${selected ? ' is-selected' : ''}`} style={{ '--worker-depth': depth } as CSSProperties} onClick={onSelect}>
    <span className={`worker-status-dot worker-status-${worker.status}${worker.status === 'running' ? ' is-pulsing' : ''}`} aria-label={worker.status} />
    <span className="worker-row-copy"><strong>{worker.name || worker.type}</strong><span><span className="worker-type-badge">{worker.type}</span>{worker.model && <span className="worker-model">{worker.model}</span>}</span><small>{worker.description}</small></span>
    <span className="worker-row-time"><span>{worker.status}</span><time dateTime={new Date(worker.startedAt).toISOString()}>{relativeTime(worker.startedAt)}</time></span>
  </button>;
}
