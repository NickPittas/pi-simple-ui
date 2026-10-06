import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

export type ModelOption = { readonly provider: string; readonly id: string; readonly name: string }
export const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const
export const FALLBACK_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`ad-switch${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)}><span className="ad-switch-knob" /></button>
}

export function ToggleRow({ label, help, state, checked, disabled, onChange }: { label: string; help: string; state: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return <div className="ad-toggle-row"><span className="ad-toggle-text"><span className="ad-toggle-label">{label}</span><span className="ad-help">{help} <em>({state})</em></span></span><Switch checked={checked} disabled={disabled} label={label} onChange={onChange} /></div>
}

export function AutoTextarea({ value, onChange, disabled, id, rows = 3, placeholder, invalid, describedBy }: { value: string; onChange: (value: string) => void; disabled?: boolean; id: string; rows?: number; placeholder?: string; invalid?: boolean; describedBy?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const el = ref.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px` }, [value])
  return <textarea ref={ref} id={id} className="ad-input ad-autosize" rows={rows} value={value} disabled={disabled} placeholder={placeholder} aria-invalid={invalid || undefined} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)} />
}

export function listFromValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean)
  return []
}

/** Serialises chips back into the shape the field already had: array stays array, otherwise a comma-separated scalar. Empty means remove the field. */
export function serializeList(list: readonly string[], original: unknown): string[] | string | undefined {
  if (list.length === 0) return undefined
  return Array.isArray(original) ? [...list] : list.join(', ')
}

export function ChipInput({ id, value, onChange, suggestions = [], disabled, placeholder }: { id: string; value: unknown; onChange: (next: string[]) => void; suggestions?: readonly string[]; disabled?: boolean; placeholder?: string }) {
  const [draft, setDraft] = useState('')
  const chips = listFromValue(value)
  const commit = (raw: string) => {
    const additions = raw.split(',').map((item) => item.trim()).filter((item) => item && !chips.includes(item))
    if (additions.length) onChange([...chips, ...additions])
    setDraft('')
  }
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); commit(draft) }
    else if (event.key === 'Backspace' && !draft && chips.length) onChange(chips.slice(0, -1))
  }
  const open = suggestions.filter((item) => !chips.includes(item))
  return <div className="ad-chips-wrap">
    <div className={`ad-chips${disabled ? ' is-disabled' : ''}`}>
      {chips.map((chip) => <span className="ad-chip" key={chip}>{chip}{!disabled && <button type="button" aria-label={`Remove ${chip}`} onClick={() => onChange(chips.filter((item) => item !== chip))}>×</button>}</span>)}
      <input id={id} className="ad-chip-input" value={draft} disabled={disabled} placeholder={chips.length ? '' : placeholder ?? 'Type and press Enter'} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} onBlur={() => { if (draft.trim()) commit(draft) }} />
    </div>
    {!disabled && open.length > 0 && <div className="ad-suggest" aria-label="Suggestions">{open.map((item) => <button type="button" key={item} className="ad-suggest-btn" onClick={() => onChange([...chips, item])}>+ {item}</button>)}</div>}
  </div>
}

/** Value format: "provider/model-id", the form used by definition files in ~/.pi/agent/agents (e.g. zai/glm-5.3-flash). Empty value means inherit. */
export function ModelSelect({ id, value, options, onChange, disabled }: { id: string; value: string; options: readonly ModelOption[]; onChange: (next: string) => void; disabled?: boolean }) {
  const [customFlag, setCustomFlag] = useState(false)
  const known = options.some((item) => `${item.provider}/${item.id}` === value)
  const custom = customFlag || (value !== '' && !known)
  return <div className="ad-model">
    <select id={id} className="ad-input" disabled={disabled} value={custom ? '__custom' : value} onChange={(event) => { const next = event.target.value; if (next === '__custom') { setCustomFlag(true) } else { setCustomFlag(false); onChange(next) } }}>
      <option value="">Inherit (parent's model)</option>
      {options.map((item) => { const v = `${item.provider}/${item.id}`; return <option key={v} value={v}>{item.name} · {v}</option> })}
      <option value="__custom">Custom…</option>
    </select>
    {custom && <input className="ad-input ad-mono" aria-label="Custom model" placeholder="provider/model-id" disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} />}
  </div>
}

export function useUid(prefix: string) { return `${prefix}-${useId().replace(/:/g, '')}` }
