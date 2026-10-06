import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts';
import { isCommandAutocompleteResponse } from '../../shared/commands';
import type { CommandCatalogEntry, CommandCatalogResponse, CommandDispatchResponse } from '../../shared/commands';
import { useDialogA11y } from '../a11y/useDialogA11y';

export interface CommandPaletteProps { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly input: string; readonly onClose: () => void; readonly onInputChange: (input: string) => void; readonly onDispatch?: (result: CommandDispatchResponse) => void }
function fuzzyMatch(query: string, candidate: string): boolean {
  const normalized = query.toLowerCase(); let cursor = 0;
  for (const char of candidate.toLowerCase()) if (char === normalized[cursor]) cursor++;
  return cursor === normalized.length;
}

export function CommandPalette({ bridge, scope, input, onClose, onInputChange, onDispatch }: CommandPaletteProps) {
  const [commands, setCommands] = useState<readonly CommandCatalogEntry[]>([]);
  const [catalog, setCatalog] = useState<CommandCatalogResponse | null>(null);
  const [outcome, setOutcome] = useState<CommandDispatchResponse | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [menuChoice, setMenuChoice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const dialogKeyDown = useDialogA11y(dialogRef, onClose);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let current = true;
    if (!bridge || !scope) { setError('Commands are unavailable without an active runtime.'); return () => { current = false; }; }
    void bridge.invoke('commands.catalog', {}, scope).then((result) => {
      if (!current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setCatalog(result.value); setCommands(result.value.commands);
    }).catch(() => { if (current) setError('Could not load commands.'); });
    return () => { current = false; };
  }, [bridge, scope]);
  const tail = input.trim().split(/\s+/).slice(1).join(' ');
  useEffect(() => {
    if (!bridge || !scope || !tail) return;
    let current = true;
    void bridge.invoke('commands.autocomplete', { partial: input }, scope).then((result) => {
      if (current && result.ok && isCommandAutocompleteResponse(result.value)) setCommands(result.value.commands);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [bridge, scope, input, tail]);
  const query = input.trim().replace(/^\//, '').split(/\s+/, 1)[0] ?? '';
  const filtered = useMemo(() => commands.filter((entry) => fuzzyMatch(query, entry.name) || entry.aliases.some((alias) => fuzzyMatch(query, alias))), [commands, query]);
  const choose = (entry: CommandCatalogEntry) => {
    const invocation = `/${entry.name}${entry.argumentHint ? ` ` : ''}`;
    onInputChange(invocation); setOutcome(null);
    if (entry.argumentHint) return;
    void dispatch(invocation);
  };
  const dispatch = async (commandInput: string) => {
    if (!bridge || !scope) return;
    const result = await bridge.invoke('commands.dispatch', { input: commandInput }, scope);
    if (!result.ok) { setError(result.error.message); return; }
    setOutcome(result.value); onDispatch?.(result.value);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(index + 1, filtered.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); if (filtered[active] && !input.trim().includes(' ')) choose(filtered[active]); else void dispatch(input); }
  };
  return <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
     <section ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Commands" onKeyDown={dialogKeyDown}>
      <label htmlFor="command-palette-input">Find a command</label><input ref={inputRef} data-dialog-initial-focus id="command-palette-input" value={input} onChange={(event) => { onInputChange(event.target.value); setActive(0); }} onKeyDown={onKeyDown} role="combobox" aria-expanded="true" aria-controls="command-palette-options" aria-activedescendant={filtered[active] ? `command-option-${active}` : undefined} />
      <ul id="command-palette-options" role="listbox" aria-label="Available commands">{filtered.map((entry, index) => <li id={`command-option-${index}`} role="option" aria-selected={index === active} key={`${entry.name}:${entry.source}`}><button type="button" tabIndex={-1} onMouseEnter={() => setActive(index)} onClick={() => choose(entry)}><span><strong>/{entry.name}</strong><small>{entry.description}</small></span><span className="command-source">{entry.argumentHint || 'No arguments'} · {entry.source}</span></button></li>)}</ul>
      {!filtered.length && <p>No matching commands.</p>}{error && <p role="alert">{error}</p>}
      {catalog?.diagnostics.map((item) => <p key={item.invocationName} role="note">{item.message}</p>)}
      {outcome && <div className="command-outcome" role="status"><strong>{outcome.outcome}</strong><span>{'commandName' in outcome ? outcome.commandName : ''}</span>{outcome.outcome === 'rejected' && <span>{outcome.reason}</span>}{outcome.outcome === 'builtin-adapter-pending' && <span>Native UI adapter is not available yet.</span>}</div>}
      {menuChoice && <p role="status">{menuChoice}</p>}
      <p className="command-palette-hint">↑↓ Navigate · Enter run · Esc close</p>
    </section>
  </div>;
}
