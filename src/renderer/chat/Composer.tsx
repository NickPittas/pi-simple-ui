import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts';
import type { NativePiAck } from '../../shared/native-pi';
import { CHAT_IPC, type ChatAttachment } from '../../shared/chat';
import { attachmentTypeForName, isAllowedAttachmentMimeType, isAttachmentSizeWithinLimit } from '../../shared/content';
import { AttachmentPreview, type AttachmentDescriptor } from '../security/AttachmentPreview';
import { CommandPalette } from '../commands/CommandPalette';
import { NativeCommandPalette } from '../commands/NativeCommandPalette';
import './chat.css';

export interface ComposerDraft { readonly text: string; readonly attachments?: readonly ChatAttachment[] }
export interface ComposerProps {
  readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly nativeSubmit?: (text: string) => Promise<NativePiAck>; readonly nativeAbort?: () => Promise<NativePiAck>; readonly sessionId: string; readonly draft?: ComposerDraft;
  readonly onDraftChange: (sessionId: string, draft: ComposerDraft) => void; readonly busy: boolean;
  readonly onError?: (message: string) => void; readonly onCommandResult?: (result: unknown) => void;
  readonly readAttachment?: (file: File) => Promise<{ readonly preview: AttachmentDescriptor; readonly chatAttachment: ChatAttachment } | null>;
  readonly onEditorStateChange?: (state: { readonly sessionId: string; readonly text: string; readonly selectionStart: number; readonly selectionEnd: number; readonly origin?: 'renderer' | 'native' }) => void;
  readonly nativeEditorUpdate?: { readonly sessionId: string; readonly revision: number; readonly text: string; readonly selectionStart: number; readonly selectionEnd: number } | null;
}

export function Composer({ bridge, scope, nativeSubmit, nativeAbort, sessionId, draft, onDraftChange, busy, onError, onCommandResult, readAttachment, onEditorStateChange, nativeEditorUpdate }: ComposerProps) {
  const [text, setText] = useState(draft?.text ?? '');
  const [attachments, setAttachments] = useState<Array<{ readonly preview: AttachmentDescriptor; readonly chatAttachment: ChatAttachment }>>([]);
  const [behavior, setBehavior] = useState<'steer' | 'followUp'>('followUp');
  const [palette, setPalette] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dispatchCommand, setDispatchCommand] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const nativeRevision = useRef<number | null>(null);
  useEffect(() => { setText(draft?.text ?? ''); setAttachments([]); nativeRevision.current = null; }, [sessionId]);
  useEffect(() => { onEditorStateChange?.({ sessionId, text, selectionStart: textarea.current?.selectionStart ?? text.length, selectionEnd: textarea.current?.selectionEnd ?? text.length, origin: 'renderer' }); }, [sessionId]);
  useEffect(() => {
    if (!nativeEditorUpdate || nativeEditorUpdate.sessionId !== sessionId || nativeEditorUpdate.revision === nativeRevision.current) return;
    nativeRevision.current = nativeEditorUpdate.revision;
    setText(nativeEditorUpdate.text);
    onDraftChange(sessionId, { text: nativeEditorUpdate.text });
    requestAnimationFrame(() => {
      const node = textarea.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(nativeEditorUpdate.selectionStart, nativeEditorUpdate.selectionEnd);
      node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 280)}px`;
      onEditorStateChange?.({ sessionId, text: nativeEditorUpdate.text, selectionStart: nativeEditorUpdate.selectionStart, selectionEnd: nativeEditorUpdate.selectionEnd, origin: 'native' });
    });
  }, [nativeEditorUpdate, sessionId, onDraftChange, onEditorStateChange]);
  const update = (value: string, selectionStart = textarea.current?.selectionStart ?? value.length, selectionEnd = textarea.current?.selectionEnd ?? selectionStart) => { setText(value); onDraftChange(sessionId, { text: value }); onEditorStateChange?.({ sessionId, text: value, selectionStart, selectionEnd, origin: 'renderer' }); if (value === '/') setPalette(true); };
  const invoke = useCallback(async (capability: 'chat.prompt' | 'chat.steer' | 'chat.follow-up', payload: { text: string; streamingBehavior?: 'steer' | 'followUp'; attachments?: readonly ChatAttachment[] }) => {
    if (!bridge || !scope) { onError?.('Chat is unavailable without an active runtime.'); return; }
    const result = capability === 'chat.prompt'
      ? await bridge.invoke(capability, payload, scope)
      : await bridge.invoke(capability, { text: payload.text, attachments: payload.attachments }, scope);
    if (!result.ok) onError?.(result.error.message);
    return result;
  }, [bridge, scope, onError]);
  const send = async () => {
    if (!text.trim()) return;
    if (nativeSubmit) {
      try {
        const ack = await nativeSubmit(text);
        if (ack.outcome === 'accepted') update('');
        else onError?.(ack.reason ?? `Native submission ${ack.outcome}.`);
      } catch (error) { onError?.(error instanceof Error ? error.message : 'Native submission failed.'); }
      return;
    }
    const images = attachments.map((item) => item.chatAttachment);
    const capability = busy ? (behavior === 'steer' ? 'chat.steer' : 'chat.follow-up') : 'chat.prompt';
    const result = capability === 'chat.prompt'
      ? await invoke(capability, { text, streamingBehavior: behavior, attachments: images })
      : await invoke(capability, { text, attachments: images });
    if (result?.ok && result.value.accepted) { update(''); setAttachments([]); }
  };
  const processFiles = async (files: FileList | File[]) => {
    if (nativeSubmit) return;
    setAttachmentError(null);
    for (const file of Array.from(files)) {
      if (attachmentTypeForName(file.name)?.category !== 'image') { setAttachmentError(`${file.name} is not supported here. Only image attachments can be sent.`); continue; }
      if (!isAttachmentSizeWithinLimit(file.size) || !isAllowedAttachmentMimeType(file.type)) { setAttachmentError(`${file.name} has an unsupported type or size.`); continue; }
      if (!readAttachment) { setAttachmentError('Attachment reading is not connected.'); continue; }
      const item = await readAttachment(file);
      if (item) setAttachments((current) => [...current, item]);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
    if (event.key === '/' && text.length === 0) setPalette(true);
    if (event.key === 'Escape') setPalette(false);
  };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => { if (nativeSubmit) return; const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void processFiles(files); } };
  const drop = (event: DragEvent<HTMLDivElement>) => { if (nativeSubmit) return; event.preventDefault(); void processFiles(event.dataTransfer.files); };
  return <div className="chat-composer" onDragOver={(event) => { if (!nativeSubmit) event.preventDefault(); }} onDrop={drop}>
    {!nativeSubmit && attachments.map((item) => <AttachmentPreview key={item.chatAttachment.path} attachment={item.preview} onRemove={() => setAttachments((all) => all.filter((entry) => entry !== item))} />)}
    {!nativeSubmit && attachmentError && <p className="chat-composer-error" role="alert">{attachmentError}</p>}
    <label className="chat-composer-label" htmlFor={`composer-${sessionId}`}>Message</label>
      <textarea id={`composer-${sessionId}`} ref={textarea} value={text} rows={1} placeholder="Write a message…" aria-keyshortcuts="Enter Shift+Enter Escape" onChange={(event) => { update(event.target.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd); event.currentTarget.style.height = 'auto'; event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 280)}px`; }} onSelect={(event) => onEditorStateChange?.({ sessionId, text, selectionStart: event.currentTarget.selectionStart, selectionEnd: event.currentTarget.selectionEnd, origin: 'renderer' })} onKeyDown={keyDown} onPaste={paste} aria-describedby="composer-hint" />
    <div className="chat-composer-controls"><span id="composer-hint">Enter to send · Shift+Enter for a new line</span><div>
      <input className="chat-file-input" id={`attachment-${sessionId}`} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple disabled={Boolean(nativeSubmit)} onChange={(event) => { if (event.currentTarget.files) void processFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
      <label className="chat-control-button" htmlFor={`attachment-${sessionId}`} title={nativeSubmit ? 'Not supported yet' : undefined}>{nativeSubmit ? 'Attach image (not supported yet)' : 'Attach image'}</label>
      <button type="button" className="chat-control-button" onClick={() => setPalette(true)}>Commands</button>
      {busy && <button className="chat-stop-button" type="button" disabled={Boolean(nativeSubmit) && !nativeAbort} onClick={() => { if (nativeSubmit) { if (nativeAbort) void nativeAbort().then((ack) => { if (ack.outcome !== 'accepted') onError?.(ack.reason ?? `Stop ${ack.outcome}.`); }).catch((error) => onError?.(error instanceof Error ? error.message : 'Stop failed.')); } else if (bridge && scope) void bridge.invoke(CHAT_IPC.abort, {}, scope).then((result) => { if (!result.ok) onError?.(result.error.message); }); }}>Stop</button>}
      {busy && !nativeSubmit && <label className="chat-send-mode"><input type="radio" name={`mode-${sessionId}`} checked={behavior === 'steer'} onChange={() => setBehavior('steer')} />Send now</label>}
      {busy && !nativeSubmit && <label className="chat-send-mode"><input type="radio" name={`mode-${sessionId}`} checked={behavior === 'followUp'} onChange={() => setBehavior('followUp')} />Queue follow-up</label>}
      <button className="chat-send-button" disabled={!text.trim()} type="button" onClick={() => void send()}>{nativeSubmit ? 'Send' : busy ? (behavior === 'steer' ? 'Send now' : 'Queue follow-up') : 'Send'}</button>
    </div></div>
    {palette && nativeSubmit && <NativeCommandPalette bridge={bridge} scope={scope} input={text.startsWith('/') ? text : '/'} onClose={() => { setPalette(false); textarea.current?.focus(); }} onInputChange={(value) => update(value)} onInsert={(invocation) => { update(invocation, invocation.length, invocation.length); setPalette(false); requestAnimationFrame(() => { const node = textarea.current; if (!node) return; node.focus(); node.setSelectionRange(invocation.length, invocation.length); node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 280)}px`; }); }} />}
    {palette && !nativeSubmit && <CommandPalette bridge={bridge} scope={scope} input={text.startsWith('/') ? text : '/'} onClose={() => setPalette(false)} onInputChange={(value) => update(value)} onDispatch={(result) => { onCommandResult?.(result); setDispatchCommand(true); }} />}
     {!nativeSubmit && busy && <span className="sr-only" role="status" aria-live="polite">{behavior === 'steer' ? 'Sending message to the active turn.' : 'Message will be queued as a follow-up.'}</span>}
     {dispatchCommand && <button className="chat-command-dismiss" type="button" onClick={() => setDispatchCommand(false)}>Dismiss command outcome</button>}
  </div>;
}
