import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ExtensionUIPromptRequest } from '../../shared/extension-ui';

type TextRequest = Extract<ExtensionUIPromptRequest, { readonly kind: 'input' | 'editor' }>;

export interface EditorDialogProps {
  readonly request: TextRequest;
  readonly busy: boolean;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
}

export function EditorDialog({ request, busy, onSubmit, onCancel }: EditorDialogProps) {
  const [value, setValue] = useState(request.kind === 'editor' ? request.prefill ?? '' : '');
  const fieldRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const isEditor = request.kind === 'editor';

  useEffect(() => {
    setValue(request.kind === 'editor' ? request.prefill ?? '' : '');
    requestAnimationFrame(() => fieldRef.current?.focus());
  }, [request.requestId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(value);
  };
  const editorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit(value);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="extension-dialog-heading">
        <span className="extension-dialog-kicker">EXTENSION REQUEST</span>
        <h2 id="extension-dialog-title">{request.title}</h2>
      </div>
      {isEditor ? (
        <label className="extension-field-label">
          <span>Text</span>
          <textarea
            ref={(node) => { fieldRef.current = node; }}
            className="extension-textarea"
            value={value}
            disabled={busy}
            rows={9}
            onChange={(event) => setValue(event.currentTarget.value)}
            onKeyDown={editorKeyDown}
            aria-label={request.title}
            spellCheck
          />
        </label>
      ) : (
        <label className="extension-field-label">
          <span>{request.placeholder ? 'Response' : 'Your response'}</span>
          <input
            ref={(node) => { fieldRef.current = node; }}
            className="extension-input"
            value={value}
            disabled={busy}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.currentTarget.value)}
            aria-label={request.title}
            autoComplete="off"
          />
        </label>
      )}
      <div className="extension-dialog-actions">
        <span className="extension-key-hint">{isEditor ? '⌘/Ctrl + Enter to submit' : 'Enter to submit'} · Esc to cancel{'timeout' in request && request.timeout !== undefined ? ' · automatic timeout applies' : ''}</span>
        <div className="extension-action-group">
          <button className="extension-button extension-button-quiet" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="extension-button extension-button-primary" type="submit" disabled={busy}>
            {busy ? 'Sending…' : isEditor ? 'Use text' : 'Submit'}
          </button>
        </div>
      </div>
    </form>
  );
}
