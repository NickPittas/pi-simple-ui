import { useEffect, useMemo, useRef, useState } from 'react';
import type { NativeModelChoice, NativeModelState, NativeThinkingLevel } from '../../shared/native-pi.ts';
import { fuzzyFilter } from '../models/fuzzy.ts';
import './model-picker.css';

type Props = { state: NativeModelState | null; pending: boolean; loading: boolean; error: string | null; onModel: (provider: string, id: string) => void; onThinking: (level: NativeThinkingLevel) => void };
export function NativeModelControls({ state, pending, loading, error, onModel, onThinking }: Props) {
  const disabled = pending || loading || !state || state.busy;
  const active = state?.model;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [index, setIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const source = state ? (state.scoped && showAll ? state.allModels : state.models) : [];
  const missing = !!active && !source.some((m) => m.provider === active.provider && m.id === active.id);
  const options = useMemo(() => {
    const found = fuzzyFilter(source, query, (m) => [m.name, m.id, `${m.provider}/${m.id}`]);
    return missing && active && !query.trim() ? [active, ...found] : found;
  }, [source, query, missing, active]);
  const close = (refocus: boolean) => { setOpen(false); setQuery(''); if (refocus) button.current?.focus(); };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const choose = (m: NativeModelChoice) => { onModel(m.provider, m.id); close(true); };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => Math.min(i + 1, options.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); const m = options[index]; if (m) choose(m); }
    else if (event.key === 'Escape') { event.preventDefault(); close(true); }
  };
  return <div className="chat-composer-controls">
    <div className="model-picker" ref={root}>
      <span>Model</span>
      <button type="button" ref={button} className="model-picker-button" aria-label="Model" aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => { setIndex(0); setOpen((v) => !v); }}>{active?.name ?? 'Select model'}</button>
      {open && <div className="model-picker-popover" onKeyDown={onKey}>
        <input autoFocus aria-label="Search models" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} placeholder="Search models…" />
        <ul role="listbox" aria-label="Models">
          {options.map((m, i) => {
            const isCurrent = missing && active === m;
            return <li key={`${m.provider}/${m.id}`} role="option" aria-selected={i === index} className={i === index ? 'is-active' : undefined} onMouseEnter={() => setIndex(i)} onClick={() => choose(m)}>{m.name}{isCurrent && ' (current)'}</li>;
          })}
          {!options.length && <li className="model-picker-empty">No models match</li>}
        </ul>
        {state?.scoped && <button type="button" className="model-picker-toggle" onClick={() => { setShowAll((v) => !v); setIndex(0); }}>{showAll ? 'Show scoped only' : `Show all models (${state.allModels.length})`}</button>}
      </div>}
    </div>
    {missing && <small>Current model is not in the available catalogue.</small>}
    <label>Thinking <select aria-label="Thinking" disabled={disabled} value={state?.thinkingLevel ?? ''} onChange={(event) => onThinking(event.target.value as NativeThinkingLevel)}>
      {state?.thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
    </select></label>
    {loading && <small>Loading native controls…</small>}{error && <small role="alert">{error}</small>}
  </div>;
}
