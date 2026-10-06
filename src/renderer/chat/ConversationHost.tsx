import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import { InlineWorkerConversations } from '../workers/InlineWorkerConversations.tsx';
import { useNativeConversations } from './useNativeConversations.ts';
import { selectMessages, selectStatus } from './native-conversation.ts';
import type { ComposerDraft } from './Composer';
import { Composer } from './Composer';
import { Conversation, type ConversationLifecycle } from './Conversation';
import { NativePiTerminal } from '../extensions/NativePiTerminal.tsx';
import { SubagentConversation } from './SubagentConversation.tsx';
import { ObservedSubagentsPage } from '../workers/ObservedSubagentsPage.tsx';
import { collectSubagents, type SubagentRef } from './subagents.ts';
import './subagents.css';

interface Props { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly onNavigate?: (area: 'providers' | 'models' | 'sessions' | 'settings' | 'help' | 'workers', intent?: string) => void; readonly showSubagentsToken?: number; readonly onShowSubagentsConsumed?: () => void }

export function ConversationHost({ bridge, scope, onNavigate, showSubagentsToken, onShowSubagentsConsumed }: Props) {
  const [terminalOpen, setTerminalOpen] = useState(false);
  return <div className="conversation-host">
    <button type="button" className="terminal-toggle" aria-expanded={terminalOpen} onClick={() => setTerminalOpen((open) => !open)}>{terminalOpen ? 'Hide terminal' : 'Show terminal'}</button>
    <div className={`terminal-drawer${terminalOpen ? ' terminal-drawer-open' : ''}`} aria-hidden={!terminalOpen}>
      <div className="terminal-drawer-inner">{terminalOpen && <NativePiTerminal bridge={bridge} scope={scope} />}</div>
    </div>
    {!bridge && <p role="alert" className="conversation-host-error">Native conversation is unavailable without the desktop bridge.</p>}
    {bridge && <NativeConversationHost bridge={bridge} scope={scope} onNavigate={onNavigate} showSubagentsToken={showSubagentsToken} onShowSubagentsConsumed={onShowSubagentsConsumed} />}
    {!bridge && <InlineWorkerConversations bridge={bridge} scope={scope} onOpenWorker={(workerId) => onNavigate?.('workers', workerId)} />}
  </div>;
}

function useWideWindow(): boolean {
  const query = '(min-width: 960px)';
  const [wide, setWide] = useState(() => typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query), update = () => setWide(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return wide;
}

type SubagentPanel = { readonly kind: 'list' } | { readonly kind: 'view'; readonly ref: SubagentRef };
// Navigation: list <-> viewer. `lastFile` remembers the last opened subagent so the list can mark it.

function NativeConversationHost({ bridge, scope, onNavigate, showSubagentsToken, onShowSubagentsConsumed }: { readonly bridge: DesktopBridge; readonly scope?: RuntimeScope; readonly onNavigate?: Props['onNavigate']; readonly showSubagentsToken?: number; readonly onShowSubagentsConsumed?: () => void }) {
  const { state, report, error: hookError } = useNativeConversations({ bridge, scope });
  const [draft, setDraft] = useState<ComposerDraft>({ text: '' });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toolsExpanded, setToolsExpanded] = useState(true);
  const composerRef = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<SubagentPanel | null>(null);
  const [lastFile, setLastFile] = useState<string | null>(null);
  const listScrollRef = useRef(0);
  const wide = useWideWindow();
  const scopeKey = scope ? `${scope.ownerId}:${scope.generation}` : 'no-runtime';
  const status = selectStatus(state);
  const lifecycle: ConversationLifecycle = hookError || submitError ? 'error' : !status.generation || !status.hasRoot ? 'idle' : status.streaming ? 'streaming' : 'idle';

  useEffect(() => { requestAnimationFrame(() => composerRef.current?.querySelector('textarea')?.focus()); }, [scopeKey]);
  const onDraftChange = useCallback((_sessionId: string, nextDraft: ComposerDraft) => setDraft(nextDraft), []);
  const nativeSubmit = useCallback((text: string) => {
    setSubmitError(null);
    if (!state.sessionId) return Promise.reject(new Error('Native conversation session is not available yet.'));
    return bridge.invoke('native.pi.submit', {
      requestId: crypto.randomUUID(), sessionId: state.sessionId, sessionGeneration: state.generation, text,
    }, scope).then((result) => {
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, [bridge, scope, state.sessionId, state.generation]);
  const nativeAbort = useCallback(() => {
    if (!state.sessionId) return Promise.reject(new Error('Native conversation session is not available yet.'));
    return bridge.invoke('native.pi.abort', { requestId: crypto.randomUUID(), sessionId: state.sessionId, sessionGeneration: state.generation }, scope).then((result) => {
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
  }, [bridge, scope, state.sessionId, state.generation]);
  const messages = selectMessages(state);
  const subagents = collectSubagents(messages);
  const openSubagent = useCallback((ref: SubagentRef) => { setLastFile(ref.file); setPanel({ kind: 'view', ref }); }, []);
  const backToList = useCallback(() => setPanel({ kind: 'list' }), []);
  const closePanel = useCallback(() => setPanel(null), []);
  useEffect(() => { if (showSubagentsToken) { setPanel({ kind: 'list' }); onShowSubagentsConsumed?.(); } }, [showSubagentsToken]);
  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setPanel((current) => current?.kind === 'view' ? { kind: 'list' } : null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel !== null]);
  // Keep the viewer's status current with the parent tool call (the open ref is only a snapshot from click time).
  const viewRef = panel?.kind === 'view' ? subagents.find((item) => item.file === panel.ref.file) ?? panel.ref : null;
  const findings = [
    ...report.duplicates.map((item) => `Duplicate: ${item}`),
    ...report.gaps.map((item) => `Gap (${item.source}): ${item.reference}`),
    ...report.stale.map((item) => `Stale: ${item}`),
    ...report.droppedLateEvents.map((item) => `Dropped late event: ${item}`),
  ];

  return <>
    {(hookError || submitError) && <p role="alert" className="conversation-host-error">{hookError ?? submitError}</p>}
    {findings.length > 0 && <details className="conversation-host-error"><summary>Conversation diagnostics ({findings.length})</summary><ul>{findings.map((finding, index) => <li key={`${index}:${finding}`}>{finding}</li>)}</ul></details>}
    <div className="conversation-split">
      <div className="conversation-main">
        <Conversation messages={messages} lifecycle={lifecycle} toolsExpanded={toolsExpanded} onToolsExpandedChange={setToolsExpanded} onOpenSubagent={openSubagent} />
        <InlineWorkerConversations nativeChildren={[]} onOpenWorker={(workerId) => onNavigate?.('workers', workerId)} />
        <div ref={composerRef}><Composer key="native-composer" sessionId={state.sessionId ?? ''} draft={draft} onDraftChange={onDraftChange} nativeSubmit={nativeSubmit} nativeAbort={nativeAbort} bridge={bridge} scope={scope} busy={status.streaming} onError={setSubmitError} /></div>
      </div>
      {panel && <>
        {!wide && <button type="button" className="subagent-backdrop" aria-label="Close subagent panel" onClick={closePanel} />}
        <aside className="subagent-panel" role={wide ? 'complementary' : 'dialog'} aria-label={viewRef ? `Subagent conversation: ${viewRef.label}` : 'Observed subagents'} {...(wide ? {} : { 'aria-modal': true })}>
          {viewRef ? <SubagentConversation key={viewRef.file} bridge={bridge} scope={scope} refInfo={viewRef} onClose={closePanel} onBack={backToList} /> : <ObservedSubagentsPage subagents={subagents} selectedFile={lastFile} onOpen={openSubagent} onClose={closePanel} initialScrollTop={listScrollRef.current} onScrollTop={(top) => { listScrollRef.current = top; }} />}
        </aside>
      </>}
    </div>
  </>;
}
