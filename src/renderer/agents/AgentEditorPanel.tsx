import { useMemo, type FormEvent, type KeyboardEvent } from 'react'
import type { AgentDefinitionValidationIssue } from '../../shared/agent-definitions.ts'
import { AutoTextarea, BUILTIN_TOOLS, ChipInput, FALLBACK_THINKING_LEVELS, ModelSelect, serializeList, ToggleRow, type ModelOption } from './AgentFieldControls.tsx'
import { boolFields, boolHelp, displayValue, fieldsFor, numericFields, parseEditedValue, promotedKeys, providerLabels, scopeLabelsForDefinition, toolListKeys, toolListLabels, type Editor } from './agentDefinitionModel.ts'

type Props = {
  editor: Editor
  setEditor: (next: Editor) => void
  busy: boolean
  dirty: boolean
  canEditExisting: boolean
  canWrite: boolean
  canOverride: boolean
  confirmDelete: boolean
  setConfirmDelete: (value: boolean) => void
  fieldErrors: Record<string, string>
  clearFieldError: (key: string) => void
  issues: readonly AgentDefinitionValidationIssue[]
  error: string | null
  notice: string | null
  modelOptions: readonly ModelOption[]
  thinkingLevels: readonly string[]
  onSave: (event: FormEvent) => void
  onRevert: () => void
  onDelete: () => void
  onOverride: () => void
  onBack: () => void
}

export function AgentEditorPanel(p: Props) {
  const { editor, busy, canEditExisting, fieldErrors } = p
  const readOnly = editor.mode === 'edit' && !canEditExisting
  const locked = busy || readOnly
  const names = useMemo(() => [...new Set([...fieldsFor(editor.provider, editor.kind), ...Object.keys(editor.fields).filter((key) => key !== 'name')])], [editor.provider, editor.kind, editor.fields])
  const has = (key: string) => names.includes(key)
  const present = (key: string) => Object.hasOwn(editor.fields, key) && !editor.clearFields.has(key)
  const setField = (key: string, value: unknown) => {
    const fields = { ...editor.fields }
    const cleared = new Set(editor.clearFields)
    if (value === undefined) { const was = present(key); delete fields[key]; if (editor.mode === 'edit' && was) cleared.add(key) }
    else { fields[key] = value; cleared.delete(key) }
    p.setEditor({ ...editor, fields, clearFields: cleared })
    p.clearFieldError(key)
  }
  const levels = p.thinkingLevels.length ? p.thinkingLevels : FALLBACK_THINKING_LEVELS
  const thinking = editor.fields.thinking
  const thinkingValue = !present('thinking') ? '' : thinking === false ? '__false' : String(thinking)
  const modelValue = present('model') && typeof editor.fields.model === 'string' ? editor.fields.model : ''
  const description = typeof editor.fields.description === 'string' ? editor.fields.description : ''
  const bools = names.filter((key) => boolFields.has(key))
  const toolKeys = toolListKeys.filter(has)
  const extras = names.filter((key) => !promotedKeys.has(key))
  const summary = Object.entries(fieldErrors)
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); p.onSave(event as unknown as FormEvent) } }
  const title = editor.mode === 'create' ? (editor.source ? `Override “${editor.name}”` : 'New definition') : editor.name
  const sourceLine = editor.source ? `${scopeLabelsForDefinition[editor.source.scope]}${editor.source.provenance !== editor.source.scope ? ` (from ${scopeLabelsForDefinition[editor.source.provenance]})` : ''}` : editor.scope === 'project' ? 'Project' : 'User'
  const pathText = editor.source ? `${editor.source.fileName}${editor.source.path ? ` · ${editor.source.path}` : ''}` : ''
  const err = (key: string) => fieldErrors[key] ? <p id={`ad-err-${key}`} className="ad-error" role="alert">{fieldErrors[key]}</p> : null
  return <form className="ad-editor" onSubmit={p.onSave} onKeyDown={keyDown} aria-label="Agent definition editor" aria-busy={busy}>
    <div className="ad-editor-head">
      <button type="button" className="ad-btn ad-back" onClick={p.onBack}>← Back to list</button>
      <div className="ad-editor-title"><h2>{title}{p.dirty && <span className="ad-dirty" title="Unsaved changes" aria-label="Unsaved changes" />}</h2>
        <p className="ad-meta">{providerLabels[editor.provider]}{editor.kind ? ` · ${editor.kind}` : ''} · {sourceLine}{editor.source?.shadowed ? ' · shadowed' : ''}</p>
        {pathText && <p className="ad-meta ad-path" title={pathText}>{pathText}</p>}</div>
    </div>
    <div className="ad-editor-body">
      {readOnly && <div className="ad-banner ad-banner-warn" role="status"><span>Read-only ({editor.source ? scopeLabelsForDefinition[editor.source.scope].toLowerCase() : 'source'}). Create an override in User or Project to customize.</span><button type="button" className="ad-btn ad-btn-primary" disabled={!p.canOverride || busy} onClick={p.onOverride}>Create override</button></div>}
      {p.notice && <p className="ad-banner ad-banner-ok" role="status" aria-live="polite">{p.notice}</p>}
      {p.issues.length > 0 && <ul className="ad-issues" aria-label="Provider validation diagnostics">{p.issues.map((item, index) => <li key={`${item.code}:${item.field ?? ''}:${index}`}>{item.field && <strong>{item.field}: </strong>}{item.message}</li>)}</ul>}
      {editor.provider === 'herdr' && editor.kind === 'task' && <p className="ad-banner ad-banner-warn">Herdr task markdown is app-managed; the native extension does not parse tasks/*.md. Its enablement controls app dispatch only.</p>}
      <fieldset className="ad-fieldset" disabled={locked}>
        <div className="ad-field"><label htmlFor="ad-name">Name</label>
          <input id="ad-name" className="ad-input" required maxLength={editor.provider === 'herdr' ? 64 : 256} pattern={editor.provider === 'herdr' ? '[A-Za-z0-9][A-Za-z0-9._-]{0,63}' : '[^:]+'} value={editor.name} aria-invalid={!!fieldErrors.name} aria-describedby={fieldErrors.name ? 'ad-err-name' : 'ad-name-help'} onChange={(event) => { p.setEditor({ ...editor, name: event.target.value }); p.clearFieldError('name') }} />
          {err('name')}<p id="ad-name-help" className="ad-help">{editor.mode === 'edit' && editor.source ? `Native name. File stays ${editor.source.fileName}; the provider validates the name on save.` : `Validated by ${providerLabels[editor.provider]}; diagnostics appear after save.`}</p></div>
        {has('description') && <div className="ad-field"><label htmlFor="ad-description">Description</label>
          <AutoTextarea id="ad-description" rows={3} value={description} invalid={!!fieldErrors.description} describedBy={fieldErrors.description ? 'ad-err-description' : undefined} onChange={(value) => setField('description', value === '' ? undefined : value)} />{err('description')}</div>}
        {(has('model') || has('thinking')) && <div className="ad-row">
          {has('model') && <div className="ad-field"><label htmlFor="ad-model">Model</label><ModelSelect id="ad-model" key={editor.id ?? 'new'} value={modelValue} options={p.modelOptions} onChange={(next) => setField('model', next === '' ? undefined : next)} /><p className="ad-help">Stored as provider/model-id.</p></div>}
          {has('thinking') && <div className="ad-field"><label htmlFor="ad-thinking">Thinking</label>
            <select id="ad-thinking" className="ad-input" value={thinkingValue} onChange={(event) => { const v = event.target.value; setField('thinking', v === '' ? undefined : v === '__false' ? false : v) }}>
              <option value="">Inherit</option>
              {thinkingValue === '__false' && <option value="__false">false (disabled)</option>}
              {thinkingValue && thinkingValue !== '__false' && !levels.includes(thinkingValue) && <option value={thinkingValue}>{thinkingValue}</option>}
              {levels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select></div>}
        </div>}
        {toolKeys.map((key) => <div className="ad-field" key={key}><label htmlFor={`ad-${key}`}>{toolListLabels[key]}</label>
          <ChipInput id={`ad-${key}`} value={present(key) ? editor.fields[key] : undefined} suggestions={BUILTIN_TOOLS} onChange={(list) => setField(key, serializeList(list, editor.fields[key]))} />
          <p className="ad-help">Enter or comma adds a tool; Backspace removes the last.</p></div>)}
        {bools.length > 0 && <div className="ad-field"><span className="ad-label">Behaviour</span><div className="ad-toggles">{bools.map((key) => <ToggleRow key={key} label={key} help={boolHelp[key] ?? 'Native flag.'} state={present(key) ? String(editor.fields[key]) : 'not set'} checked={present(key) && editor.fields[key] === true} onChange={(next) => setField(key, next)} />)}</div></div>}
        <div className="ad-field"><label htmlFor="ad-prompt">Prompt (Markdown body)</label>
          <textarea id="ad-prompt" className="ad-input ad-prompt" value={editor.prompt} onChange={(event) => p.setEditor({ ...editor, prompt: event.target.value })} spellCheck={false} />
          <p className="ad-help ad-count">{editor.prompt.length.toLocaleString()} characters</p></div>
        {extras.length > 0 && <details className="ad-more"><summary>More fields <span>{extras.length}</span></summary><div className="ad-more-grid">{extras.map((key) => {
          const value = editor.fields[key]
          const isPresent = present(key)
          return <div className="ad-field" key={key}><label htmlFor={`ad-f-${key}`}>{key}</label>
            <textarea id={`ad-f-${key}`} className="ad-input ad-mono" rows={numericFields.has(key) ? 1 : 2} value={isPresent ? displayValue(value) : ''} placeholder={isPresent ? '' : 'Not specified'} aria-invalid={!!fieldErrors[key]} onChange={(event) => setField(key, parseEditedValue(key, event.target.value))} />
            {isPresent && <button type="button" className="ad-btn ad-btn-danger ad-btn-sm" aria-label={`Remove ${key} frontmatter field`} onClick={() => setField(key, undefined)}>Remove field</button>}{err(key)}</div>
        })}</div></details>}
      </fieldset>
    </div>
    <div className="ad-footer">
      {(summary.length > 0 || p.error) && <div className="ad-summary" role="alert">{p.error && <p>{p.error}</p>}{summary.map(([key, message]) => <p key={key}><strong>{key}:</strong> {message}</p>)}</div>}
      {p.confirmDelete ? <div className="ad-footer-row"><span className="ad-confirm-text">Delete <strong>{editor.name}</strong>{editor.source ? ` (${editor.source.fileName})` : ''}? This cannot be undone.</span><button type="button" className="ad-btn" disabled={busy} onClick={() => p.setConfirmDelete(false)}>Keep</button><button type="button" className="ad-btn ad-btn-danger" disabled={busy} onClick={p.onDelete}>{busy ? 'Deleting…' : 'Confirm delete'}</button></div>
        : <div className="ad-footer-row"><span className="ad-footer-state">{p.dirty ? 'Unsaved changes' : 'No changes'}</span>
          {canEditExisting && <button type="button" className="ad-btn ad-btn-danger" disabled={busy} onClick={() => p.setConfirmDelete(true)}>Delete…</button>}
          <button type="button" className="ad-btn" disabled={busy || !p.dirty} onClick={p.onRevert}>Revert</button>
          <button type="submit" className="ad-btn ad-btn-primary" disabled={busy || !p.canWrite || readOnly} title="Ctrl/Cmd+S">{busy ? 'Saving…' : editor.mode === 'create' ? 'Create definition' : 'Save definition'}</button></div>}
    </div>
  </form>
}
