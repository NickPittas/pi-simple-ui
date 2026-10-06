import { useEffect, useRef, useState } from 'react';
import type { SubagentRef } from '../chat/subagents';
import '../chat/subagents.css';

const HIDE_KEY = 'pi-desktop.subagents.hideCompleted';
const readHide = (): boolean => { try { return window.localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } };
const writeHide = (value: boolean): void => { try { window.localStorage.setItem(HIDE_KEY, value ? '1' : '0'); } catch { /* storage unavailable */ } };
const STATE_LABEL = { running: 'running', finished: 'finished', failed: 'failed', unknown: 'background' } as const;

interface Props { readonly subagents: readonly SubagentRef[]; readonly selectedFile?: string | null; readonly onOpen: (ref: SubagentRef) => void; readonly onClose?: () => void; readonly initialScrollTop?: number; readonly onScrollTop?: (top: number) => void }

/** Lists subagent sessions referenced by tool results in the current conversation. Observation only. */
export function ObservedSubagentsPage({ subagents, selectedFile, onOpen, onClose, initialScrollTop, onScrollTop }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [hideCompleted, setHideCompleted] = useState<boolean>(readHide);
  const toggleHide = (value: boolean) => { setHideCompleted(value); writeHide(value); };
  const visible = hideCompleted ? subagents.filter((ref) => ref.state !== 'finished') : subagents;
  const hiddenCount = subagents.length - visible.length;
  useEffect(() => { if (initialScrollTop && listRef.current) listRef.current.scrollTop = initialScrollTop; }, []);
  useEffect(() => { headingRef.current?.focus(); }, []);
  return <div className="subagent-viewer subagent-list">
    <header className="subagent-viewer-header"><div className="subagent-viewer-title"><h2 ref={headingRef} tabIndex={-1}>Observed subagents</h2></div>{onClose && <button type="button" className="subagent-close" onClick={onClose} aria-label="Close subagent panel">✕ Close</button>}</header>
    <p className="subagent-note">Subagents found in this conversation's tool results. Read-only.</p>
    {subagents.length > 0 && <div className="subagent-filter"><button type="button" className="subagent-filter-toggle" aria-pressed={hideCompleted} onClick={() => toggleHide(!hideCompleted)}>Hide completed</button>{hideCompleted && hiddenCount > 0 && <span className="subagent-updated">{hiddenCount} hidden</span>}</div>}
    {subagents.length === 0 ? <p className="subagent-empty">No subagents observed in this conversation yet.</p> : visible.length === 0 ? <div className="subagent-empty" role="status"><p>All subagents have completed.</p><button type="button" className="subagent-close" onClick={() => toggleHide(false)}>Show completed</button></div> : <ul className="subagent-list-items" ref={listRef} onScroll={(event) => onScrollTop?.(event.currentTarget.scrollTop)}>{visible.map((ref) => <li key={ref.file}>
      <button type="button" className={`subagent-list-item${selectedFile === ref.file ? ' subagent-list-item-active' : ''}`} aria-current={selectedFile === ref.file ? 'true' : undefined} onClick={() => onOpen(ref)}>
        <span className="subagent-list-head"><strong>{ref.label}</strong>{ref.agentType && <span className="subagent-badge">{ref.agentType}</span>}<span className={`subagent-status subagent-state-${ref.state}`}>{STATE_LABEL[ref.state]}</span>{selectedFile === ref.file && <span className="subagent-badge">last opened</span>}</span>
        <span className="subagent-file">{ref.file}</span>
      </button></li>)}</ul>}
  </div>;
}
