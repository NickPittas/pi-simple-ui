import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { DesktopBridge, IpcResult, RuntimeScope } from '../../shared/ipc-contracts';
import {
  EXTENSION_UI_IPC,
  type ExtensionUIEvent,
  type ExtensionUIPromptRequest,
  type ExtensionUIPromptResult,
  type SemanticViewActionRequest,
  type ExtensionUIStateUpdateRequest,
  NATIVE_CUSTOM_UI_LIMITS,
  type NativeCustomUIEvent,
} from '../../shared/extension-ui';
import { EditorDialog } from './EditorDialog';
import { ExtensionStatus } from './ExtensionStatus';
import { SelectDialog } from './SelectDialog';
import './extension-ui.css';
import { SemanticViewRenderer } from './adapters';
import { useDialogA11y } from '../a11y/useDialogA11y';
import { NativeCustomTerminal, type NativeCustomTerminalView } from './NativeCustomTerminal';

import { isCommandNoticeWindowOpen } from '../chat/command-notice-window.ts';
export type ExtensionUiTransport = Pick<DesktopBridge, 'invoke' | 'subscribe'>;

export interface ExtensionUiHostProps {
  /** Current runtime identity. Omit while no trusted/current runtime is active. */
  readonly scope?: RuntimeScope;
  /** Pass the typed preload bridge as a prop; this component declares no Window globals. */
  readonly transport?: ExtensionUiTransport;
  readonly className?: string;
  readonly sessionId?: string | null;
  readonly editorState?: { readonly sessionId: string; readonly text: string; readonly selectionStart: number; readonly selectionEnd: number; readonly origin?: 'renderer' | 'native' } | null;
  readonly onEditorTextSet?: (update: { readonly sessionId: string; readonly revision: number; readonly text: string; readonly selectionStart: number; readonly selectionEnd: number }) => void;
  readonly toolsExpanded?: boolean;
  readonly onToolsExpandedSet?: (expanded: boolean) => void;
}

type SessionBinding = { readonly sessionId: string; editorRevision: number; toolsExpandedRevision: number };
type MirrorValue = { readonly editor?: { text: string; selectionStart: number; selectionEnd: number }; readonly toolsExpanded?: boolean };
type NativeCustomOutput = Extract<NativeCustomUIEvent, { readonly type: 'native-custom-output' }>;
type BufferedCustomView = NativeCustomTerminalView & { readonly scopeKey: string; readonly ready: boolean; readonly visible: boolean; readonly focused: boolean; readonly capturesInput: boolean; readonly focusRevision: number; readonly nextOutputSequence: number; readonly pending: Readonly<Record<number, NativeCustomOutput>>; readonly outputBytes: number; readonly pendingBytes: number };

function retainEvent(previous: readonly ExtensionUIEvent[], event: ExtensionUIEvent): ExtensionUIEvent[] {
  if (event.type === 'status') return [...previous.filter((item) => item.type !== 'status' || item.key !== event.key), event];
  if (event.type === 'widget') return [...previous.filter((item) => item.type !== 'widget' || item.key !== event.key), event];
  if (event.type === 'title') return [...previous.filter((item) => item.type !== 'title'), event];
  if (event.type === 'working-message' || event.type === 'working-visible' || event.type === 'working-indicator' || event.type === 'hidden-thinking-label') {
    return [...previous.filter((item) => item.type !== event.type), event];
  }
  if (event.type === 'notification' || event.type === 'unsupported') return [...previous, event].slice(-12);
  return [...previous, event];
}

function PromptFrame({ children, requestId, onKeyDown, dialogRef }: {
  readonly children: ReactNode;
  readonly requestId: string;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly dialogRef: (node: HTMLDivElement | null) => void;
}) {
  return (
    <div className="extension-modal-backdrop" data-extension-modal="true">
      <div
        className="extension-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-dialog-title"
        tabIndex={-1}
        data-request-id={requestId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <span className="extension-dialog-topline"><span className="extension-dialog-brand" aria-hidden="true">π</span> Pi extension</span>
        {children}
      </div>
    </div>
  );
}

export function ExtensionUiHost({ scope, transport, className, sessionId, editorState, onEditorTextSet, toolsExpanded, onToolsExpandedSet }: ExtensionUiHostProps) {
  const [prompts, setPrompts] = useState<ExtensionUIPromptRequest[]>([]);
  const [events, setEvents] = useState<ExtensionUIEvent[]>([]);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const [customViews, setCustomViews] = useState<readonly BufferedCustomView[]>([]);
  const [customFeedback, setCustomFeedback] = useState<{ readonly text: string; readonly terminal: boolean } | null>(null);
  const dialogNode = useRef<HTMLDivElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const bindingRef = useRef<SessionBinding | null>(null);
  const [binding, setBinding] = useState<SessionBinding | null>(null);
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const sequences = useRef(new Map<string, { editor: number; tools: number }>());
  const mirrorValues = useRef<MirrorValue>({});
  const mirrorQueues = useRef({ editor: { pending: null as unknown, timer: 0 as ReturnType<typeof setTimeout> | 0, sending: false }, tools: { pending: null as unknown, timer: 0 as ReturnType<typeof setTimeout> | 0, sending: false } });
  const latestSession = useRef(sessionId ?? null);
  latestSession.current = sessionId ?? null;
  const latestScopeKey = useRef('');
  const onEditorTextSetRef = useRef(onEditorTextSet); onEditorTextSetRef.current = onEditorTextSet;
  const onToolsExpandedSetRef = useRef(onToolsExpandedSet); onToolsExpandedSetRef.current = onToolsExpandedSet;
  const flushMirrorRef = useRef<(kind: 'editor' | 'tools') => void>(() => {});
  const nativeToolsValue = useRef<boolean | null>(null);
  mirrorValues.current = { ...(editorState ? { editor: { text: editorState.text, selectionStart: editorState.selectionStart, selectionEnd: editorState.selectionEnd } } : {}), ...(toolsExpanded !== undefined ? { toolsExpanded } : {}) };
  const hasDialog = prompts.length > 0;
  const semantic = [...events].reverse().find((event) => event.type === 'semantic-view');
  const active = prompts[0];
  const ready = !!transport && !!scope && !transportError;

  const scopeKey = scope ? `${scope.ownerId}:${scope.generation}` : 'no-scope';
  latestScopeKey.current = scopeKey;
  const customViewsRef = useRef<readonly BufferedCustomView[]>([]);
  const customReturnFocus = useRef<HTMLElement | null>(null);
  const updateCustomViews = useCallback((update: (current: readonly BufferedCustomView[]) => readonly BufferedCustomView[]) => {
    const next = update(customViewsRef.current);
    customViewsRef.current = next;
    setCustomViews(next);
  }, []);
  const customFeedbackRef = useRef<(message: string, terminal?: boolean) => void>(() => {});
  customFeedbackRef.current = (message, terminal = false) => setCustomFeedback({ text: message, terminal });

  useEffect(() => {
    if (bindingRef.current?.sessionId === (sessionId ?? null)) return;
    bindingRef.current = null;
    setBinding(null);
    for (const queue of Object.values(mirrorQueues.current)) { if (queue.timer) clearTimeout(queue.timer); queue.pending = null; }
    setMirrorError(sessionId ? 'Waiting for native session binding; local composer and tool state remain available.' : 'No active native session is bound.');
  }, [sessionId]);

  useEffect(() => {
    const stale = customViewsRef.current.some((view) => view.opened.sessionId !== (sessionId ?? null));
    if (!stale) return;
    customViewsRef.current = [];
    setCustomViews([]);
    customReturnFocus.current = null;
    setCustomFeedback({ text: 'Native custom interaction cleared after the active session changed.', terminal: true });
  }, [sessionId]);

  useEffect(() => {
    let current = true;
    let unsubscribe: (() => void) | undefined;
    setPrompts([]);
    setEvents([]);
    setReplyError(null);
    setCancelMessage(null);
    setTransportError(null);
    customViewsRef.current = [];
    setCustomViews([]);
    setCustomFeedback(null);
    customReturnFocus.current = null;
    bindingRef.current = null;
    setBinding(null);
    setMirrorError(null);
    for (const queue of Object.values(mirrorQueues.current)) { if (queue.timer) clearTimeout(queue.timer); queue.pending = null; queue.sending = false; }
    sequences.current.clear();

    if (!transport || !scope) return () => { current = false; };

    const subscribe = async () => {
      const result = await transport.subscribe(EXTENSION_UI_IPC.event, scope, (event) => {
        if (!current) return;
        // Slash-command results are shown inline in the conversation instead of the notice panel.
        if (event.type === 'notification' && isCommandNoticeWindowOpen()) return;
        if (event.type === 'native-custom-opened') {
          if (event.sessionId !== latestSession.current) {
            customFeedbackRef.current('A native custom view belongs to a different or inactive session; it was not opened here.');
            return;
          }
          const openViews = customViewsRef.current;
          if (openViews.some((view) => view.opened.viewId === event.viewId)) return;
          const top = openViews.at(-1);
          if (openViews.length >= NATIVE_CUSTOM_UI_LIMITS.maxActiveViews || event.parentViewId !== (top?.opened.viewId ?? null)) {
            customFeedbackRef.current('Native custom view nesting or parent ownership did not match the active terminal stack.');
            return;
          }
          if (openViews.length === 0) customReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          updateCustomViews((items) => [...items, { opened: event, scopeKey, ready: false, visible: false, focused: false, capturesInput: false, focusRevision: 0, chunks: [], nextOutputSequence: 1, pending: {}, outputBytes: 0, pendingBytes: 0 }]);
          setCustomFeedback(null);
          return;
        }
        if (event.type === 'native-custom-ready' || event.type === 'native-custom-focus') {
          if (event.sessionId !== latestSession.current) return;
          updateCustomViews((items) => items.map((view) => {
            if (view.opened.viewId !== event.viewId || view.opened.sessionId !== event.sessionId) return view;
            if (event.type === 'native-custom-ready' && view.opened.parentViewId !== event.parentViewId) return view;
            return { ...view, ready: view.ready || event.type === 'native-custom-ready', visible: event.visible, focused: event.focused, capturesInput: event.capturesInput, focusRevision: view.focusRevision + 1 };
          }));
          return;
        }
        if (event.type === 'native-custom-output') {
          if (event.sessionId !== latestSession.current) return;
          const byteLength = new TextEncoder().encode(event.data).byteLength;
          if (byteLength > NATIVE_CUSTOM_UI_LIMITS.maxOutputChunkBytes) {
            customFeedbackRef.current('Native terminal output exceeded the per-chunk limit.');
            return;
          }
          updateCustomViews((items) => items.map((view) => {
            if (view.opened.viewId !== event.viewId || view.opened.sessionId !== event.sessionId || event.sequence < view.nextOutputSequence || Object.hasOwn(view.pending, event.sequence)) return view;
            if (view.outputBytes + view.pendingBytes + byteLength > NATIVE_CUSTOM_UI_LIMITS.maxOutputBytesPerView) {
              customFeedbackRef.current('Native terminal output exceeded the per-view limit; waiting for the native host to close this view.');
              return view;
            }
            const pending = { ...view.pending, [event.sequence]: event };
            const chunks = [...view.chunks];
            let nextOutputSequence = view.nextOutputSequence;
            let pendingBytes = view.pendingBytes + byteLength;
            let outputBytes = view.outputBytes;
            while (pending[nextOutputSequence]) {
              const chunk = pending[nextOutputSequence]!;
              chunks.push(chunk);
              outputBytes += new TextEncoder().encode(chunk.data).byteLength;
              pendingBytes -= new TextEncoder().encode(chunk.data).byteLength;
              delete pending[nextOutputSequence];
              nextOutputSequence += 1;
            }
            return { ...view, chunks, pending, nextOutputSequence, outputBytes, pendingBytes };
          }));
          return;
        }
        if (event.type === 'native-custom-closed') {
          if (event.sessionId !== latestSession.current) return;
          const existing = customViewsRef.current;
          const index = existing.findIndex((view) => view.opened.viewId === event.viewId && view.opened.sessionId === event.sessionId);
          if (index < 0) return;
          const remaining = existing.slice(0, index);
          const expectedParent = remaining.at(-1)?.opened.viewId ?? null;
          updateCustomViews(() => remaining);
          if (expectedParent !== event.parentViewId) customFeedbackRef.current('The native terminal parent stack changed unexpectedly; stale child screens were discarded.');
          else if (event.reason === 'failed') customFeedbackRef.current(`Native extension interaction failed${event.error ? ` (${event.error})` : ''}.`, true);
          else if (event.reason === 'output-overflow') customFeedbackRef.current('Native extension interaction closed because its output limit was reached.', true);
          else customFeedbackRef.current(`Native extension interaction ${event.reason}.`, true);
          if (remaining.length === 0) {
            const target = customReturnFocus.current;
            customReturnFocus.current = null;
            if (target?.isConnected && !target.closest('[inert]')) requestAnimationFrame(() => target.focus());
          }
          return;
        }
        if (event.type === 'session-binding') {
          const next = event.sessionId && event.sessionId === latestSession.current
            ? { sessionId: event.sessionId, editorRevision: event.editorRevision, toolsExpandedRevision: event.toolsExpandedRevision }
            : null;
          bindingRef.current = next;
          setBinding(next);
          setMirrorError(null);
          if (!next) {
            for (const queue of Object.values(mirrorQueues.current)) { if (queue.timer) clearTimeout(queue.timer); queue.pending = null; }
          }
          return;
        }
        if (event.type === 'editor-text-set') {
          const active = bindingRef.current;
          const seq = active ? sequences.current.get(active.sessionId)?.editor ?? 0 : -1;
          const queue = mirrorQueues.current.editor;
          if (!active || event.sessionId !== active.sessionId || event.sessionId !== latestSession.current || event.expectedRevision !== active.editorRevision || event.expectedSequence !== seq || queue.pending !== null || queue.sending) return;
          active.editorRevision = event.revision;
          onEditorTextSetRef.current?.({ sessionId: event.sessionId, revision: event.revision, text: event.text, selectionStart: event.selectionStart, selectionEnd: event.selectionEnd });
          return;
        }
        if (event.type === 'tools-expanded-set') {
          const active = bindingRef.current;
          const seq = active ? sequences.current.get(active.sessionId)?.tools ?? 0 : -1;
          const queue = mirrorQueues.current.tools;
          if (!active || event.sessionId !== active.sessionId || event.sessionId !== latestSession.current || event.expectedRevision !== active.toolsExpandedRevision || event.expectedSequence !== seq || queue.pending !== null || queue.sending) return;
          active.toolsExpandedRevision = event.revision;
          nativeToolsValue.current = event.expanded;
          onToolsExpandedSetRef.current?.(event.expanded);
          return;
        }
        if (event.type === 'prompt') {
          setCancelMessage(null);
          setPrompts((pending) => {
            if (pending.some((item) => item.requestId === event.requestId)) return pending;
            if (pending.length === 0) previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            return [...pending, event];
          });
        } else if (event.type === 'prompt-cancelled') {
          setPrompts((pending) => pending.filter((item) => item.requestId !== event.requestId));
          const labels = {
            aborted: 'The extension request was cancelled.',
            timeout: 'The extension request timed out.',
            'session-disposed': 'The session ended before the extension request completed.',
            'renderer-disconnected': 'The extension host disconnected before the request completed.',
          };
          setCancelMessage(labels[event.reason]);
          setReplying((requestId) => requestId === event.requestId ? null : requestId);
        } else {
          setEvents((previous) => retainEvent(previous, event));
        }
      });
      if (!current) {
        if (result.ok) result.value();
        return;
      }
      if (result.ok) unsubscribe = result.value;
      else setTransportError(result.error.message);
    };

    void subscribe().catch(() => {
      if (current) setTransportError('Could not subscribe to extension UI events.');
    });

    return () => {
      current = false;
      unsubscribe?.();
      // Unsubscribing is the backend-owned cancellation path for this scope.
      // Never send a reply for a request belonging to the previous generation.
      setPrompts([]);
      setReplying(null);
    };
  }, [transport, scopeKey, updateCustomViews]);

  const enqueueMirror = useCallback((kind: 'editor' | 'tools', value: unknown) => {
    const active = bindingRef.current;
    if (!transport || !scope || !active || active.sessionId !== latestSession.current) return;
    const queue = mirrorQueues.current[kind];
    queue.pending = value;
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(() => { queue.timer = 0; flushMirrorRef.current(kind); }, 45);
  }, [transport, scope]);

  const flushMirror = useCallback(async (kind: 'editor' | 'tools') => {
    const queue = mirrorQueues.current[kind];
    if (queue.sending || queue.pending === null) return;
    const active = bindingRef.current;
    if (!transport || !scope || !active || active.sessionId !== latestSession.current) { queue.pending = null; return; }
    queue.sending = true;
    const value = queue.pending as MirrorValue['editor'] | boolean;
    queue.pending = null;
    const counters = sequences.current.get(active.sessionId) ?? { editor: 0, tools: 0 };
    counters[kind] += 1;
    sequences.current.set(active.sessionId, counters);
    const request: ExtensionUIStateUpdateRequest = kind === 'editor'
      ? { kind, sessionId: active.sessionId, baseRevision: active.editorRevision, sequence: counters.editor, ...(value as NonNullable<MirrorValue['editor']>) }
      : { kind: 'tools-expanded', sessionId: active.sessionId, baseRevision: active.toolsExpandedRevision, sequence: counters.tools, expanded: value as boolean };
    try {
      const response = await transport.invoke(EXTENSION_UI_IPC.state, request, scope);
      if (bindingRef.current !== active || latestSession.current !== active.sessionId) return;
      if (!response.ok) setMirrorError(response.error.message);
      else if (!response.value.accepted) {
        bindingRef.current = null;
        setBinding(null);
        for (const pending of Object.values(mirrorQueues.current)) { if (pending.timer) clearTimeout(pending.timer); pending.pending = null; }
        setMirrorError(`Native ${kind === 'editor' ? 'editor' : 'tool expansion'} state was not synchronized: ${response.value.reason}.`);
      } else {
        if (kind === 'editor') active.editorRevision = response.value.revision;
        else active.toolsExpandedRevision = response.value.revision;
        const label = kind === 'editor' ? 'Native editor state' : 'Native tool expansion state';
        setMirrorError((current) => current?.startsWith(`${label} was not synchronized:`) ? null : current);
      }
    } catch { if (bindingRef.current === active) setMirrorError('Could not synchronize native extension UI state.'); }
    finally {
      queue.sending = false;
      if (queue.pending !== null && bindingRef.current === active) flushMirrorRef.current(kind);
    }
  }, [transport, scope]);
  flushMirrorRef.current = (kind) => { void flushMirror(kind); };

  useEffect(() => {
    if (!binding || binding.sessionId !== sessionId) return;
    const local = mirrorValues.current;
    if (local.editor) enqueueMirror('editor', local.editor);
    if (local.toolsExpanded !== undefined) enqueueMirror('tools', local.toolsExpanded);
  }, [binding, sessionId, enqueueMirror]);

  useEffect(() => {
    if (!binding || !editorState || editorState.sessionId !== binding.sessionId || editorState.origin === 'native') return;
    enqueueMirror('editor', { text: editorState.text, selectionStart: editorState.selectionStart, selectionEnd: editorState.selectionEnd });
  }, [binding, editorState, enqueueMirror]);
  useEffect(() => {
    if (!binding || binding.sessionId !== sessionId || toolsExpanded === undefined) return;
    if (nativeToolsValue.current === toolsExpanded) { nativeToolsValue.current = null; return; }
    enqueueMirror('tools', toolsExpanded);
  }, [binding, sessionId, toolsExpanded, enqueueMirror]);

  useEffect(() => {
    if (!hasDialog) {
      const target = previousFocus.current;
      previousFocus.current = null;
      if (target?.isConnected) requestAnimationFrame(() => target.focus());
      return;
    }
    requestAnimationFrame(() => {
      const first = dialogNode.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)');
      (first ?? dialogNode.current)?.focus();
    });
  }, [hasDialog, active?.requestId]);

  const sendReply = useCallback(async (request: ExtensionUIPromptRequest, result: ExtensionUIPromptResult) => {
    if (!transport || !scope || replying) return;
    setReplying(request.requestId);
    setReplyError(null);
    setCancelMessage(null);
    try {
      const response: IpcResult<unknown> = await transport.invoke(
        EXTENSION_UI_IPC.reply,
        { requestId: request.requestId, result },
        scope,
      );
      if (!response.ok) {
        setReplyError(response.error.message);
        setReplying(null);
        return;
      }
      setPrompts((pending) => pending.filter((item) => item.requestId !== request.requestId));
      setReplying(null);
    } catch {
      setReplyError('The extension response could not be sent.');
      setReplying(null);
    }
  }, [transport, scope, replying]);

  const cancelPrompt = useCallback((request: ExtensionUIPromptRequest) => {
    const value = request.kind === 'confirm' ? false : null;
    void sendReply(request, { kind: request.kind, value } as ExtensionUIPromptResult);
  }, [sendReply]);

  const sendSemanticAction = useCallback(async (event: Extract<ExtensionUIEvent, { type: 'semantic-view' }>, action: SemanticViewActionRequest['action']) => {
    if (!transport || !scope) return;
    try {
      const result = await transport.invoke(EXTENSION_UI_IPC.action, { instanceId: event.instanceId, revision: event.revision, action }, scope);
      if (!result.ok && result.error.code === 'STALE_SCOPE') return;
      // A stale revision is deliberately not retried; the next authoritative view snapshot renders its revision.
    } catch { /* Subscription state remains authoritative. */ }
  }, [transport, scope]);

  const onDialogKeyDown = useDialogA11y(dialogNode, () => { if (active && !replying) cancelPrompt(active); }, hasDialog);
  const reportCustomFeedback = useCallback((message: string, terminal = false) => setCustomFeedback({ text: message, terminal }), []);
  const visibleCustomViews = customViews.filter((view) => view.scopeKey === scopeKey && view.opened.sessionId === (sessionId ?? null));
  const topCustomViewId = visibleCustomViews.at(-1)?.opened.viewId;

  const confirmContent = useMemo(() => {
    if (active?.kind !== 'confirm') return null;
    const busy = replying === active.requestId;
    return (
      <>
        <div className="extension-dialog-heading">
          <span className="extension-dialog-kicker">EXTENSION REQUEST</span>
          <h2 id="extension-dialog-title">{active.title}</h2>
        </div>
        <p className="extension-confirm-message">{active.message}</p>
        <div className="extension-dialog-actions">
          {active.timeout !== undefined && <span className="extension-key-hint">This request may time out automatically.</span>}
          <div className="extension-action-group">
            <button className="extension-button extension-button-quiet" type="button" disabled={busy} onClick={() => void sendReply(active, { kind: 'confirm', value: false })}>No</button>
            <button className="extension-button extension-button-primary" type="button" disabled={busy} onClick={() => void sendReply(active, { kind: 'confirm', value: true })}>{busy ? 'Sending…' : 'Yes'}</button>
          </div>
        </div>
      </>
    );
  }, [active, replying, sendReply]);

  return (
    <section className={`extension-ui-host${className ? ` ${className}` : ''}`} aria-label="Extension user interface">
      <ExtensionStatus events={events} transportReady={ready} />
      {sessionId && <p className={binding?.sessionId === sessionId && !mirrorError ? 'extension-mirror-state' : 'extension-mirror-state is-disconnected'} role="status">{binding?.sessionId === sessionId && !mirrorError ? 'Native editor and tool expansion are bound to this session.' : mirrorError ?? 'Native editor and tool expansion are not bound; local UI state remains active.'}</p>}
      {semantic?.type === 'semantic-view' && <SemanticViewRenderer viewId={semantic.viewId} version={semantic.version} ownerId={scope?.ownerId ?? 'unknown'} instanceId={semantic.instanceId} revision={semantic.revision} state={semantic.state} onAction={(action) => void sendSemanticAction(semantic, action)} />}
      {visibleCustomViews.map((view) => <NativeCustomTerminal key={view.opened.viewId} view={view} active={view.opened.viewId === topCustomViewId && view.visible} ready={view.ready} focused={view.focused} capturesInput={view.capturesInput} focusRevision={view.focusRevision} bridge={transport} scope={scope} onFeedback={reportCustomFeedback} />)}
      {customFeedback && <p className={customFeedback.terminal ? 'native-custom-terminal-feedback is-terminal' : 'native-custom-terminal-feedback'} role={customFeedback.terminal ? 'status' : 'alert'}>{customFeedback.text}</p>}
      {transportError && <p className="extension-transport-error" role="alert">Extension UI is unavailable: {transportError}</p>}
      {cancelMessage && <p className="extension-cancel-message" role="status">{cancelMessage}</p>}
      {replyError && <p className="extension-reply-error" role="alert">{replyError}</p>}
      {!transport && <p className="extension-host-note">No extension UI transport is attached to this view.</p>}
      {active && (
        <PromptFrame requestId={active.requestId} dialogRef={(node) => { dialogNode.current = node; }} onKeyDown={onDialogKeyDown}>
          {active.kind === 'select' && <SelectDialog request={active} busy={replying === active.requestId} onSelect={(value) => void sendReply(active, { kind: 'select', value })} onCancel={() => cancelPrompt(active)} />}
          {active.kind === 'confirm' && confirmContent}
          {(active.kind === 'input' || active.kind === 'editor') && <EditorDialog request={active} busy={replying === active.requestId} onSubmit={(value) => void sendReply(active, { kind: active.kind, value })} onCancel={() => cancelPrompt(active)} />}
        </PromptFrame>
      )}
    </section>
  );
}

export default ExtensionUiHost;
