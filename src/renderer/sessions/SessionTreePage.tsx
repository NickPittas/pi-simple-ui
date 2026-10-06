import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import { SESSIONS_IPC, type SessionHistoryEntry, type SessionSnapshot } from '../../shared/sessions.ts';
import { SessionSearch } from './SessionSearch';
import './sessions.css';

export interface SessionTreePageProps { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly onOpenSession?: (sessionId: string) => void }

export function SessionTreePage({ bridge, scope, onOpenSession }: SessionTreePageProps) {
  const [sessions, setSessions] = useState<readonly SessionSnapshot[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [branchEntries, setBranchEntries] = useState<readonly SessionHistoryEntry[]>([]);
  const listRef = useRef<HTMLUListElement>(null);
  const scopeKey = scope ? `${scope.ownerId}:${scope.generation}` : 'none';
  const loadSessions = useCallback(async () => {
    if (!bridge || !scope) { setLoading(false); return; }
    setLoading(true); setError(null);
    const result = await bridge.invoke(SESSIONS_IPC.list, {}, scope);
    if (!result.ok) { setError(result.error.message); setLoading(false); return; }
    setSessions([...result.value.sessions].sort((a, b) => Date.parse(b.activeLeaf?.timestamp ?? b.createdAt) - Date.parse(a.activeLeaf?.timestamp ?? a.createdAt)));
    setDiagnostics(result.value.diagnostics.map((item) => `${item.file}: ${item.reason}`));
    setLoading(false);
  }, [bridge, scope]);
  useEffect(() => {
    let current = true;
    setSessions([]); setActiveId(null); setBranchEntries([]); setError(null); setLoading(true);
    if (!bridge || !scope) { setLoading(false); return () => { current = false; }; }
    void loadSessions().catch(() => { if (current) { setError('Could not load sessions.'); setLoading(false); } });
    return () => { current = false; };
  }, [bridge, scopeKey, loadSessions]);
  const open = async (session: SessionSnapshot) => {
    if (!bridge || !scope) return;
    setError(null);
    const result = await bridge.invoke(SESSIONS_IPC.open, { sessionId: session.id }, scope);
    if (!result.ok) { setError(result.error.message); return; }
    if (result.value.cancelled) return;
    const openedId = result.value.sessionId ?? session.id;
    setActiveId(openedId); onOpenSession?.(openedId);
    const history = await bridge.invoke(SESSIONS_IPC.history, { sessionId: openedId, limit: 100 }, scope);
    if (history.ok) setBranchEntries(history.value.entries);
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const next = Math.max(0, Math.min(sessions.length - 1, focused + (event.key === 'ArrowDown' ? 1 : -1)));
      setFocused(next); listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus();
    } else if (event.key === 'Enter' && sessions[focused]) { event.preventDefault(); void open(sessions[focused]); }
  };
  const formatDate = (value: string) => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toLocaleString() : value; };
  return <main className="sessions-page" aria-labelledby="sessions-heading">
    <header className="sessions-page-heading"><div><span className="eyebrow"><span className="eyebrow-line"/>SESSION HISTORY</span><h2 id="sessions-heading">Sessions</h2><p>Browse and search saved conversations in this workspace.</p></div><button className="extension-button extension-button-quiet" type="button" onClick={() => void loadSessions()}>Refresh</button></header>
    {error && <p className="sessions-error" role="alert">{error}</p>}
    {loading ? <p className="sessions-loading" role="status">Loading sessions…</p> : sessions.length === 0 ? <div className="sessions-empty"><h3>No sessions found</h3><p>There are no saved conversations in this workspace yet.</p></div> : <div className="sessions-columns">
      <section className="sessions-list-panel" aria-label="Saved sessions"><h3>Saved sessions</h3>
        {/* Snapshot data exposes active-leaf metadata, but not the full branch graph; this is an honest flat list. */}
        <ul ref={listRef} className="session-tree-list" role="listbox" aria-label="Saved sessions" onKeyDown={onListKeyDown}>{sessions.map((session, index) => <li role="none" key={session.id}><button id={`session-option-${session.id}`} role="option" aria-selected={activeId === session.id} tabIndex={focused === index ? 0 : -1} className={`session-tree-item${activeId === session.id ? ' is-active' : ''}`} onFocus={() => setFocused(index)} onClick={() => void open(session)}>
          <span className="session-tree-glyph" aria-hidden="true">◷</span><span className="session-tree-copy"><strong>{session.name || session.activeLeaf?.label || 'Untitled session'}</strong><small>{session.messageCount} messages · {formatDate(session.activeLeaf?.timestamp ?? session.createdAt)}</small>{session.activeLeaf && <small className="session-leaf-label">Active leaf: {session.activeLeaf.label || session.activeLeaf.type}</small>}</span>{activeId === session.id && <span className="session-active-badge">Open</span>}
        </button></li>)}</ul>
        {activeId && branchEntries.length > 0 && <section className="session-branch-panel" aria-label="Session branches"><h3>History branches</h3><ul>{branchEntries.map((entry) => {
          const parent = entry.parentId ? branchEntries.find((candidate) => candidate.id === entry.parentId) : undefined;
          const label = entry.label || entry.summary || entry.type;
           return <li key={entry.id} title={entry.parentId ? `Parent entry: ${entry.parentId}` : 'Root entry'}><span>{label}</span>{entry.id === sessions.find((item) => item.id === activeId)?.activeLeaf?.id && <small>Active leaf</small>}{entry.parentId && <small>Parent: {parent?.label || entry.parentId}</small>}</li>;
        })}</ul></section>}
      </section>
      <SessionSearch bridge={bridge} scope={scope} sessions={sessions} onOpen={(id) => { const session = sessions.find((item) => item.id === id); if (session) void open(session); }} />
    </div>}
    {diagnostics.length > 0 && <details className="session-diagnostics"><summary>Session recovery notes ({diagnostics.length})</summary><ul>{diagnostics.map((item) => <li key={item}>{item}</li>)}</ul></details>}
  </main>;
}
