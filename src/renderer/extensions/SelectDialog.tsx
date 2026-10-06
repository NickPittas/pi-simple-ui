import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ExtensionUIPromptRequest } from '../../shared/extension-ui';

type SelectRequest = Extract<ExtensionUIPromptRequest, { readonly kind: 'select' }>;

export interface SelectDialogProps {
  readonly request: SelectRequest;
  readonly busy: boolean;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

export function SelectDialog({ request, busy, onSelect, onCancel }: SelectDialogProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setActiveIndex(0);
    requestAnimationFrame(() => optionRefs.current[0]?.focus());
  }, [request.requestId]);

  const move = (index: number) => {
    if (request.options.length === 0) return;
    const next = (index + request.options.length) % request.options.length;
    setActiveIndex(next);
    optionRefs.current[next]?.focus();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(activeIndex + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(activeIndex - 1); }
    else if (event.key === 'Home') { event.preventDefault(); move(0); }
    else if (event.key === 'End') { event.preventDefault(); move(request.options.length - 1); }
  };

  return (
    <>
      <div className="extension-dialog-heading">
        <span className="extension-dialog-kicker">EXTENSION REQUEST</span>
        <h2 id="extension-dialog-title">{request.title}</h2>
      </div>
      <div
        className="extension-select-list"
        role="listbox"
        aria-label={request.title}
        onKeyDown={onListKeyDown}
      >
        {request.options.map((option, index) => (
          <button
            className={`extension-option${index === activeIndex ? ' extension-option-active' : ''}`}
            id={`extension-option-${request.requestId}-${index}`}
            key={`${index}-${option}`}
            ref={(node) => { optionRefs.current[index] = node; }}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            tabIndex={index === activeIndex ? 0 : -1}
            disabled={busy}
            onFocus={() => setActiveIndex(index)}
            onClick={() => onSelect(option)}
          >
            <span>{option}</span>
            <span className="extension-option-arrow" aria-hidden="true">↵</span>
          </button>
        ))}
        {request.options.length === 0 && <p className="extension-empty-options">This request has no choices.</p>}
      </div>
      <div className="extension-dialog-actions">
        <span className="extension-key-hint">↑↓ to move · Enter to choose · Esc to cancel{request.timeout !== undefined ? ' · automatic timeout applies' : ''}</span>
        <button className="extension-button extension-button-quiet" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}
