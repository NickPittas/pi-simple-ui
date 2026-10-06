import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import { WORKERS_IPC, type WorkerEvent, type WorkerSnapshot, type WorkerSummary } from '../../shared/workers.ts';
import { WorkerRow } from './WorkerRow';
import { WorkerDetail } from './WorkerDetail';
import './workers.css';

export interface WorkersPaneProps { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly onRunningCount?: (count: number) => void; readonly initialSelectedId?: string | null }
export function WorkersPane({ bridge, scope, onRunningCount, initialSelectedId = null }: WorkersPaneProps) {
  const [workers, setWorkers] = useState<readonly WorkerSummary[]>([]);
  const [providerState, setProviderState] = useState<'available' | 'partial' | 'provider-unavailable'>('available');
   const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [snapshot, setSnapshot] = useState<WorkerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const scopeKey = scope ? `${scope.ownerId}:${scope.generation}` : 'none';
  const loadWorkers = useCallback(async () => {
    if (!bridge || !scope) return;
    const result = await bridge.invoke(WORKERS_IPC.list, {}, scope);
    if (!result.ok) { setError(result.error.message); return; }
    setProviderState(result.value.providerState); setWorkers(result.value.workers);
    onRunningCount?.(result.value.workers.filter((worker) => worker.status === 'running').length);
  }, [bridge, scope, onRunningCount]);
  const loadSnapshot = useCallback(async (id: string) => {
    if (!bridge || !scope) return;
    const result = await bridge.invoke(WORKERS_IPC.snapshot, { workerId: id }, scope);
    if (!result.ok) { setError(result.error.message); return; }
    setSnapshot(result.value);
  }, [bridge, scope]);
  useEffect(() => {
    let current = true;
    let unsubscribe: (() => void) | undefined;
    setWorkers([]); setSnapshot(null); setSelectedId(null); setError(null); onRunningCount?.(0);
    if (!bridge || !scope) return () => { current = false; };
    void loadWorkers().catch(() => { if (current) setError('Could not load workers.'); });
    void bridge.subscribe(WORKERS_IPC.events, scope, (event: WorkerEvent) => {
      if (!current) return;
      void loadWorkers();
      if (selectedIdRef.current === event.workerId) void loadSnapshot(event.workerId);
    }).then((result) => { if (!current) { if (result.ok) result.value(); } else if (result.ok) unsubscribe = result.value; else setError(result.error.message); }).catch(() => { if (current) setError('Could not subscribe to worker updates.'); });
    return () => { current = false; unsubscribe?.(); };
  }, [bridge, scopeKey, loadWorkers, loadSnapshot, onRunningCount]);
   const selectedIdRef = useRef<string | null>(null);
  useEffect(() => { selectedIdRef.current = selectedId; if (selectedId) void loadSnapshot(selectedId); else setSnapshot(null); }, [selectedId, loadSnapshot]);
  const groups = useMemo(() => {
    const byRoot = new Map<string, WorkerSummary[]>();
    for (const worker of workers) byRoot.set(worker.rootId, [...(byRoot.get(worker.rootId) ?? []), worker]);
    return [...byRoot.values()].map((group) => group.sort((a, b) => a.id === a.rootId ? -1 : b.id === b.rootId ? 1 : a.startedAt - b.startedAt));
  }, [workers]);
   const ordered = groups.flatMap((group) => group.map((worker) => ({ worker, depth: worker.id === worker.rootId ? 0 : 1 })));
   useEffect(() => { if (initialSelectedId) { setSelectedId(initialSelectedId); setFocused(Math.max(0, ordered.findIndex(({ worker }) => worker.id === initialSelectedId))) } }, [initialSelectedId, workers]);
  const counts = { running: workers.filter((item) => item.status === 'running').length, completed: workers.filter((item) => item.status === 'completed').length, failed: workers.filter((item) => item.status === 'failed').length, aborted: workers.filter((item) => item.status === 'aborted').length };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault(); const next = Math.max(0, Math.min(ordered.length - 1, focused + (event.key === 'ArrowDown' ? 1 : -1)));
    setFocused(next); setSelectedId(ordered[next]?.worker.id ?? null); listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus();
  };
  return <section className="workers-pane" aria-label="Workers">
     <header className="workers-pane-heading"><div><span className="eyebrow"><span className="eyebrow-line"/>WORKER ACTIVITY</span><h1>Workers</h1></div><div className="worker-counts" aria-label="Worker status counts" aria-live="polite"><span>{counts.running} running</span><span>{counts.completed} completed</span><span>{counts.failed} failed</span><span>{counts.aborted} aborted</span></div></header>
    {error && <p className="workers-error" role="alert">{error}</p>}
    {providerState === 'provider-unavailable' && workers.length === 0 ? <p className="workers-provider-note">Worker status is unavailable from the current provider.</p> : workers.length === 0 ? <div className="workers-empty"><span aria-hidden="true">◉</span><h2>No workers</h2><p>No workers — agents started by extensions appear here.</p></div> : <div className="workers-layout">
      <div ref={listRef} className="workers-list" role="listbox" aria-label="Observed workers" aria-live="polite" aria-relevant="additions text" onKeyDown={keyDown}>{ordered.map(({ worker, depth }, index) => <WorkerRow key={worker.id} worker={worker} depth={depth} selected={selectedId === worker.id} tabIndex={focused === index ? 0 : -1} onSelect={() => { setFocused(index); setSelectedId(worker.id); }} />)}</div>
       <div className="workers-detail-pane">{snapshot ? <WorkerDetail bridge={bridge} scope={scope} snapshot={snapshot} workers={workers} onRefresh={() => { void loadWorkers(); void loadSnapshot(snapshot.summary.id); }} /> : <p className="workers-detail-placeholder">Select a worker to inspect its conversation.</p>}</div>
    </div>}
  </section>;
}
