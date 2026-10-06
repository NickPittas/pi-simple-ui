import { useMemo, useState } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import { SESSIONS_IPC, type SessionSnapshot } from '../../shared/sessions.ts';

export interface SessionSearchProps { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly sessions: readonly SessionSnapshot[]; readonly onOpen: (sessionId: string) => void }

export function SessionSearch({ bridge, scope, sessions, onOpen }: SessionSearchProps) {
  const [query, setQuery] = useState('');
  const [historyQuery, setHistoryQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [matches, setMatches] = useState<Array<{ id: string; text: string; timestamp: string }>>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return sessions.filter((session) => !needle || `${session.name ?? ''} ${session.id} ${session.activeLeaf?.label ?? ''}`.toLocaleLowerCase().includes(needle));
  }, [sessions, query]);
  const searchHistory = async (start: number, append: boolean, sessionId = selectedId) => {
    if (!bridge || !scope || !sessionId || !historyQuery.trim()) return;
    setLoading(true); setError(null);
    try {
      const result = await bridge.invoke(SESSIONS_IPC.history, { sessionId, offset: start, limit: 100 }, scope);
      if (!result.ok) { setError(result.error.message); setLoading(false); return; }
      const needle = historyQuery.trim().toLocaleLowerCase();
      const found = result.value.entries.flatMap((entry) => {
        const body = [...(entry.content ?? []).flatMap((part) => part.type === 'text' || part.type === 'thinking' ? [part.text] : []), entry.summary ?? '', entry.label ?? ''].join('\n');
        return body.toLocaleLowerCase().includes(needle) ? [{ id: entry.id, text: body, timestamp: entry.timestamp }] : [];
      });
      setMatches((current) => append ? [...current, ...found].slice(0, 100) : found.slice(0, 100));
      setOffset(result.value.nextOffset ?? start + result.value.limit);
      setNextOffset(result.value.nextOffset);
    } catch { setError('Could not search session history.'); }
    setLoading(false);
  };
  const searchInSession = (sessionId: string) => { setSelectedId(sessionId); setOffset(0); setNextOffset(null); setMatches([]); };
  return <section className="session-search" aria-label="Search sessions">
    <label htmlFor="session-filter">Filter sessions</label><input id="session-filter" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, label, or ID" />
    {filtered.length === 0 ? <p className="sessions-empty-search">No sessions match this filter.</p> : <ul className="session-filter-list">{filtered.map((session) => <li key={session.id}><button type="button" onClick={() => { searchInSession(session.id); onOpen(session.id); }}><span>{session.name || session.activeLeaf?.label || 'Untitled session'}</span><small>{session.messageCount} messages</small></button></li>)}</ul>}
    <div className="session-history-search"><label htmlFor="history-search">Search in a session</label><input id="history-search" type="search" value={historyQuery} onChange={(event) => { setHistoryQuery(event.target.value); setMatches([]); setNextOffset(null); }} placeholder="Search message text" />
      <label className="session-search-select-label" htmlFor="history-session">Session</label><select id="history-session" value={selectedId ?? ''} onChange={(event) => searchInSession(event.target.value)}><option value="" disabled>Select a session</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.name || session.activeLeaf?.label || session.id}</option>)}</select>
      <button type="button" className="extension-button extension-button-primary" disabled={!selectedId || !historyQuery.trim() || loading} onClick={() => { setOffset(0); setNextOffset(null); void searchHistory(0, false); }}>{loading ? 'Searching…' : 'Search history'}</button>
      {error && <p role="alert">{error}</p>}
      {matches.length > 0 && <><ul className="session-search-results" aria-label="History matches">{matches.map((match) => <li key={match.id}><time>{match.timestamp}</time><p>{highlight(match.text, historyQuery)}</p></li>)}</ul>{nextOffset !== null && matches.length < 100 && <button type="button" className="extension-button extension-button-quiet" disabled={loading} onClick={() => void searchHistory(offset, true)}>Load more</button>}</>}
      {!loading && selectedId && historyQuery.trim() && matches.length === 0 && !error && <p className="sessions-empty-search">No matches in the loaded history page.</p>}
    </div>
  </section>;
}

function highlight(text: string, query: string) {
  const term = query.trim();
  if (!term) return text;
  const index = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  if (index < 0) return text;
  return <>{text.slice(0, index)}<mark>{text.slice(index, index + term.length)}</mark>{text.slice(index + term.length)}</>;
}
