import { useState, type FormEvent } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import { WORKERS_IPC, type WorkerSnapshot, type WorkerSummary } from '../../shared/workers.ts';
import type { NativePiSessionSnapshot } from '../../shared/native-pi.ts';
import { Conversation } from '../chat/Conversation';
import { projectNativeSession } from '../chat/native-message';

export interface WorkerDetailProps { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly snapshot: WorkerSnapshot; readonly workers?: readonly WorkerSummary[]; readonly onRefresh: () => void }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function display(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''; }
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => { const item = record(part); return typeof item?.text === 'string' ? item.text : display(part); }).join('\n');
  return display(value);
}

export function WorkerDetail({ bridge, scope, snapshot, workers = [], onRefresh }: WorkerDetailProps) {
  const { summary } = snapshot;
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [steer, setSteer] = useState('');
  const [resume, setResume] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const sendControl = async (capability: 'workers.abort' | 'workers.steer' | 'workers.resume', message?: string) => {
    if (!bridge || !scope || busy) return;
    setBusy(true); setFeedback(null);
    const request = capability === 'workers.abort' ? { workerId: summary.id } : { workerId: summary.id, message: message?.trim() ?? '' };
    const result = await bridge.invoke(capability, request, scope);
    setBusy(false);
    if (!result.ok) { setFeedback(result.error.message); return; }
    if (!result.value.accepted) { setFeedback(result.value.error ?? `Action unavailable: ${result.value.reason}.`); return; }
    setFeedback(capability === 'workers.abort' ? 'Stop requested.' : capability === 'workers.steer' ? 'Steer message sent.' : 'Resume requested.');
    setConfirmAbort(false); setSteer(''); setResume(''); onRefresh();
  };
  const submit = (event: FormEvent, control: 'steer' | 'resume') => {
    event.preventDefault(); const message = control === 'steer' ? steer : resume;
    if (message.trim()) void sendControl(control === 'steer' ? WORKERS_IPC.steer : WORKERS_IPC.resume, message);
  };
  return <article className="worker-detail" aria-label={`${summary.name} details`}>
    <header className="worker-detail-heading"><div><span className="worker-type-badge">{summary.type}</span><h2>{summary.name}</h2><p>{summary.description}</p></div><span className={`worker-detail-state worker-status-${summary.status}`}>{summary.status}</span></header>
    <dl className="worker-metadata"><div><dt>Model</dt><dd>{summary.model ?? 'Not reported'}</dd></div><div><dt>Started</dt><dd>{new Date(summary.startedAt).toLocaleString()}</dd></div><div><dt>Source</dt><dd>{summary.source}</dd></div>{summary.usage && <><div><dt>Input tokens</dt><dd>{summary.usage.input.toLocaleString()}</dd></div><div><dt>Output tokens</dt><dd>{summary.usage.output.toLocaleString()}</dd></div><div><dt>Cost</dt><dd>{summary.usage.cost.toFixed(4)}</dd></div></>}</dl>
     {snapshot.ancestry.length > 0 && <p className="worker-ancestry"><strong>Ancestry:</strong> {snapshot.ancestry.map((id) => workers.find((worker) => worker.id === id)?.name ?? `Unknown (${id})`).join(' / ')}</p>}
    {summary.error && <p className="worker-detail-error" role="alert">{summary.error}</p>}
      <div className="worker-detail-controls" aria-busy={busy}>
        {!controlAvailability(summary, 'abort').available && !controlAvailability(summary, 'steer').available && !controlAvailability(summary, 'resume').available && <p className="worker-control-feedback">This provider has not advertised native Stop, Steer, or Resume controls for this worker.</p>}
        {controlAvailability(summary, 'abort').available && summary.status === 'running' && (confirmAbort ? <div role="group" aria-label="Confirm stop worker" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.preventDefault(); setConfirmAbort(false); } }}><span>Stop this worker?</span><button type="button" disabled={busy} onClick={() => void sendControl(WORKERS_IPC.abort)}>Confirm stop</button><button type="button" disabled={busy} onClick={() => setConfirmAbort(false)}>Keep running</button></div> : <button type="button" disabled={busy} onClick={() => setConfirmAbort(true)}>Stop</button>)}
        {controlAvailability(summary, 'steer').available && summary.status === 'running' && <form onSubmit={(event) => submit(event, 'steer')}><label htmlFor="worker-steer">Steer worker</label><input id="worker-steer" value={steer} onChange={(event) => setSteer(event.target.value)} placeholder="Message" /><button type="submit" disabled={busy || !steer.trim()}>Send</button></form>}
       {controlAvailability(summary, 'resume').available && summary.status !== 'running' && <form onSubmit={(event) => submit(event, 'resume')}><label htmlFor="worker-resume">Resume worker</label><input id="worker-resume" value={resume} onChange={(event) => setResume(event.target.value)} placeholder="Direction required" /><button type="submit" disabled={busy || !resume.trim()}>Resume</button></form>}
    </div>
    {feedback && <p role="status" className="worker-control-feedback">{feedback}</p>}
      <WorkerTranscript snapshot={snapshot}/>
  </article>;
}

function controlAvailability(summary: WorkerSnapshot['summary'], control: 'steer' | 'abort' | 'resume') {
  if (summary.provider === 'herdr') return { available: false, reason: 'Herdr is observed read-only; the app does not control its external TUI or processes.' }
  const details = summary.providerDetails?.nicobailon?.controls
  return details?.[control] ?? { available: false, reason: `${summary.provider ?? 'This'} provider does not advertise ${control} support.` }
}

export function WorkerTranscript({ snapshot, paging, loadingMore }: { readonly snapshot: WorkerSnapshot; readonly paging?: boolean; readonly loadingMore?: () => void }) {
  return <section className="worker-transcript" aria-label="Worker conversation"><h3>Conversation</h3>{snapshot.messages.length === 0 ? <p className="worker-transcript-empty">No conversation entries were reported for this worker.</p> : snapshot.messages.map((value, index) => {
       const message = record(value) ?? {};
       const role = typeof message.role === 'string' ? message.role : typeof message.type === 'string' ? message.type : 'entry';
       const content = message.content;
       return <article className={`worker-entry worker-entry-${role}`} key={typeof message.id === 'string' ? message.id : index}><header><strong>{role}</strong>{typeof message.timestamp === 'string' && <time>{message.timestamp}</time>}</header>
         {content !== undefined && <div className="worker-entry-content">{Array.isArray(content) ? content.map((part, partIndex) => {
           const item = record(part)
           if (item?.type === 'text' && typeof item.text === 'string') return <p key={partIndex}>{item.text}</p>
           if (item?.type === 'thinking' && typeof item.thinking === 'string') return <details key={partIndex} className="worker-thinking"><summary>Thinking</summary><p>{item.thinking}</p></details>
           if (item?.type === 'toolCall') return <div key={partIndex} className="worker-tool-call"><strong>{typeof item.name === 'string' ? item.name : 'Tool call'}</strong>{item.arguments !== undefined && <pre>{display(item.arguments)}</pre>}{item.result !== undefined && <pre className={item.isError === true ? 'worker-entry-error' : ''}>{display(item.result)}</pre>}</div>
           return <pre key={partIndex}>{display(part)}</pre>
         }) : contentText(content)}</div>}
        {typeof message.toolName === 'string' && <><strong className="worker-tool-name">{message.toolName}</strong>{message.arguments !== undefined && <pre>{display(message.arguments)}</pre>}{message.result !== undefined && <pre className={message.isError === true ? 'worker-entry-error' : ''}>{display(message.result)}</pre>}</>}
        {message.error !== undefined && <pre className="worker-entry-error">{display(message.error)}</pre>}
      </article>;
      })}{snapshot.historyComplete === false && <p className="worker-transcript-empty">The host reports additional transcript history that is not available in this snapshot.</p>}{snapshot.nextCursor !== null && <button type="button" disabled={paging} onClick={loadingMore}>{paging ? 'Loading more history…' : 'Load more history'}</button>}</section>
}

// WorkerEvent/WorkerSnapshot do not carry NativePiSessionSnapshot; parent composition owns sourcing it.
export function NativeObservedConversation({ snapshot }: { readonly snapshot: NativePiSessionSnapshot }) {
  const messages = projectNativeSession(snapshot);
  return <section aria-label="Observed native conversation" className="worker-transcript">
    <header><h3>{snapshot.name ?? 'Observed native session'}</h3></header>
    <dl className="worker-metadata">
      <div><dt>File</dt><dd>{snapshot.file ?? 'Not reported'}</dd></div><div><dt>Working directory</dt><dd>{snapshot.cwd ?? 'Not reported'}</dd></div>
      <div><dt>Classification</dt><dd>{snapshot.classification}</dd></div><div><dt>Session generation</dt><dd>{snapshot.sessionGeneration}</dd></div>
      <div><dt>Parent session ID</dt><dd>{snapshot.parentSessionId ?? 'Not reported'}</dd></div>
    </dl>
    {/* Observed sessions are view-only: no composer, submit, or terminal input. */}
    <Conversation messages={messages} lifecycle="idle" />
  </section>;
}
