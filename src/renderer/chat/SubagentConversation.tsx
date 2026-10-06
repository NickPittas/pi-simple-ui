import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import type { SubagentTranscriptResult } from '../../shared/native-subagents.ts';
import type { Json, NativePiSessionSnapshot } from '../../shared/native-pi.ts';
import { Conversation } from './Conversation';
import { projectNativeSession } from './native-message';
import type { SubagentRef } from './subagents';
import './subagents.css';

interface Props { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly refInfo: SubagentRef; readonly onClose: () => void; readonly onBack?: () => void }
const NOT_FOUND_PREFIX = 'not-found:';
const POLL_MS = 2000;
const MAX_POLL_MS = 10000;

function toSnapshot(result: SubagentTranscriptResult): NativePiSessionSnapshot {
  const seen = new Set<string>();
  let parent: string | null = null;
  const entries: Json[] = result.entries.map((entry, index) => {
    let id = entry.id || `entry-${index}`;
    while (seen.has(id)) id = `${id}:${index}`;
    seen.add(id);
    const value: Json = { id, type: 'message', parentId: parent, ...(entry.timestamp ? { timestamp: entry.timestamp } : {}), message: entry.message as Json };
    parent = id;
    return value;
  });
  const ids = entries.map((entry) => (entry as { id: string }).id);
  return { sessionId: `subagent:${result.file}`, sessionGeneration: 0, name: null, file: result.file, cwd: null, classification: 'unknown', parentSessionId: null, entries, activeLeaf: ids.at(-1) ?? null, activeBranch: ids, partial: null, metadata: null } as NativePiSessionSnapshot;
}

export function SubagentConversation({ bridge, scope, refInfo, onClose, onBack }: Props) {
  const [result, setResult] = useState<SubagentTranscriptResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const statusRef = useRef(refInfo.status);
  statusRef.current = refInfo.status;
  const scopeKey = scope ? `${scope.ownerId}:${scope.generation}` : 'no-runtime';

  // Reset only when the transcript identity changes; a status flip (running -> completed) must not blank the view.
  useEffect(() => { setResult(null); setFailure(null); setLoading(true); setUpdatedAt(null); }, [bridge, scopeKey, refInfo.file]);

  const [checking, setChecking] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);

  // Always poll while mounted (background subagents finish their tool call before they write their transcript).
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, inFlight = false, unchanged = 0;
    let last: { modified: string | null; bytes: number; length: number } | null = null;
    let lastPollAt = Date.now(), watchdog: ReturnType<typeof setInterval> | undefined;
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const schedule = () => {
      if (!active) return;
      if (timer) clearTimeout(timer);
      const running = statusRef.current === 'running';
      const delay = running || unchanged === 0 ? POLL_MS : Math.min(MAX_POLL_MS, POLL_MS * (unchanged + 1));
      timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (!active || inFlight) return;
      if (timer) { clearTimeout(timer); timer = undefined; }
      inFlight = true; setChecking(true);
      try {
        if (!bridge) throw new Error('Desktop bridge is unavailable.');
        const response = await bridge.invoke('native.subagent.transcript', { file: refInfo.file }, scope);
        if (!active) return;
        if (response.ok) {
          const v = response.value;
          const next = { modified: v.modified, bytes: v.bytes, length: v.entries.length };
          const changed = !last || last.modified !== next.modified || last.bytes !== next.bytes || last.length !== next.length;
          last = next;
          unchanged = changed ? 0 : unchanged + 1;
          if (changed) setResult(v);
          setFailure(null);
          setUpdatedAt(new Date());
        } else { setFailure(response.error.message); unchanged += 1; }
      } catch (error) {
        if (active) { setFailure(error instanceof Error ? error.message : String(error)); unchanged += 1; }
      } finally { inFlight = false; if (active) { setLoading(false); setChecking(false); } }
      lastPollAt = Date.now();
      schedule();
    };
    // Accelerator only: polling never depends on visibility state (Chromium may misreport it under Wayland).
    const onVisibility = () => { if (!hidden()) { unchanged = 0; void poll(); } };
    refreshRef.current = () => { unchanged = 0; void poll(); };
    document.addEventListener('visibilitychange', onVisibility);
    watchdog = setInterval(() => { if (active && !inFlight && Date.now() - lastPollAt >= 11000) void poll(); }, 12000);
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); if (watchdog) clearInterval(watchdog); document.removeEventListener('visibilitychange', onVisibility); refreshRef.current = () => undefined; };
  }, [bridge, scopeKey, refInfo.file]);

  const messages = useMemo(() => result && result.entries.length ? projectNativeSession(toSnapshot(result)) : [], [result]);
  const error = result?.error ?? failure;
  const notWritten = error?.startsWith(NOT_FOUND_PREFIX) ?? false;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, [refInfo.file]);
  const clock = updatedAt ? updatedAt.toLocaleTimeString([], { hour12: false }) : null;
  return <div className="subagent-viewer">
    {onBack && <button type="button" className="subagent-back" onClick={onBack} aria-label="Back to all subagents">← All subagents</button>}
    <header className="subagent-viewer-header">
      <div className="subagent-viewer-title"><h2 ref={headingRef} tabIndex={-1}>{refInfo.label}</h2>
        {refInfo.agentType && <span className="subagent-badge">{refInfo.agentType}</span>}
        <span className={`subagent-status subagent-status-${refInfo.status}`}>{refInfo.status}</span></div>
      <div className="subagent-viewer-actions">
        <span className="subagent-updated" role="status" aria-live="off">{checking ? 'Checking…' : clock ? `Updated ${clock}` : ''}</span>
        <button type="button" className="subagent-close" onClick={() => refreshRef.current()} disabled={checking} aria-label="Refresh subagent transcript">Refresh</button>
        <button type="button" className="subagent-close" onClick={onClose} aria-label="Close subagent panel">✕ Close</button>
      </div>
    </header>
    <p className="subagent-note">Read-only view of a subagent session. Nothing here steers, stops, or messages the subagent.</p>
    <p className="subagent-file" title={refInfo.file}>{refInfo.file}</p>
    {result?.truncated && <p className="subagent-notice" role="status">Showing the latest part of a long transcript</p>}
    {error && <p className="subagent-error" role={notWritten ? 'status' : 'alert'}>{notWritten ? (error!.slice(NOT_FOUND_PREFIX.length).trim() || 'Transcript not written yet') : error}{notWritten && refInfo.status === 'running' ? ' — checking again shortly.' : ''}</p>}
    {loading && !result && !error && <p className="subagent-notice" role="status">Loading transcript…</p>}
    <div className="subagent-body"><Conversation messages={messages} lifecycle={refInfo.status === 'running' ? 'streaming' : 'idle'} /></div>
  </div>;
}
