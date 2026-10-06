import { useMemo, useState } from 'react';
import type { UsageTotals, UsageWorkerTotals } from '../../shared/usage.ts';

type SortDirection = 'asc' | 'desc';
export interface UsageBreakdownProps { readonly models: Readonly<Record<string, UsageTotals>>; readonly workers: Readonly<Record<string, UsageWorkerTotals>>; readonly session: UsageTotals }
function tokenSum(totals: UsageTotals): number | null {
  const parts = [totals.input, totals.output, totals.cacheRead, totals.cacheWrite];
  return parts.some((value) => value === null) ? null : parts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}
function tokenText(value: number | null) { return value === null ? '—' : value.toLocaleString(); }

export function UsageBreakdown({ models, workers, session }: UsageBreakdownProps) {
  const [modelSort, setModelSort] = useState<{ key: 'name' | 'tokens' | 'turns'; direction: SortDirection }>({ key: 'name', direction: 'asc' });
  const [workerSort, setWorkerSort] = useState<{ key: 'name' | 'tokens' | 'share'; direction: SortDirection }>({ key: 'name', direction: 'asc' });
  const modelRows = useMemo(() => Object.entries(models).map(([name, totals]) => ({ name, totals })).sort((a, b) => {
    const value = modelSort.key === 'name' ? a.name.localeCompare(b.name) : modelSort.key === 'tokens' ? (tokenSum(a.totals) ?? -1) - (tokenSum(b.totals) ?? -1) : (a.totals.turns ?? -1) - (b.totals.turns ?? -1);
    return modelSort.direction === 'asc' ? value : -value;
  }), [models, modelSort]);
  const workerRows = useMemo(() => {
    const values = Object.values(workers);
    return values.map((worker) => {
      const tokens = tokenSum(worker.totals); const total = tokenSum(session);
      return { worker, tokens, share: tokens === null || total === null || total === 0 ? null : tokens / total };
    }).sort((a, b) => {
      const value = workerSort.key === 'name' ? a.worker.name.localeCompare(b.worker.name) : workerSort.key === 'tokens' ? (a.tokens ?? -1) - (b.tokens ?? -1) : (a.share ?? -1) - (b.share ?? -1);
      return workerSort.direction === 'asc' ? value : -value;
    });
  }, [workers, session, workerSort]);
  const childParents = new Set(Object.values(workers).map((worker) => worker.parentId).filter((id): id is string => id !== null));
  const sortModel = (key: 'name' | 'tokens' | 'turns') => setModelSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  const sortWorker = (key: 'name' | 'tokens' | 'share') => setWorkerSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  return <div className="usage-breakdown">
    <section className="usage-table-section"><h2>By model</h2>{modelRows.length === 0 ? <p className="usage-empty">No per-model usage was reported.</p> : <div className="usage-table-scroll"><table><caption>Usage totals attributed to each model</caption><thead><tr><th aria-sort={modelSort.key === 'name' ? modelSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => sortModel('name')}>Model</button></th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Cache read</th><th scope="col">Cache write</th><th aria-sort={modelSort.key === 'turns' ? modelSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => sortModel('turns')}>Turns</button></th><th aria-sort={modelSort.key === 'tokens' ? modelSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => sortModel('tokens')}>Tokens</button></th></tr></thead><tbody>{modelRows.map(({ name, totals }) => <tr key={name}><th scope="row">{name}</th><td>{tokenText(totals.input)}</td><td>{tokenText(totals.output)}</td><td>{tokenText(totals.cacheRead)}</td><td>{tokenText(totals.cacheWrite)}</td><td>{tokenText(totals.turns)}</td><td>{tokenText(tokenSum(totals))}</td></tr>)}</tbody></table></div>}</section>
    <section className="usage-table-section"><h2>By worker</h2>{workerRows.length === 0 ? <p className="usage-empty">No worker usage was reported for this session.</p> : <div className="usage-table-scroll"><table><caption>Worker rows are hierarchical and include descendants where noted</caption><thead><tr><th aria-sort={workerSort.key === 'name' ? workerSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => sortWorker('name')}>Worker</button></th><th scope="col">Ancestry</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Cache</th><th aria-sort={workerSort.key === 'tokens' ? workerSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => sortWorker('tokens')}>Tokens</button></th><th aria-sort={workerSort.key === 'share' ? workerSort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => sortWorker('share')}>Session share</button></th></tr></thead><tbody>{workerRows.map(({ worker, tokens, share }) => <tr key={worker.id} className={worker.parentId === null ? 'usage-worker-root' : 'usage-worker-child'}><th scope="row">{worker.name}<small>{worker.model ?? 'Model unavailable'}</small>{childParents.has(worker.id) && <small className="usage-aggregation-note">Includes child agents</small>}</th><td>{worker.ancestry.length ? worker.ancestry.join(' / ') : 'Root worker'}</td><td>{tokenText(worker.totals.input)}</td><td>{tokenText(worker.totals.output)}</td><td>{tokenText(worker.totals.cacheRead)} / {tokenText(worker.totals.cacheWrite)}</td><td>{tokenText(tokens)}</td><td>{share === null ? '—' : `${(share * 100).toFixed(1)}%`}</td></tr>)}</tbody></table></div>}</section>
  </div>;
}
