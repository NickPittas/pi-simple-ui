import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import { SESSIONS_IPC } from '../../shared/sessions.ts';
import { CODEMODE_IPC, type CodemodeCatalogResponse, type CodemodeEventPayload, type CodemodeExecutionSummary, type CodemodeTrace } from '../../shared/codemode.ts';
import { CodeModeHistory } from './CodeModeHistory';
import './code-mode.css';

export interface CodeModeProps { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope }
function relativeTime(timestamp: string, now: number) {
  const elapsed = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  if (!Number.isFinite(elapsed) || elapsed < 60) return 'just now';
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
  return `${Math.floor(elapsed / 86400)}d ago`;
}

export function CodeMode({ bridge, scope }: CodeModeProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [executions, setExecutions] = useState<readonly CodemodeExecutionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trace, setTrace] = useState<CodemodeTrace | null>(null);
  const [catalog, setCatalog] = useState<CodemodeCatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [now, setNow] = useState(Date.now());
  const sessionRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const scopeKey = scope ? `${scope.ownerId}:${scope.generation}` : 'none';
  const loadList = useCallback(async (id: string) => {
    if (!bridge || !scope) return;
    const result = await bridge.invoke(CODEMODE_IPC.list, { sessionId: id }, scope);
    if (!result.ok) { setError(result.error.message); return; }
    setExecutions(result.value.executions);
  }, [bridge, scope]);
  const loadTrace = useCallback(async (id: string) => {
    if (!bridge || !scope) return;
    setBusy(true);
    const result = await bridge.invoke(CODEMODE_IPC.get, { executionId: id }, scope);
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return; }
    setTrace(result.value);
  }, [bridge, scope]);
  useEffect(() => {
    let current = true;
    let unsubscribe: (() => void) | undefined;
    setSessionId(null); sessionRef.current = null; setExecutions([]); setSelectedId(null); selectedRef.current = null; setTrace(null); setCatalog(null); setError(null);
    if (!bridge || !scope) return () => { current = false; };
    void bridge.invoke(SESSIONS_IPC.list, {}, scope).then(async (result) => {
      if (!current) return;
      if (!result.ok) { setError(result.error.message); return; }
      const session = [...result.value.sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!session) return;
      sessionRef.current = session.id;
      setSessionId(session.id);
      const [list, catalogResult] = await Promise.all([
        bridge.invoke(CODEMODE_IPC.list, { sessionId: session.id }, scope),
        bridge.invoke(CODEMODE_IPC.catalog, { sessionId: session.id }, scope),
      ]);
      if (!current) return;
      if (list.ok) { setExecutions(list.value.executions); if (list.value.executions[0]) { selectedRef.current = list.value.executions[0].executionId; setSelectedId(list.value.executions[0].executionId); void loadTrace(list.value.executions[0].executionId); } }
      else setError(list.error.message);
      if (catalogResult.ok) setCatalog(catalogResult.value);
    }).catch(() => { if (current) setError('Could not load Code Mode executions.'); });
    void bridge.subscribe(CODEMODE_IPC.events, scope, (payload: CodemodeEventPayload) => {
      if (!current || (sessionRef.current && payload.sessionId !== sessionRef.current)) return;
      const execution = payload.execution;
      setExecutions((currentExecutions) => {
        const item: CodemodeExecutionSummary = { executionId: execution.executionId, status: execution.status, startedAt: execution.startedAt, ...(execution.durationMs !== undefined ? { durationMs: execution.durationMs } : {}), callCount: execution.calls.length, ...(execution.error ? { error: execution.error } : {}) };
        return [item, ...currentExecutions.filter((entry) => entry.executionId !== item.executionId)];
      });
      if (selectedRef.current === execution.executionId) setTrace(execution);
    }).then((result) => { if (!current) { if (result.ok) result.value(); } else if (result.ok) unsubscribe = result.value; else setError(result.error.message); }).catch(() => { if (current) setError('Could not subscribe to Code Mode events.'); });
    return () => { current = false; unsubscribe?.(); };
  }, [bridge, scopeKey, loadTrace]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  const abortExecution = async () => {
    if (!bridge || !scope || !selectedId) return;
    const result = await bridge.invoke(CODEMODE_IPC.abort, { executionId: selectedId }, scope);
    if (!result.ok) setError(result.error.message);
    else { setError(result.value.scope === 'turn' ? 'Abort requested. This stops the current agent turn, not only this script.' : 'No running turn was aborted.'); setConfirmAbort(false); }
  };
  return <main className="codemode-page" aria-label="Code Mode">
    <header className="codemode-page-heading"><div><span className="eyebrow"><span className="eyebrow-line"/>SCRIPT EXECUTIONS</span><h1>Code Mode</h1><p>Scripts and the tools they called in the active session.</p></div>{catalog && <span className="codemode-mode-chip">Mode: {catalog.settings.mode}</span>}</header>
    {error && <p className="codemode-error" role="alert">{error}</p>}
    {!sessionId ? <div className="codemode-empty"><h2>No active session</h2><p>Code Mode executions appear here after a session is available.</p></div> : <div className="codemode-layout">
       <section className="codemode-execution-list" aria-label="Executions"><h2>Executions</h2>{executions.length === 0 ? <p className="codemode-muted">No Code Mode executions recorded for this session.</p> : <ul aria-live="polite" aria-relevant="additions text">{executions.map((execution) => <li key={execution.executionId}><button type="button" aria-current={selectedId === execution.executionId ? 'true' : undefined} className={selectedId === execution.executionId ? 'is-selected' : ''} onClick={() => { selectedRef.current = execution.executionId; setSelectedId(execution.executionId); void loadTrace(execution.executionId); }}><strong>{execution.executionId}</strong><span className={`codemode-status codemode-status-${execution.status}`}>{execution.status}</span><small>{execution.callCount} calls · {execution.durationMs === undefined ? execution.status === 'running' ? 'in progress' : 'duration unavailable' : `${execution.durationMs} ms`} · {relativeTime(execution.startedAt, now)}</small>{execution.error && <small className="codemode-list-error">{execution.error}</small>}</button></li>)}</ul>}</section>
       <div className="codemode-detail">{busy ? <p role="status">Loading execution…</p> : trace ? <><header className="codemode-detail-heading"><div><span className={`codemode-status codemode-status-${trace.status}`}>{trace.status}</span><small>Started {relativeTime(trace.startedAt, now)}{trace.durationMs !== undefined ? ` · ${trace.durationMs} ms` : ''}</small></div>{trace.status === 'running' && (confirmAbort ? <div className="codemode-abort-confirm" role="group" aria-label="Confirm abort current turn" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setConfirmAbort(false); } }}><span>Abort stops the current agent turn.</span><button type="button" onClick={() => void abortExecution()}>Confirm abort</button><button type="button" onClick={() => setConfirmAbort(false)}>Cancel</button></div> : <button className="codemode-abort" type="button" onClick={() => setConfirmAbort(true)}>Abort turn</button>)}</header><CodeModeHistory trace={trace} catalog={catalog} /></> : <p className="codemode-muted">Select an execution to inspect its script and trace.</p>}</div>
    </div>}
  </main>;
}
