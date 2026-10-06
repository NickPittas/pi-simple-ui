import { useEffect, useState } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import { SESSIONS_IPC } from '../../shared/sessions.ts';
import { USAGE_IPC, type UsageEventPayload, type UsageMarker, type UsageModelsResponse, type UsageSessionResponse, type UsageTotals, type UsageWorkersResponse } from '../../shared/usage.ts';
import { UsageBreakdown } from './UsageBreakdown';
import './usage.css';

export interface UsagePanelProps { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope }
const blankTotals: UsageTotals = { input: null, output: null, cacheRead: null, cacheWrite: null, costMicros: null, turns: null };
function cost(micros: number | null) { return micros === null ? 'Cost unavailable from provider' : `$${(micros / 1_000_000).toFixed(6)}`; }
function tokens(value: number | null) { return value === null ? 'Unavailable' : value.toLocaleString(); }
function markerText(marker: UsageMarker) {
  if (marker.kind === 'compaction') return `Compaction ${marker.phase}${marker.reason ? ` · ${marker.reason}` : ''}${marker.aborted ? ' · aborted' : ''}`;
  return `Retry ${marker.phase}${marker.attempt !== undefined ? ` · attempt ${marker.attempt}${marker.maxAttempts !== undefined ? ` of ${marker.maxAttempts}` : ''}` : ''}`;
}

export function UsagePanel({ bridge, scope }: UsagePanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<UsageSessionResponse | null>(null);
  const [turn, setTurn] = useState<UsageTotals>(blankTotals);
  const [models, setModels] = useState<UsageModelsResponse['session']>({});
  const [workers, setWorkers] = useState<UsageWorkersResponse['workers']>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const scopeKey = scope ? `${scope.ownerId}:${scope.generation}` : 'none';
  useEffect(() => {
    let active = true; let unsubscribe: (() => void) | undefined;
    setSessionId(null); setSession(null); setTurn(blankTotals); setModels({}); setWorkers({}); setError(null); setLoading(true);
    if (!bridge || !scope) { setLoading(false); return () => { active = false; }; }
    void bridge.invoke(SESSIONS_IPC.list, {}, scope).then(async (listed) => {
      if (!active) return;
      if (!listed.ok) { setError(listed.error.message); setLoading(false); return; }
      const current = [...listed.value.sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!current) { setLoading(false); return; }
      setSessionId(current.id);
      const [sessionResult, turnResult, modelsResult, workersResult] = await Promise.all([
        bridge.invoke(USAGE_IPC.session, { sessionId: current.id }, scope), bridge.invoke(USAGE_IPC.turn, { sessionId: current.id }, scope),
        bridge.invoke(USAGE_IPC.models, { sessionId: current.id }, scope), bridge.invoke(USAGE_IPC.workers, { sessionId: current.id }, scope),
      ]);
      if (!active) return;
      if (sessionResult.ok) setSession(sessionResult.value); else setError(sessionResult.error.message);
      if (turnResult.ok) setTurn(turnResult.value.turn);
      if (modelsResult.ok) setModels(modelsResult.value.session);
      if (workersResult.ok) setWorkers(workersResult.value.workers);
      setLoading(false);
    }).catch(() => { if (active) { setError('Could not load usage data.'); setLoading(false); } });
    void bridge.subscribe(USAGE_IPC.events, scope, (event: UsageEventPayload) => {
      if (!active || (sessionId && event.sessionId !== sessionId)) return;
      setSession({ runtime: event.runtime, sessionId: event.sessionId, branch: event.branch, session: event.session, markers: event.markers, unknown: event.unknown });
      setTurn(event.turn); setModels(event.models); setWorkers(event.workers); setSessionId(event.sessionId);
    }).then((result) => { if (!active) { if (result.ok) result.value(); } else if (result.ok) unsubscribe = result.value; else setError(result.error.message); });
    return () => { active = false; unsubscribe?.(); };
  }, [bridge, scopeKey]);
  const activeTotals = session?.session ?? blankTotals;
  const tokenValues = [
    { id: 'input', label: 'Input', value: activeTotals.input, color: 'input' },
    { id: 'output', label: 'Output', value: activeTotals.output, color: 'output' },
    { id: 'cacheRead', label: 'Cache read', value: activeTotals.cacheRead, color: 'cache-read' },
    { id: 'cacheWrite', label: 'Cache write', value: activeTotals.cacheWrite, color: 'cache-write' },
  ];
  const totalKnown = tokenValues.every((part) => part.value !== null);
  const totalTokens = totalKnown ? tokenValues.reduce((sum, item) => sum + (item.value ?? 0), 0) : null;
  return <main className="usage-page" aria-label="Usage and cost">
    <header className="usage-page-heading"><div><span className="eyebrow"><span className="eyebrow-line"/>SESSION METRICS</span><h1>Usage</h1><p>Native token, cost, and context records for the active session.</p></div></header>
    {error && <p className="usage-error" role="alert">{error}</p>}
    {loading ? <p role="status" className="usage-empty">Loading usage…</p> : !sessionId ? <section className="usage-empty-state"><h2>No session usage</h2><p>Usage appears here after a session records activity.</p></section> : <>
      <section className="usage-overview" aria-labelledby="usage-overview-heading" aria-live="polite" aria-atomic="false"><h2 id="usage-overview-heading">Session totals</h2><div className="usage-summary-cards"><article><span>Tokens</span><strong>{tokens(totalTokens)}</strong></article><article><span>Cost</span><strong>{cost(activeTotals.costMicros)}</strong></article><article><span>Turns</span><strong>{tokens(activeTotals.turns)}</strong></article><article><span>Latest turn cost</span><strong>{cost(turn.costMicros)}</strong></article></div>
        <div className="usage-token-breakdown" aria-label="Token breakdown">{tokenValues.map((item) => <div className="usage-token-line" key={item.id}><span>{item.label}</span><strong>{tokens(item.value)}</strong><div className="usage-token-track"><span className={`usage-token-segment segment-${item.color}`} style={{ width: totalTokens && item.value !== null ? `${Math.max(0, item.value / totalTokens * 100)}%` : '0%' }} /></div></div>)}</div>
      </section>
      {session && session.markers.length > 0 && <section className="usage-markers"><h2>Context events</h2><ul>{session.markers.map((marker, index) => <li key={`${marker.kind}-${marker.timestamp}-${index}`}><time>{new Date(marker.timestamp).toLocaleTimeString()}</time><span>{markerText(marker)}</span></li>)}</ul></section>}
      {session && session.unknown.length > 0 && <section className="usage-unknown"><h2>Data limitations</h2><ul>{session.unknown.map((item) => <li key={item}>{item.replaceAll('-', ' ')}</li>)}</ul></section>}
      <UsageBreakdown models={models} workers={workers} session={activeTotals} />
    </>}
  </main>;
}
