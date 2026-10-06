import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { PackageScope } from '../../shared/packages.ts'
import { AutoTextarea, BUILTIN_TOOLS, ChipInput, Switch } from '../agents/AgentFieldControls.tsx'
import { SKILL_KNOWN_KEYS, TEMPLATE_KNOWN_KEYS, parseFrontmatter, sameDraft, skillNameIssues, sourceBadge, templateNameIssues, type Draft, type Editor, type ResourceKind } from './resourceModel.ts'

type Props = {
  kind: ResourceKind
  editor: Editor
  baseline: Draft
  setDraft: (next: Draft) => void
  busy: boolean
  /** False when this scope cannot be written (project without trust). */
  canWrite: boolean
  readOnlyReason: string | null
  canCopyTo: (scope: PackageScope) => boolean
  confirmDelete: boolean
  setConfirmDelete: (value: boolean) => void
  error: string | null
  onSave: () => void
  onRevert: () => void
  onDelete: () => void
  onCopy: (scope: PackageScope) => void
  onBack: () => void
}

const SUBSTITUTIONS: readonly (readonly [string, string])[] = [
  ['$1, $2, …', 'Positional arguments'],
  ['$@  or  $ARGUMENTS', 'All arguments joined with spaces'],
  ['${@:N}  ·  ${@:N:L}', 'Arguments from position N (optionally L of them)'],
  ['${1:-default}', 'Argument 1, or "default" when it is missing'],
]

export function ResourceEditorPanel(p: Props) {
  const { kind, editor, busy } = p
  const { draft } = editor
  const isSkill = kind === 'skill'
  const creating = editor.mode === 'create'
  const readOnly = !!p.readOnlyReason
  const locked = busy || readOnly
  const changed = !sameDraft(draft, p.baseline)
  const dirty = changed || creating
  const [copied, setCopied] = useState(false)
  const set = (patch: Partial<Draft>) => p.setDraft({ ...draft, ...patch })
  const nameProblems = useMemo(() => isSkill ? skillNameIssues(draft.name) : templateNameIssues(draft.name), [isSkill, draft.name])
  const nameBlocks = creating && nameProblems.length > 0
  const descMissing = isSkill && draft.description.trim() === ''
  const descTooLong = isSkill && draft.description.length > 1024
  const invalid = nameBlocks || descMissing || descTooLong || (!isSkill && creating && draft.name.trim() === '')
  const known = isSkill ? SKILL_KNOWN_KEYS : TEMPLATE_KNOWN_KEYS
  const extras = useMemo(() => [...parseFrontmatter(editor.doc?.frontmatterRaw)].filter(([key]) => !known.has(key)), [editor.doc?.frontmatterRaw, known])
  const invocation = isSkill ? `/skill:${draft.name || '<name>'}` : `/${draft.name || '<name>'}`
  const copy = () => { try { void navigator.clipboard.writeText(invocation).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => undefined) } catch { /* clipboard unavailable */ } }
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!invalid && dirty && !locked && p.canWrite) p.onSave() } }
  const submit = (event: FormEvent) => { event.preventDefault(); if (!invalid && !locked && p.canWrite) p.onSave() }
  const doc = editor.doc
  const title = creating ? (editor.copyOf ? `Customize “${draft.name}”` : isSkill ? 'New skill' : 'New template') : draft.name
  const meta = doc ? `${sourceBadge(doc)} · ${doc.scope}${doc.shadowedBy ? ' · shadowed' : ''}${doc.loaded ? ' · loaded' : ''}` : `${editor.scope === 'project' ? 'Project' : 'User'} scope`
  const noun = isSkill ? 'skill' : 'template'
  return <form className="ad-editor" onSubmit={submit} onKeyDown={keyDown} aria-label={`${noun} editor`} aria-busy={busy}>
    <div className="ad-editor-head">
      <button type="button" className="ad-btn ad-back" onClick={p.onBack}>← Back to list</button>
      <div className="ad-editor-title"><h2>{title}{changed && <span className="ad-dirty" title="Unsaved changes" aria-label="Unsaved changes" />}</h2>
        <p className="ad-meta">{meta}</p>
        {doc && <p className="ad-meta ad-path" title={doc.path}>{doc.path}</p>}</div>
    </div>
    <div className="ad-editor-body">
      {readOnly && <div className="ad-banner ad-banner-warn" role="status"><span>Read-only. {p.readOnlyReason}{doc && doc.source === 'package' ? ` Package source: ${doc.sourceDetail ?? 'unknown'}.` : ''} Copy it to customize your own version.</span>
        <button type="button" className="ad-btn ad-btn-primary" disabled={busy || !p.canCopyTo('user')} onClick={() => p.onCopy('user')}>Copy to User</button>
        <button type="button" className="ad-btn" disabled={busy || !p.canCopyTo('project')} title={p.canCopyTo('project') ? undefined : 'Project scope needs a trusted workspace.'} onClick={() => p.onCopy('project')}>Copy to Project</button></div>}
      {!readOnly && !p.canWrite && <p className="ad-banner ad-banner-warn" role="status">Trust this workspace before saving project {noun}s.</p>}
      {!creating && doc && !doc.loaded && !doc.shadowedBy && <p className="ad-banner" role="status">Pi has not loaded this {noun}. It may be filtered out, or Pi needs a restart.</p>}
      {doc?.shadowedBy && <p className="ad-banner ad-banner-warn" role="status">Shadowed: Pi uses <code>{doc.shadowedBy}</code> instead of this file.</p>}
      <fieldset className="ad-fieldset" disabled={locked}>
        <div className="ad-field"><label htmlFor="rs-name">Name</label>
          <input id="rs-name" className="ad-input ad-mono" value={draft.name} maxLength={isSkill ? 128 : 128} required readOnly={!isSkill && !creating} disabled={!isSkill && !creating} aria-invalid={nameProblems.length > 0 && (creating || isSkill)} aria-describedby="rs-name-help" placeholder={isSkill ? 'my-skill' : 'review'} onChange={(event) => set({ name: event.target.value })} />
          {(creating || isSkill) && draft.name !== '' && nameProblems.length > 0 && <p className={creating ? 'ad-error' : 'ad-help rs-warn'} role={creating ? 'alert' : undefined}>{nameProblems.join(' ')}{!creating && ' Pi will warn about this name.'}</p>}
          <p id="rs-name-help" className="ad-help">{isSkill ? (creating ? 'Lowercase letters, digits and hyphens, up to 64 characters. Also the folder name.' : 'Should match the skill folder name; Pi warns when it does not.') : (creating ? 'Becomes the file name and the slash command.' : 'Derived from the file name; to rename, create a new template.')}</p></div>
        <div className="ad-field"><label htmlFor="rs-desc">Description{isSkill ? ' (required)' : ''}</label>
          <AutoTextarea id="rs-desc" rows={isSkill ? 3 : 2} value={draft.description} invalid={descMissing || descTooLong} onChange={(value) => set({ description: value })} describedBy="rs-desc-help" />
          <p id="rs-desc-help" className={`ad-help ad-count${descTooLong ? ' rs-warn' : ''}`}>{isSkill ? `${draft.description.length}/1024 · Pi uses this to decide when to load the skill.` : 'Shown in the slash-command menu.'}{descMissing && ' Required.'}</p></div>
        {isSkill && <div className="ad-field"><span className="ad-label">Invocation</span><div className="ad-toggles"><div className="ad-toggle-row"><span className="ad-toggle-text"><span className="ad-toggle-label">Model may invoke automatically</span><span className="ad-help">Off sets <code>disable-model-invocation</code>; the skill then runs only when you type its command.</span></span><Switch checked={draft.autoInvoke} label="Model may invoke automatically" onChange={(next) => set({ autoInvoke: next })} /></div></div></div>}
        {isSkill && <div className="ad-field"><label htmlFor="rs-tools">Allowed tools</label><ChipInput id="rs-tools" value={draft.tools} suggestions={BUILTIN_TOOLS} onChange={(list) => set({ tools: list })} /><p className="ad-help">Enter or comma adds a tool. Saved in the key's existing form (list or comma-separated).</p></div>}
        {isSkill && <div className="ad-row">
          <div className="ad-field"><label htmlFor="rs-license">License</label><input id="rs-license" className="ad-input" value={draft.license} placeholder="MIT" onChange={(event) => set({ license: event.target.value })} /></div>
          <div className="ad-field"><label htmlFor="rs-compat">Compatibility</label><input id="rs-compat" className="ad-input" value={draft.compatibility} placeholder="Requires git and network access" onChange={(event) => set({ compatibility: event.target.value })} /></div>
        </div>}
        {!isSkill && <div className="ad-field"><label htmlFor="rs-hint">Argument hint</label><input id="rs-hint" className="ad-input ad-mono" value={draft.argumentHint} placeholder="<file> [focus]" onChange={(event) => set({ argumentHint: event.target.value })} /><p className="ad-help">Shown next to the command. e.g. <code>{'<file> [focus]'}</code></p></div>}
        <div className="ad-field"><label htmlFor="rs-body">{isSkill ? 'Instructions (SKILL.md body)' : 'Template body'}</label>
          <textarea id="rs-body" className="ad-input ad-prompt rs-body" value={draft.body} spellCheck={false} onChange={(event) => set({ body: event.target.value })} />
          <p className="ad-help ad-count">{draft.body.length.toLocaleString()} characters</p></div>
        {!isSkill && <div className="rs-help-box" aria-label="Argument substitutions"><strong>Argument substitutions</strong><dl>{SUBSTITUTIONS.map(([code, text]) => <div key={code}><dt><code>{code}</code></dt><dd>{text}</dd></div>)}</dl></div>}
        {extras.length > 0 && <details className="ad-more"><summary>More fields <span>{extras.length}</span></summary><div className="ad-more-grid">{extras.map(([key, entry]) => <div className="ad-field" key={key}><span className="ad-label">{key}</span><pre className="rs-raw">{entry.raw}</pre></div>)}<p className="ad-help rs-span">Read-only here. These keys are preserved untouched when you save.</p></div></details>}
      </fieldset>
      <div className="rs-invoke"><span className="ad-label">Use as</span><code>{invocation}</code><button type="button" className="ad-btn ad-btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
    </div>
    <div className="ad-footer">
      {p.error && <div className="ad-summary" role="alert"><p>{p.error}</p></div>}
      {p.confirmDelete ? <div className="ad-footer-row"><span className="ad-confirm-text">Delete <strong>{draft.name}</strong>? This removes <code>{doc?.path}</code> and cannot be undone.</span><button type="button" className="ad-btn" disabled={busy} onClick={() => p.setConfirmDelete(false)}>Keep</button><button type="button" className="ad-btn ad-btn-danger" disabled={busy} onClick={p.onDelete}>{busy ? 'Deleting…' : 'Confirm delete'}</button></div>
        : <div className="ad-footer-row"><span className="ad-footer-state">{changed ? 'Unsaved changes' : creating ? 'Not created yet' : 'No changes'}</span>
          {!creating && !readOnly && <button type="button" className="ad-btn ad-btn-danger" disabled={busy || !p.canWrite} onClick={() => p.setConfirmDelete(true)}>Delete…</button>}
          <button type="button" className="ad-btn" disabled={busy || !changed} onClick={p.onRevert}>Revert</button>
          <button type="submit" className="ad-btn ad-btn-primary" disabled={busy || !p.canWrite || readOnly || invalid || !dirty} title="Ctrl/Cmd+S">{busy ? 'Saving…' : creating ? `Create ${noun}` : `Save ${noun}`}</button></div>}
    </div>
  </form>
}
