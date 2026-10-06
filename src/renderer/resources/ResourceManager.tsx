import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { PACKAGES_IPC, type PackageScope, type ResourceListResponse, type SkillMutationResponse, type TemplateMutationResponse } from '../../shared/packages.ts'
import { Switch, serializeList } from '../agents/AgentFieldControls.tsx'
import { ResourceEditorPanel } from './ResourceEditorPanel.tsx'
import { blankDraft, draftFromDoc, groupLabels, groupOf, isOpaque, itemKey, parseFrontmatter, sameDraft, scopeOf, sourceBadge, statusOf, type Draft, type Editor, type GroupKey, type ResourceDoc, type ResourceItem, type ResourceKind, type SourceFilter } from './resourceModel.ts'
import '../agents/agents.css'
import './resources.css'

type Res<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
type Mutation = { outcome: 'saved' | 'conflict' | 'not-found'; item: ResourceDoc | null; restartRequired?: boolean }
type Props = { readonly kind: ResourceKind; readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly trusted?: boolean }

const COPY = {
  skill: { title: 'Skills', eyebrow: 'NATIVE SKILLS', lede: 'Reusable instructions Pi loads on demand. Edit the SKILL.md files Pi reads from your user and project folders.', add: 'New skill', noun: 'skill', plural: 'skills', saved: 'Saved. Pi applies skill changes on restart.' },
  template: { title: 'Prompt templates', eyebrow: 'NATIVE PROMPT TEMPLATES', lede: 'Markdown snippets you run as slash commands, with argument substitution. Edit the files Pi reads from your user and project folders.', add: 'New template', noun: 'template', plural: 'templates', saved: 'Saved. Pi applies prompt template changes on restart.' },
} as const

export function ResourceManager({ kind, bridge, scope, trusted = false }: Props) {
  const copy = COPY[kind]
  const isSkill = kind === 'skill'
  const [resources, setResources] = useState<ResourceListResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [baseline, setBaseline] = useState<Draft>(blankDraft)
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null)
  const [search, setSearch] = useState('')
  const [source, setSource] = useState<SourceFilter>('all')
  const [showDisabled, setShowDisabled] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [togglingPath, setTogglingPath] = useState<string | null>(null)

  const dirty = !!editor && !sameDraft(editor.draft, baseline)
  const guard = (action: () => void) => { if (dirty && !busy) setPendingNav(() => action); else action() }
  const openEditor = (next: Editor | null, nextBaseline?: Draft) => { setEditor(next); setBaseline(nextBaseline ?? next?.draft ?? blankDraft); setConfirmDelete(false); setConflict(false) }

  const load = useCallback(async () => {
    if (!bridge || !scope) return
    try {
      const result = await bridge.invoke(PACKAGES_IPC.resourcesList, {}, scope)
      if (result.ok) { setResources(result.value); setLoadError(null) } else setLoadError(result.error.message)
    } catch (cause) { setLoadError(cause instanceof Error ? cause.message : 'Could not list resources.') }
  }, [bridge, scope])
  useEffect(() => { void load() }, [load])

  // ---- thin per-kind API wrappers (the two kinds have parallel, differently-typed channels)
  const api = useMemo(() => ({
    read: (s: PackageScope, path: string) => (isSkill ? bridge!.invoke(PACKAGES_IPC.skillsRead, { scope: s, path }, scope!) : bridge!.invoke(PACKAGES_IPC.templatesRead, { scope: s, path }, scope!)) as unknown as Promise<Res<ResourceDoc>>,
    update: (s: PackageScope, path: string, expectedRevision: string, frontmatter: Record<string, unknown>, body: string) => (isSkill ? bridge!.invoke(PACKAGES_IPC.skillsUpdate, { scope: s, path, expectedRevision, frontmatter, body }, scope!) : bridge!.invoke(PACKAGES_IPC.templatesUpdate, { scope: s, path, expectedRevision, frontmatter, body }, scope!)) as unknown as Promise<Res<Mutation>>,
    remove: (s: PackageScope, path: string, expectedRevision: string) => (isSkill ? bridge!.invoke(PACKAGES_IPC.skillsDelete, { scope: s, path, expectedRevision }, scope!) : bridge!.invoke(PACKAGES_IPC.templatesDelete, { scope: s, path, expectedRevision }, scope!)) as unknown as Promise<Res<Mutation>>,
    enable: (s: PackageScope, path: string, enabled: boolean) => (isSkill ? bridge!.invoke(PACKAGES_IPC.skillsEnable, { scope: s, path, enabled }, scope!) : bridge!.invoke(PACKAGES_IPC.templatesEnable, { scope: s, path, enabled }, scope!)) as unknown as Promise<Res<{ outcome: string; enabled: boolean; restartRequired?: boolean }>>,
  }), [bridge, scope, isSkill])
  const create = (s: PackageScope, d: Draft): Promise<Res<Mutation>> => {
    if (isSkill) return bridge!.invoke(PACKAGES_IPC.skillsCreate, { scope: s, name: d.name.trim(), description: d.description, body: d.body, disableModelInvocation: !d.autoInvoke }, scope!) as unknown as Promise<Res<SkillMutationResponse>>
    return bridge!.invoke(PACKAGES_IPC.templatesCreate, { scope: s, name: d.name.trim(), frontmatter: { description: d.description, ...(d.argumentHint.trim() ? { 'argument-hint': d.argumentHint.trim() } : {}) }, body: d.body }, scope!) as unknown as Promise<Res<TemplateMutationResponse>>
  }

  const items: readonly ResourceItem[] = (isSkill ? resources?.skills : resources?.promptTemplates) ?? []
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return items.filter((item) => (source === 'all' || groupOf(item) === source) && (showDisabled || item.enabled !== false) && (!needle || `${item.name} ${item.description} ${item.sourceDetail ?? ''}`.toLowerCase().includes(needle)))
  }, [items, search, source, showDisabled])
  const groups = useMemo(() => (['user', 'project', 'package'] as GroupKey[]).map((key) => ({ key, rows: filtered.filter((item) => groupOf(item) === key) })).filter((group) => group.rows.length > 0), [filtered])

  const canWriteScope = (target: PackageScope) => target === 'user' || trusted
  const markMutated = (restartRequired: boolean | undefined) => { if (restartRequired !== false) setRestartNeeded(true) }

  const beginCreate = () => {
    const target: PackageScope = source === 'project' && trusted ? 'project' : 'user'
    setError(null); setNotice(null)
    openEditor({ mode: 'create', scope: target, draft: { ...blankDraft } })
  }
  const select = async (item: ResourceItem) => {
    if (!bridge || !scope) return
    setError(null); setNotice(null)
    const itemScope = scopeOf(item.scope)
    if (!itemScope) { setError(`This ${copy.noun} comes from a temporary location and cannot be opened here.`); return }
    try {
      const result = await api.read(itemScope, item.path)
      if (!result.ok) { setError(result.error.message); return }
      const doc = result.value
      openEditor({ mode: 'edit', scope: itemScope, doc, draft: draftFromDoc(doc) })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Read failed.') }
  }
  const beginCopy = (target: PackageScope) => {
    if (!editor?.doc) return
    const draft = draftFromDoc(editor.doc)
    setError(null); setNotice(null)
    openEditor({ mode: 'create', scope: target, copyOf: true, draft }, draft)
  }

  /** Builds the frontmatter patch: only keys the user actually changed, so everything else stays byte-for-byte. */
  const buildPatch = (current: Draft, base: Draft, doc: ResourceDoc): Record<string, unknown> => {
    const fm = parseFrontmatter(doc.frontmatterRaw)
    const patch: Record<string, unknown> = {}
    const changed = (key: keyof Draft) => JSON.stringify(current[key]) !== JSON.stringify(base[key])
    const text = (value: string) => value.trim() === '' ? null : value.trim()
    if (changed('description')) patch.description = current.description
    if (isSkill) {
      if (changed('name')) patch.name = current.name.trim()
      if (changed('autoInvoke')) patch['disable-model-invocation'] = current.autoInvoke ? null : true
      if (changed('tools') && !isOpaque(fm.get('allowed-tools'))) patch['allowed-tools'] = serializeList(current.tools, fm.get('allowed-tools')?.value) ?? null
      if (changed('license') && !isOpaque(fm.get('license'))) patch.license = text(current.license)
      if (changed('compatibility') && !isOpaque(fm.get('compatibility'))) patch.compatibility = text(current.compatibility)
    } else if (changed('argumentHint') && !isOpaque(fm.get('argument-hint'))) patch['argument-hint'] = text(current.argumentHint)
    return patch
  }

  const reloadDoc = async (keepDraft: boolean) => {
    if (!editor?.doc) return
    const result = await api.read(editor.scope, editor.doc.path)
    if (!result.ok) { setError(result.error.message); return }
    const doc = result.value
    const fresh = draftFromDoc(doc)
    if (keepDraft) { setEditor({ ...editor, doc }); setBaseline(fresh); setConflict(false); setNotice('Latest revision loaded. Your edits are kept; saving will overwrite the on-disk version.') }
    else { openEditor({ mode: 'edit', scope: editor.scope, doc, draft: fresh }); setNotice('Latest values loaded from disk.') }
    setError(null)
  }

  const finishSave = (item: ResourceDoc | null, current: Editor, restartRequired: boolean | undefined) => {
    markMutated(restartRequired)
    setNotice(null)
    if (item) openEditor({ mode: 'edit', scope: current.scope, doc: item, draft: draftFromDoc(item) })
    else openEditor(null)
    void load()
  }

  const save = async () => {
    if (!bridge || !scope || !editor || busy) return
    if (!canWriteScope(editor.scope)) { setError('Trust this workspace before saving into the project scope.'); return }
    setBusy(true); setError(null); setNotice(null)
    try {
      if (editor.mode === 'create') {
        const result = await create(editor.scope, editor.draft)
        if (!result.ok) { setError(result.error.message); return }
        if (result.value.outcome === 'conflict') { setError(`A ${copy.noun} named “${editor.draft.name}” already exists in this scope.`); return }
        let item = result.value.item
        let restart = result.value.restartRequired
        const d = editor.draft
        if (isSkill && item && (d.tools.length || d.license.trim() || d.compatibility.trim())) {
          const patch: Record<string, unknown> = {}
          if (d.tools.length) patch['allowed-tools'] = d.tools
          if (d.license.trim()) patch.license = d.license.trim()
          if (d.compatibility.trim()) patch.compatibility = d.compatibility.trim()
          const extra = await api.update(editor.scope, item.path, item.revision, patch, item.body)
          if (!extra.ok) { finishSave(item, editor, restart); setError(`Created, but optional fields were not saved: ${extra.error.message}`); return }
          if (extra.value.item) item = extra.value.item
          restart = restart || extra.value.restartRequired
        }
        finishSave(item, editor, restart)
      } else if (editor.doc) {
        const patch = buildPatch(editor.draft, baseline, editor.doc)
        const result = await api.update(editor.scope, editor.doc.path, editor.doc.revision, patch, editor.draft.body)
        if (!result.ok) { setError(result.error.message); return }
        if (result.value.outcome === 'conflict') { setConflict(true); return }
        if (result.value.outcome === 'not-found') { setError(`This ${copy.noun} no longer exists. Reload the list.`); void load(); return }
        finishSave(result.value.item, editor, result.value.restartRequired)
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Save failed.') } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!bridge || !scope || !editor?.doc || busy) return
    setBusy(true); setError(null)
    try {
      const result = await api.remove(editor.scope, editor.doc.path, editor.doc.revision)
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.outcome === 'conflict') { setConfirmDelete(false); setConflict(true); return }
      if (result.value.outcome === 'not-found') setNotice('Already deleted.')
      markMutated(result.value.restartRequired)
      openEditor(null); void load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Delete failed.') } finally { setBusy(false) }
  }

  const toggle = async (item: ResourceItem) => {
    const itemScope = scopeOf(item.scope)
    if (!bridge || !scope || !itemScope || togglingPath) return
    setTogglingPath(item.path); setError(null)
    try {
      const result = await api.enable(itemScope, item.path, item.enabled === false)
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.outcome === 'not-found') { setError(`This ${copy.noun} is no longer available.`); return }
      if (result.value.outcome === 'saved') markMutated(result.value.restartRequired)
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Toggle failed.') } finally { setTogglingPath(null) }
  }

  const restart = async () => {
    if (!bridge) return
    setRestarting(true)
    try {
      const result = await bridge.invoke('native.pi.restart', {})
      setConfirmRestart(false)
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.outcome === 'restarted') { setRestartNeeded(false); setNotice('Pi restarted. Changes are now applied.'); void load() }
      else setError(result.value.reason ?? 'Pi could not be restarted.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Restart failed.') } finally { setRestarting(false); setConfirmRestart(false) }
  }

  const unavailable = !bridge || !scope
  const selectedPath = editor?.mode === 'edit' ? editor.doc?.path : undefined
  const readOnlyReason = editor?.mode === 'edit' && editor.doc ? (editor.doc.writable === false ? (editor.doc.readOnlyReason ?? 'This file is not editable by this app.') : null) : null
  const searching = search !== '' || source !== 'all' || !showDisabled
  return <main className="agent-definitions-page rs-page" aria-label={copy.title}>
    <header className="ad-header"><span className="eyebrow"><span className="eyebrow-line" />{copy.eyebrow}</span><h1>{copy.title}</h1><p>{copy.lede}</p></header>
    <div className="ad-toolbar" role="search">
      <label className="ad-tool ad-tool-search"><span>Search</span><input type="search" className="ad-input" placeholder="Filter by name or description" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label className="ad-tool"><span>Source</span><select className="ad-input" value={source} onChange={(event) => setSource(event.target.value as SourceFilter)}><option value="all">All</option><option value="user">User</option><option value="project">Project</option><option value="package">Packages</option></select></label>
      <div className="ad-tool"><span>Show disabled</span><Switch checked={showDisabled} label="Show disabled" onChange={setShowDisabled} /></div>
      <div className="ad-tool-actions"><button type="button" className="ad-btn" onClick={() => void load()}>Reload</button><button type="button" className="ad-btn ad-btn-primary" disabled={unavailable} onClick={() => guard(beginCreate)}>{copy.add}</button></div>
    </div>
    {unavailable && <p className="ad-banner ad-banner-warn" role="status">Connect a native Pi runtime to manage {copy.plural}.</p>}
    {!trusted && !unavailable && <p className="ad-banner" role="status">Project {copy.plural} are listed read-only until the active workspace is trusted.</p>}
    {restartNeeded && <div className="ad-banner ad-banner-ok rs-restart" role="status" aria-live="polite">
      {confirmRestart ? <span>Restart Pi now? Any reply in progress will be stopped. Your session continues from its saved history.</span> : <span>{copy.saved}</span>}
      {confirmRestart ? <><button type="button" className="ad-btn ad-btn-primary" disabled={restarting} onClick={() => void restart()}>{restarting ? 'Restarting…' : 'Restart'}</button><button type="button" className="ad-btn" disabled={restarting} onClick={() => setConfirmRestart(false)}>Cancel</button></>
        : <button type="button" className="ad-btn" onClick={() => setConfirmRestart(true)}>Restart Pi session</button>}
    </div>}
    {(loadError || (!editor && error)) && <p className="ad-banner ad-banner-err" role="alert">{loadError ?? error}</p>}
    {!editor && notice && <p className="ad-banner ad-banner-ok" role="status" aria-live="polite">{notice}</p>}
    {pendingNav && <div className="ad-banner ad-banner-warn ad-discard" role="alertdialog" aria-label="Unsaved changes"><span>You have unsaved changes. Discard them and continue?</span><button type="button" className="ad-btn" onClick={() => setPendingNav(null)}>Keep editing</button><button type="button" className="ad-btn ad-btn-danger" onClick={() => { const run = pendingNav; setPendingNav(null); run() }}>Discard</button></div>}
    <div className={`ad-layout${editor ? ' has-editor' : ''}`}>
      <section className="ad-list" aria-label={copy.title} aria-busy={!unavailable && !resources && !loadError}>
        <div role="listbox" aria-label={copy.title} className="ad-listbox">
          {groups.map((group) => <div key={group.key} role="group" aria-label={groupLabels[group.key]}>
            <div className="rs-group-head">{groupLabels[group.key]} <span>{group.rows.length}</span></div>
            {group.rows.map((item) => {
              const { status, tip } = statusOf(item)
              const toggleable = item.writable === true && item.enabled !== undefined && !!scopeOf(item.scope) && canWriteScope(scopeOf(item.scope)!)
              const why = toggleable ? undefined : (item.readOnlyReason ?? (item.scope === 'project' && !trusted ? 'Trust this workspace to change project resources.' : 'Not toggleable.'))
              const selected = selectedPath === item.path
              const on = item.enabled !== false
              return <div className={`ad-row-item${selected ? ' is-selected' : ''}${status === 'shadowed' ? ' is-shadowed' : ''}${on ? '' : ' rs-off'}`} key={itemKey(item)}>
                <button type="button" role="option" aria-selected={selected} className="ad-row-main" title={item.path} onClick={() => guard(() => void select(item))}>
                  <span className={`ad-dot rs-dot-${status}`} title={tip} role="img" aria-label={tip} />
                  <span className="ad-row-text"><span className="ad-row-name">{item.name}</span><span className="ad-row-desc">{item.description || 'No description'}</span></span>
                  <span className={`ad-scope rs-src-${groupOf(item)}`} title={item.sourceDetail ?? item.source}>{sourceBadge(item)}</span>
                </button>
                <span className="ad-row-switch" title={why}>{togglingPath === item.path ? <span className="ad-spinner" role="status" aria-label="Updating" /> : <Switch checked={on} disabled={!toggleable || !!togglingPath} label={`${on ? 'Disable' : 'Enable'} ${item.name}${why ? `: ${why}` : ''}`} onChange={() => void toggle(item)} />}</span>
              </div>
            })}
          </div>)}
          {!unavailable && filtered.length === 0 && !loadError && <p className="ad-empty">{!resources ? 'Loading…' : searching ? `No ${copy.plural} match these filters.` : `No ${copy.plural} found. Create one to get started.`}</p>}
        </div>
      </section>
      <section className="ad-detail" aria-label={`${copy.noun} editor`}>
        {editor ? <>
          {conflict && <div className="ad-banner ad-banner-warn" role="alertdialog" aria-label="Changed on disk"><span>This {copy.noun} changed on disk after you opened it.</span><button type="button" className="ad-btn ad-btn-primary" onClick={() => void reloadDoc(false)}>Reload latest</button><button type="button" className="ad-btn" onClick={() => void reloadDoc(true)}>Keep editing</button></div>}
          {notice && <p className="ad-banner ad-banner-ok" role="status" aria-live="polite">{notice}</p>}
          <ResourceEditorPanel kind={kind} editor={editor} baseline={baseline} busy={busy} canWrite={canWriteScope(editor.scope)} readOnlyReason={readOnlyReason} canCopyTo={canWriteScope} confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete} error={error}
            setDraft={(draft) => setEditor({ ...editor, draft })} onSave={() => void save()} onRevert={() => { setEditor({ ...editor, draft: baseline }); setError(null) }} onDelete={() => void remove()} onCopy={beginCopy} onBack={() => guard(() => openEditor(null))} />
        </> : <div className="ad-placeholder"><h2>Select a {copy.noun}</h2><p>Choose one from the list to read and edit its file, or create a new {copy.noun}.</p></div>}
      </section>
    </div>
  </main>
}
