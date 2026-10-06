import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts';
import type { NativeCommandEntry } from '../../shared/native-pi';
import { useDialogA11y } from '../a11y/useDialogA11y';

export interface NativeCommandPaletteProps {
  readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly input: string;
  readonly onClose: () => void; readonly onInputChange: (input: string) => void;
  /** Called with `/name ` only; the host inserts it into the draft. Nothing is dispatched from here. */
  readonly onInsert: (invocation: string) => void;
}

/** Lists Pi's own `get_commands` entries. Choosing one only edits the draft; Enter in the composer submits it to Pi. */
export function NativeCommandPalette({ bridge, scope, input, onClose, onInputChange, onInsert }: NativeCommandPaletteProps) {
  const [commands, setCommands] = useState<readonly NativeCommandEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const dialogKeyDown = useDialogA11y(dialogRef, onClose);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let current = true;
    if (!bridge || !scope) { setError('Commands are unavailable without an active runtime.'); setLoading(false); return () => { current = false; }; }
    void bridge.invoke('native.pi.commands-list', {}, scope).then((result) => {
      if (!current) return;
      setLoading(false);
      if (!result.ok) { setError(result.error.message); return; }
      if (result.value.error) setError(result.value.error);
      setCommands(result.value.commands);
    }).catch(() => { if (current) { setLoading(false); setError('Could not load commands from Pi.'); } });
    return () => { current = false; };
  }, [bridge, scope]);
  const query = (input.trim().replace(/^\//, '').split(/\s+/, 1)[0] ?? '').toLowerCase();
  const filtered = useMemo(() => commands.filter((entry) => entry.name.toLowerCase().startsWith(query)), [commands, query]);
  const choose = (entry: NativeCommandEntry) => onInsert(`/${entry.name} `);
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0))); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); if (filtered[active] && !input.trim().includes(' ')) choose(filtered[active]); else onClose(); }
  };
  return <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Commands" onKeyDown={dialogKeyDown}>
      <label htmlFor="command-palette-input">Find a command</label>
      <input ref={inputRef} data-dialog-initial-focus id="command-palette-input" value={input} onChange={(event) => { onInputChange(event.target.value); setActive(0); }} onKeyDown={onKeyDown} role="combobox" aria-expanded="true" aria-controls="command-palette-options" aria-activedescendant={filtered[active] ? `command-option-${active}` : undefined} />
      <ul id="command-palette-options" role="listbox" aria-label="Available commands">{filtered.map((entry, index) => <li id={`command-option-${index}`} role="option" aria-selected={index === active} key={`${entry.name}:${entry.source}`}><button type="button" tabIndex={-1} onMouseEnter={() => setActive(index)} onClick={() => choose(entry)}><span><strong>/{entry.name}</strong><small>{entry.description ?? ''}</small></span><span className="command-source">{entry.source}</span></button></li>)}</ul>
      {loading && <p role="status">Loading commands from Pi…</p>}
      {!loading && !filtered.length && !error && <p>No matching commands.</p>}
      {error && <p role="alert">{error}</p>}
      <p className="command-palette-hint">↑↓ Navigate · Enter insert · Esc close</p>
    </section>
  </div>;
}
