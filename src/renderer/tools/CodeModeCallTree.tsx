import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { CodemodeCallTrace } from '../../shared/codemode.ts';

export interface CodeModeCallTreeProps { readonly calls: readonly CodemodeCallTrace[] }
const DISPLAY_LIMIT = 160;
function duration(call: CodemodeCallTrace): string { return call.durationMs === undefined ? (call.status === 'running' ? 'Running' : '—') : `${call.durationMs} ms`; }

export function CodeModeCallTree({ calls }: CodeModeCallTreeProps) {
  const [limit, setLimit] = useState(DISPLAY_LIMIT);
  const [focused, setFocused] = useState(0);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const nodes = useMemo(() => {
    const byParent = new Map<string | null, CodemodeCallTrace[]>();
    const ids = new Set(calls.map((call) => call.id));
    for (const call of calls) {
      const parent = call.parentId && ids.has(call.parentId) ? call.parentId : null;
      byParent.set(parent, [...(byParent.get(parent) ?? []), call]);
    }
    return byParent;
  }, [calls]);
  const ordered: CodemodeCallTrace[] = [];
  const collect = (parentId: string | null, depth: number) => {
    if (depth > 40) return;
    for (const call of nodes.get(parentId) ?? []) { ordered.push(call); if (open.has(call.id)) collect(call.id, depth + 1); }
  };
  collect(null, 0);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-call-focus]')];
    const tree = event.currentTarget; const currentCall = ordered[focused];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, focused + (event.key === 'ArrowDown' ? 1 : -1)));
      setFocused(next); rows[next]?.focus();
    } else if (event.key === 'ArrowRight' && currentCall && (nodes.get(currentCall.id)?.length ?? 0) > 0) {
      event.preventDefault();
      if (!open.has(currentCall.id)) setOpen((current) => new Set(current).add(currentCall.id));
      else { const childIndex = ordered.findIndex((item) => item.parentId === currentCall.id); if (childIndex >= 0) { setFocused(childIndex); requestAnimationFrame(() => tree.querySelectorAll<HTMLButtonElement>('[data-call-focus]')[childIndex]?.focus()); } }
    } else if (event.key === 'ArrowLeft' && currentCall) {
      event.preventDefault();
      if (open.has(currentCall.id)) setOpen((current) => { const next = new Set(current); next.delete(currentCall.id); return next; });
      else if (currentCall.parentId) { const parentIndex = ordered.findIndex((item) => item.id === currentCall.parentId); if (parentIndex >= 0) { setFocused(parentIndex); rows[parentIndex]?.focus(); } }
    }
  };
  let renderedCount = 0;
  const renderSiblings = (parentId: string | null, depth: number): ReactNode => {
    if (depth > 40 || renderedCount >= limit) return null;
    const siblings = nodes.get(parentId) ?? [];
    const rows = siblings.map((call) => {
      if (renderedCount >= limit) return null;
      const index = renderedCount++;
      const children = nodes.get(call.id) ?? [];
      return <div className="codemode-call" key={call.id} role="treeitem" aria-level={depth + 1} aria-expanded={children.length ? open.has(call.id) : undefined}>
        <button className="codemode-call-heading" data-call-focus="true" type="button" tabIndex={focused === index ? 0 : -1} aria-label={`${call.name}, ${call.status}${children.length ? `, ${open.has(call.id) ? 'expanded' : 'collapsed'}` : ''}`} onFocus={() => setFocused(index)} onClick={() => setOpen((current) => { const next = new Set(current); if (next.has(call.id)) next.delete(call.id); else next.add(call.id); return next; })} style={{ '--call-depth': depth } as CSSProperties}>
          <span className="codemode-call-mark" aria-hidden="true">{children.length ? (open.has(call.id) ? '−' : '+') : '·'}</span><span className="codemode-call-name">{call.namespace && <small>{call.namespace} / </small>}{call.name}</span><span className={`codemode-status codemode-status-${call.status}`}>{call.status}</span><time>{duration(call)}</time>
        </button>
        <div className="codemode-call-content"><details><summary>Arguments</summary><pre>{JSON.stringify(call.args, null, 2)}</pre></details>{call.output !== undefined && <details><summary>Output</summary><pre>{JSON.stringify(call.output, null, 2)}</pre></details>}{call.partialOutput !== undefined && <details open><summary>Partial output</summary><pre>{JSON.stringify(call.partialOutput, null, 2)}</pre></details>}{call.error && <div className="codemode-call-error" role="alert"><strong>Error</strong><pre>{call.error}</pre></div>}</div>
        {children.length > 0 && open.has(call.id) && <div className="codemode-call-children" role="group" aria-label={`Calls within ${call.name}`}>{renderSiblings(call.id, depth + 1)}</div>}
      </div>;
    });
    return siblings.length > 1 ? <div className="codemode-parallel-group" role="group" aria-label="Parallel calls">{rows}</div> : rows;
  };
  return <div className="codemode-call-tree" role="tree" aria-label="Tool call trace" onKeyDown={onKeyDown}>
    {ordered.length === 0 ? <p className="codemode-muted">No tool calls recorded.</p> : renderSiblings(null, 0)}
    {ordered.length > limit && <button className="codemode-load-more" type="button" onClick={() => setLimit((value) => value + DISPLAY_LIMIT)}>Load more calls</button>}
  </div>;
}
