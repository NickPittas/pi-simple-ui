import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { NativeSettingsScope, SettingsDescriptor, SettingsFieldValue, SettingsReadonlyClass, SettingsValueType } from '../../shared/settings.ts'
import { validateSettingsValue } from '../../shared/settings.ts'

const effectCopy = { now: 'Applies now', reload: 'Applies after reload', 'new-session': 'Applies to new sessions', restart: 'Applies after restart' } as const
const provenanceCopy: Record<SettingsFieldValue['provenance'], string> = { user: 'User value', project: 'Project value', session: 'Session value', override: 'Override', environment: 'Environment', default: 'Default', 'native-readonly': 'Native read-only' }
function safeJson(value: unknown) { try { return JSON.stringify(value, null, 2) } catch { return String(value) } }
function enumOptions(validator: string): readonly (string | number | boolean)[] | null {
  const values: Record<string, readonly (string | number | boolean)[]> = {
    'enum:transport': ['auto', 'sse', 'websocket'], 'enum:steering': ['all', 'one-at-a-time'], 'enum:follow-up': ['all', 'one-at-a-time'], 'enum:double-escape': ['fork', 'tree', 'none'], 'enum:tree-filter': ['default', 'no-tools', 'user-only', 'labeled-only', 'all'], 'enum:mermaid': ['off', 'final', 'streaming'], 'enum:cache-warming': ['off', 'streaming', 'idle'], 'enum:tui-mode': ['fullscreen', 'regular'], 'enum:fullscreen-exit': ['transcript', 'resume-hint'], 'enum:scrollbar': ['auto', 'always', 'hidden'], 'enum:scroll-lines': ['auto', ...Array.from({ length: 100 }, (_, index) => index + 1)], 'enum:quiet-startup': [false, true, 'header'], 'enum:project-trust': ['ask', 'always', 'never'], 'boolean-or-auto': [false, true, 'auto'], 'image-mode': [false, 'auto', 'kitty', 'iterm2'], 'enum:codemode-mode': ['on', 'only'], 'enum:herdr-pane-mode': ['grouped', 'tab', 'split'], 'enum:herdr-pane-direction': ['right', 'down'], 'enum:subagents-join': ['async', 'group', 'smart'], 'enum:subagents-description': ['full', 'compact', 'custom'], 'enum:subagents-mentions': ['model', 'direct', 'off'], 'enum:subagents-widget': ['all', 'background', 'off'], 'enum:subagents-markdown': ['off', 'assistant', 'all'], 'enum:herdr-system-prompt': ['replace', 'append'], 'enum:herdr-thinking': ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  }
  if (validator === 'enum:optional-boolean') return [false, true]
  if (validator === 'string-or-false') return [false]
  if (validator === 'enum:herdr-boolean') return ['true', 'false']
  if (validator === 'enum:herdr-session-mode') return ['standalone', 'lineage-only', 'fork']
  return values[validator] ?? null
}

export interface ScopedFieldProps {
  readonly descriptor: SettingsDescriptor
  readonly field?: SettingsFieldValue
  readonly scope: NativeSettingsScope
  readonly value: unknown
  readonly dirty: boolean
  readonly busy?: boolean
  readonly changedElsewhere?: boolean
  readonly onChange: (value: unknown) => void
  readonly onSave: () => void
  readonly onReset: () => void
}

export function ScopedField({ descriptor, field, scope, value, dirty, busy = false, changedElsewhere = false, onChange, onSave, onReset }: ScopedFieldProps) {
  const [text, setText] = useState(() => Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : '')
  const [validation, setValidation] = useState<string | null>(null)
  useEffect(() => { setText(Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : ''); setValidation(null) }, [value])
  const sourceId = `settings-source-${descriptor.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const effectId = `settings-effect-${descriptor.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const options = useMemo(() => enumOptions(descriptor.validator), [descriptor.validator])
  const readonly: SettingsReadonlyClass = descriptor.readonly
  const allowed = readonly === 'editable' && (field?.editableScopes.includes(scope) ?? false)
  const toValue = (next: string): unknown => {
    if (descriptor.type === 'number') return next === '' ? null : Number(next)
    if (descriptor.type === 'string[]') return next.split('\n').map((item) => item.trim()).filter(Boolean)
    if (descriptor.type === 'boolean|string') return next === 'auto' ? 'auto' : next === 'true'
    if (descriptor.type === 'number|string') return next === 'auto' ? 'auto' : Number(next)
    if (descriptor.type === 'array' || descriptor.type === 'object' || descriptor.type === 'unknown') { try { return JSON.parse(next) } catch { return next } }
    return next
  }
  const preview = value
  const onInput = (next: string) => {
    setText(next)
    const nextValue = toValue(next)
    const valid = validateSettingsValue(descriptor, nextValue)
    setValidation(valid ? null : `Value does not match the native ${descriptor.validator} rule.`)
    onChange(nextValue)
  }
  const submit = (event: FormEvent) => { event.preventDefault(); if (!validation && dirty && allowed) onSave() }
  const input = () => {
    if (options) return <select value={String(value ?? '')} onChange={(event) => { const selected = options.find((item) => String(item) === event.target.value); if (selected !== undefined) { onChange(selected); setValidation(validateSettingsValue(descriptor, selected) ? null : `Value does not match ${descriptor.validator}.`) } }} disabled={!allowed || busy} aria-describedby={`${sourceId} ${effectId}`}><option value="" disabled>Select a value</option>{options.map((item) => <option key={String(item)} value={String(item)}>{String(item)}</option>)}</select>
    if (descriptor.type === 'boolean') return <input type="checkbox" checked={Boolean(value)} onChange={(event) => { onChange(event.target.checked); setValidation(null) }} disabled={!allowed || busy} aria-describedby={`${sourceId} ${effectId}`} />
    if (descriptor.type === 'number') return <input type="number" value={value === null || value === undefined ? '' : String(value)} onChange={(event) => onInput(event.target.value)} disabled={!allowed || busy} aria-describedby={`${sourceId} ${effectId}`} />
    if (descriptor.type === 'string') return <input type="text" value={typeof value === 'string' ? value : ''} onChange={(event) => onInput(event.target.value)} disabled={!allowed || busy} aria-describedby={`${sourceId} ${effectId}`} />
    if (descriptor.type === 'string[]' || descriptor.type === 'array' || descriptor.type === 'object' || descriptor.type === 'unknown') return <textarea rows={4} value={text} onChange={(event) => onInput(event.target.value)} disabled={!allowed || busy} aria-describedby={`${sourceId} ${effectId}`} spellCheck={false} />
    if (descriptor.type === 'number|string' || descriptor.type === 'boolean|string') return <input type="text" value={String(value ?? '')} onChange={(event) => onInput(event.target.value)} disabled={!allowed || busy} aria-describedby={`${sourceId} ${effectId}`} />
    return <input type="text" value={String(value ?? '')} onChange={(event) => onInput(event.target.value)} disabled={!allowed || busy} aria-describedby={`${sourceId} ${effectId}`} />
  }
  return <form className={`scoped-field${dirty ? ' is-dirty' : ''}`} onSubmit={submit}>
    <div className="scoped-field-heading"><div><h3>{descriptor.key}</h3>{descriptor.description && <p>{descriptor.description}</p>}</div><span id={sourceId} className={`settings-provenance provenance-${field?.provenance ?? 'default'}`}>{provenanceCopy[field?.provenance ?? 'default']}</span></div>
    <label className="settings-value-label">{descriptor.type === 'boolean' ? <>Value {input()}</> : <>Value{input()}</>}</label>
    <div className="settings-field-meta"><span id={effectId}>{effectCopy[descriptor.effect]}</span>{field && <span>Revision {field.revision}</span>}</div>
    {readonly !== 'editable' && <p className="settings-readonly-note">{descriptor.readonlyReason ?? (readonly === 'native-readonly' ? 'This value is read-only because it belongs to the native settings system.' : 'This setting is read-only in the current runtime.')}</p>}
    {!allowed && readonly === 'editable' && <p className="settings-readonly-note">This field cannot be changed in the selected scope.</p>}
    {validation && <p className="settings-field-error" role="alert">{validation}</p>}{changedElsewhere && <p className="settings-conflict-note" role="status">Changed elsewhere. The latest value has been reloaded.</p>}
    {descriptor.type === 'unknown' && preview !== undefined && <details className="settings-current-value"><summary>Current value</summary><pre>{safeJson(preview)}</pre></details>}
    {allowed && <div className="scoped-field-actions"><button type="button" disabled={!dirty || busy} onClick={onReset}>Reset</button><button type="submit" className="settings-save" disabled={!dirty || !!validation || busy}>{busy ? 'Saving…' : 'Save'}</button></div>}
  </form>
}
