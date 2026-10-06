import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { AGENT_DEFINITIONS_IPC, type AgentDefinition, type AgentDefinitionFields, type AgentDefinitionListScope, type AgentDefinitionMutationResponse, type AgentDefinitionProvider, type AgentDefinitionValidationIssue } from '../../shared/agent-definitions.ts'
import { AgentEditorPanel } from './AgentEditorPanel.tsx'
import { Switch, type ModelOption } from './AgentFieldControls.tsx'
import { enabledLabel, herdrKinds, isReadOnlyDefinition, nameIssue, providerFor, providerLabels, scopeLabels, scopeLabelsForDefinition, scopes, snapshotOf, type AgentDefinitionKind, type Editor } from './agentDefinitionModel.ts'
import './agents.css'

const NO_OPTIONS: readonly never[] = []

export function AgentDefinitionsPage({ bridge, scope, trusted = false, modelOptions = NO_OPTIONS, thinkingLevels = NO_OPTIONS }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly trusted?: boolean; readonly modelOptions?: readonly ModelOption[]; readonly thinkingLevels?: readonly string[] }) {
  const [provider, setProvider] = useState<AgentDefinitionProvider>('tintinweb')
  const [available, setAvailable] = useState<readonly AgentDefinitionProvider[] | null>(null)
  const [kind, setKind] = useState<AgentDefinitionKind>('agent')
  const [listScope, setListScope] = useState<AgentDefinitionListScope>('all')
  const [definitions, setDefinitions] = useState<readonly AgentDefinition[]>([])
  const [projectAvailable, setProjectAvailable] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [baseline, setBaseline] = useState<Editor | null>(null)
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null)
  const [search, setSearch] = useState('')
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [issues, setIssues] = useState<readonly AgentDefinitionValidationIssue[]>([])
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const enabledKind = provider === 'herdr' ? kind : undefined
  const dirty = !!editor && !!baseline && snapshotOf(editor) !== snapshotOf(baseline)
  const openEditor = (next: Editor | null) => { setEditor(next); setBaseline(next); setConfirmDelete(false) }
  const guard = (action: () => void) => { if (dirty && !busy) setPendingNav(() => action); else action() }
  useEffect(() => {
    if (!bridge || !scope) { setAvailable(null); return }
    let cancelled = false
    void (async () => {
      try {
        const result = await bridge.invoke(AGENT_DEFINITIONS_IPC.providers, {}, scope)
        if (cancelled) return
        if (!result.ok) { setAvailable([]); setError(`Provider detection failed: ${result.error.message}`); return }
        setAvailable(result.value.providers)
        setProvider((current) => result.value.providers.includes(current) ? current : (result.value.providers[0] ?? current))
      } catch (cause) { if (!cancelled) { setAvailable([]); setError(`Provider detection failed: ${cause instanceof Error ? cause.message : 'No agent-definition service is connected.'}`) } }
    })()
    return () => { cancelled = true }
  }, [bridge, scope])
  const load = useCallback(async () => {
    if (!bridge || !scope || !available || !available.includes(provider)) { setDefinitions([]); return }
    setError(null)
    try {
      const result = await bridge.invoke(AGENT_DEFINITIONS_IPC.list, { provider, scope: listScope, ...(provider === 'herdr' ? { kind } : {}) }, scope)
      if (!result.ok) { setDefinitions([]); setError(`Provider unavailable: ${result.error.message}`); return }
      setDefinitions(result.value.definitions)
      setProjectAvailable(result.value.projectAvailable)
    } catch (cause) { setDefinitions([]); setError(`Provider unavailable: ${cause instanceof Error ? cause.message : 'No agent-definition service is connected.'}`) }
  }, [bridge, scope, provider, listScope, kind, available])
  useEffect(() => { void load() }, [load])
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return definitions.filter((item) => providerFor(item) === provider && (provider !== 'herdr' || item.kind === kind) && (!needle || [item.name, item.fields.display_name, item.fields.description, item.fileName].some((text) => typeof text === 'string' && text.toLowerCase().includes(needle))))
  }, [definitions, provider, kind, search])
  const canWrite = (target: 'user' | 'project') => target === 'user' || trusted
  const startCreate = (source?: AgentDefinition) => {
    const target: 'user' | 'project' = listScope === 'project' && trusted ? 'project' : 'user'
    const sourceProvider = source ? providerFor(source) : provider
    const sourceKind = source?.kind ?? enabledKind
    const nativeFields = source?.fields ?? {}
    const baseName = source?.name ?? ''
    setIssues([]); setFieldErrors({}); setError(null); setNotice(null)
    openEditor({ mode: 'create', provider: sourceProvider, scope: target, kind: sourceKind, revision: 0, name: baseName, fields: { ...nativeFields, ...(baseName ? { name: baseName } : {}) }, prompt: source?.prompt ?? '', clearFields: new Set(), ...(source ? { source } : {}) })
  }
  const read = async (item: AgentDefinition) => {
    if (!bridge || !scope) return
    const itemProvider = providerFor(item)
    setError(null); setIssues([]); setFieldErrors({}); setNotice(null)
    try {
      const result = await bridge.invoke(AGENT_DEFINITIONS_IPC.read, { id: item.id, provider: itemProvider }, scope)
      if (!result.ok) { setError(`Provider unavailable: ${result.error.message}`); return }
      if (!result.value.definition) { setError('This definition is no longer available. Refresh the list.'); return }
      const definition = result.value.definition
      setIssues(result.value.validationIssues)
      openEditor({ mode: 'edit', id: definition.id, provider: itemProvider, scope: !isReadOnlyDefinition(definition) && definition.scope === 'project' ? 'project' : 'user', kind: definition.kind, revision: definition.revision, name: definition.name, fields: { ...definition.fields }, prompt: definition.prompt, clearFields: new Set(), source: definition })
    } catch (cause) { setError(`Provider unavailable: ${cause instanceof Error ? cause.message : 'Read failed.'}`) }
  }
  const validateForm = (): boolean => {
    if (!editor) return false
    const next: Record<string, string> = {}
    const nameProblem = nameIssue(editor.provider, editor.name, editor.kind)
    if (nameProblem) next.name = nameProblem
    if (editor.provider === 'nicobailon' && !(typeof editor.fields.description === 'string' && editor.fields.description.trim())) next.description = 'Native nicobailon agents require a description.'
    if (editor.provider === 'herdr' && editor.kind !== 'task' && !(typeof editor.fields.description === 'string' && editor.fields.description.trim())) next.description = 'Herdr agent and role definitions require a description.'
    if (editor.provider === 'tintinweb' && editor.fields.max_turns !== undefined && editor.fields.max_turns !== '' && (!Number.isSafeInteger(Number(editor.fields.max_turns)) || Number(editor.fields.max_turns) < 0)) next.max_turns = 'Enter a non-negative whole number.'
    if (editor.provider === 'nicobailon' && ['timeoutMs', 'toolTimeoutMs', 'maxSubagentDepth'].some((key) => editor.fields[key] !== undefined && editor.fields[key] !== '' && (!Number.isSafeInteger(Number(editor.fields[key])) || Number(editor.fields[key]) < (key === 'maxSubagentDepth' ? 0 : 1)))) next.timeoutMs = 'Timeouts must be positive whole numbers; depth must be zero or greater.'
    setFieldErrors(next)
    return Object.keys(next).length === 0
  }
  const reloadConflict = async () => {
    if (!editor?.id || !bridge || !scope) return
    const result = await bridge.invoke(AGENT_DEFINITIONS_IPC.read, { id: editor.id, provider: editor.provider }, scope)
    if (!result.ok || !result.value.definition) { setError(result.ok ? 'The definition was removed elsewhere.' : result.error.message); return }
    const current = result.value.definition
    openEditor({ ...editor, revision: current.revision, name: current.name, fields: { ...current.fields }, prompt: current.prompt, clearFields: new Set(), source: current })
    setIssues(result.value.validationIssues)
    setNotice('Changed elsewhere. Latest fields and prompt reloaded; review before saving.')
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!bridge || !scope || !editor || busy || !validateForm()) return
    if (!canWrite(editor.scope)) { setError('Trust this workspace before saving a project definition.'); return }
    const fields = { ...editor.fields, name: editor.name } as AgentDefinitionFields & { readonly name: string }
    setBusy(true); setError(null); setNotice(null); setIssues([])
    try {
      const result = editor.mode === 'create'
        ? await bridge.invoke(AGENT_DEFINITIONS_IPC.create, { provider: editor.provider, ...(editor.provider === 'herdr' ? { kind: editor.kind ?? 'agent' } : {}), scope: editor.scope, expectedRevision: 0, fields, prompt: editor.prompt }, scope)
        : await bridge.invoke(AGENT_DEFINITIONS_IPC.update, { provider: editor.provider, id: editor.id!, expectedRevision: editor.revision, fields, ...(editor.clearFields.size ? { clearFields: [...editor.clearFields] as (keyof AgentDefinitionFields)[] } : {}), prompt: editor.prompt }, scope)
      setBusy(false)
      if (!result.ok) { setError(result.error.message); return }
      handleMutation(result.value, editor)
    } catch (cause) { setBusy(false); setError(cause instanceof Error ? cause.message : 'The provider did not complete the save.') }
  }
  const handleMutation = (response: AgentDefinitionMutationResponse, current: Editor) => {
    setIssues(response.validationIssues)
    if (response.status === 'conflict') { void reloadConflict(); return }
    if (response.status === 'invalid') { setError('The native provider rejected these fields. Review its diagnostics.'); return }
    if (response.status === 'unavailable') { setError('This provider is unavailable for the current runtime.'); return }
    if (response.status === 'read-only') { setError('This definition is read-only. Create a user or trusted project override instead.'); return }
    if (response.status === 'not-found') { setError('Definition no longer exists. Refresh the list.'); return }
    if (response.definition) {
      const definition = response.definition
      openEditor({ mode: 'edit', id: definition.id, provider: current.provider, scope: definition.scope === 'project' ? 'project' : 'user', kind: definition.kind, revision: definition.revision, name: definition.name, fields: { ...definition.fields }, prompt: definition.prompt, clearFields: new Set(), source: definition })
    } else openEditor(null)
    setNotice('Saved native definition.')
    void load()
  }
  const remove = async () => {
    if (!bridge || !scope || !editor?.id || !editor.source || busy) return
    setBusy(true); setError(null)
    try {
      const result = await bridge.invoke(AGENT_DEFINITIONS_IPC.delete, { provider: editor.provider, id: editor.id, expectedRevision: editor.revision }, scope)
      setBusy(false)
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.status === 'conflict') { setConfirmDelete(false); await reloadConflict(); return }
      if (result.value.status !== 'saved') { setIssues(result.value.validationIssues); setError(result.value.status === 'unavailable' ? 'Provider unavailable.' : `Delete was not completed: ${result.value.status}.`); return }
      openEditor(null); setNotice('Definition deleted.'); await load()
    } catch (cause) { setBusy(false); setError(cause instanceof Error ? cause.message : 'Delete failed.') }
  }
  const toggleEnabled = async (item: AgentDefinition) => {
    if (!bridge || !scope || item.scope === 'workspace' || (item.scope === 'project' && !trusted) || togglingId) return
    setTogglingId(item.id)
    try {
      const result = await bridge.invoke(AGENT_DEFINITIONS_IPC.enable, { provider: providerFor(item), id: item.id, expectedRevision: item.revision, enabled: !item.enabled }, scope)
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.status === 'conflict') { setNotice('Changed elsewhere. Refreshing before another enablement change.'); await load(); return }
      if (result.value.status !== 'saved') { setIssues(result.value.validationIssues); setError(result.value.status === 'unavailable' ? 'Provider unavailable.' : `Enablement was not changed: ${result.value.status}.`); return }
      setNotice(`${enabledLabel(item)} ${result.value.definition?.enabled ? 'enabled' : 'disabled'}.`)
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Enablement change failed.') } finally { setTogglingId(null) }
  }
  const canEditExisting = !!editor && editor.mode === 'edit' && editor.source?.editable !== false && editor.source?.scope !== 'bundled' && editor.source?.scope !== 'workspace'
  const providerUnavailable = !bridge || !scope
  const createDisabled = providerUnavailable || (listScope === 'project' && !trusted)
  const selectedId = editor?.mode === 'edit' ? editor.id : undefined
  return <main className="agent-definitions-page" aria-label="Native agent definitions">
    <header className="ad-header"><span className="eyebrow"><span className="eyebrow-line" />NATIVE PROVIDER FILES</span><h1>Agent definitions</h1><p>Edit native agent, task and role markdown for the detected provider.</p></header>
    <div className="ad-toolbar" role="search">
      <label className="ad-tool ad-tool-search"><span>Search</span><input type="search" className="ad-input" placeholder="Filter by name or description" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label className="ad-tool"><span>Provider</span><select className="ad-input" value={provider} onChange={(event) => { const next = event.target.value as AgentDefinitionProvider; guard(() => { setProvider(next); setDefinitions([]); openEditor(null); setError(null) }) }}>{(available ?? []).map((item) => <option value={item} key={item}>{providerLabels[item]}</option>)}</select></label>
      {provider === 'herdr' && <label className="ad-tool"><span>Definition kind</span><select className="ad-input" value={kind} onChange={(event) => { const next = event.target.value as AgentDefinitionKind; guard(() => { setKind(next); openEditor(null) }) }}>{herdrKinds.map((item) => <option value={item} key={item}>{item === 'role' ? 'Role (agent-format)' : item}</option>)}</select></label>}
      <label className="ad-tool"><span>Scope</span><select className="ad-input" value={listScope} onChange={(event) => setListScope(event.target.value as AgentDefinitionListScope)}>{scopes.map((item) => <option value={item} key={item} disabled={item === 'project' && !trusted}>{scopeLabels[item]}</option>)}</select></label>
      <div className="ad-tool-actions"><button type="button" className="ad-btn" onClick={() => void load()}>Reload</button><button type="button" className="ad-btn ad-btn-primary" disabled={createDisabled} onClick={() => guard(() => startCreate())}>New {provider === 'herdr' ? kind : 'agent'}</button></div>
    </div>
    {!providerUnavailable && available?.length === 0 && !error && <p className="ad-banner ad-banner-warn" role="status">No supported subagent extension is installed and enabled in Pi settings (looked for @tintinweb/pi-subagents and pi-herdr-agents in the settings packages list and on disk).</p>}
    {providerUnavailable && <p className="ad-banner ad-banner-warn" role="status">Agent-definition capabilities require an active native runtime.</p>}
    {!projectAvailable && listScope !== 'user' && <p className="ad-banner ad-banner-warn">Project definitions are withheld until the active workspace is trusted.</p>}
    {!editor && error && <p className="ad-banner ad-banner-err" role="alert">{error}</p>}
    {!editor && notice && <p className="ad-banner ad-banner-ok" role="status" aria-live="polite">{notice}</p>}
    {pendingNav && <div className="ad-banner ad-banner-warn ad-discard" role="alertdialog" aria-label="Unsaved changes"><span>You have unsaved changes. Discard them and continue?</span><button type="button" className="ad-btn" onClick={() => setPendingNav(null)}>Keep editing</button><button type="button" className="ad-btn ad-btn-danger" onClick={() => { const run = pendingNav; setPendingNav(null); run() }}>Discard</button></div>}
    <div className={`ad-layout${editor ? ' has-editor' : ''}`}>
      <section className="ad-list" aria-label={`${providerLabels[provider]} definitions`} aria-busy={!providerUnavailable && definitions.length === 0 && !error}>
        <div role="listbox" aria-label="Definitions" className="ad-listbox">
          {filtered.map((item) => {
            const currentProvider = providerFor(item)
            const readOnly = isReadOnlyDefinition(item)
            const canToggle = !readOnly && !(item.scope === 'project' && !trusted) && !(currentProvider === 'herdr' && item.kind === 'task' && !item.id)
            const status = !item.valid ? 'invalid' : item.validationIssues.length > 0 ? 'warn' : 'ok'
            const tip = status === 'ok' ? 'Valid' : item.validationIssues.map((issue) => `${issue.field ? `${issue.field}: ` : ''}${issue.message}`).join('\n') || 'Validation issues'
            const selected = selectedId === item.id
            const title = String(item.fields.display_name || item.name)
            return <div className={`ad-row-item${selected ? ' is-selected' : ''}${item.shadowed ? ' is-shadowed' : ''}`} key={`${currentProvider}:${item.id}`}>
              <button type="button" role="option" aria-selected={selected} className="ad-row-main" onClick={() => guard(() => void read(item))} title={item.shadowed ? `${item.fileName} (shadowed by a higher-precedence definition)` : item.fileName}>
                <span className={`ad-dot ad-dot-${status}`} title={tip} aria-label={status === 'ok' ? 'Valid' : status === 'warn' ? 'Has warnings' : 'Invalid'} />
                <span className="ad-row-text"><span className="ad-row-name">{title}</span><span className="ad-row-desc">{String(item.fields.description || `Native ${item.kind ?? 'agent'} definition`)}</span></span>
                <span className={`ad-scope scope-${item.scope}`}>{scopeLabelsForDefinition[item.scope].toLowerCase()}</span>
              </button>
              <span className="ad-row-switch">{togglingId === item.id ? <span className="ad-spinner" role="status" aria-label="Updating" /> : <Switch checked={item.enabled} disabled={!canToggle || !!togglingId} label={`${item.enabled ? 'Disable' : 'Enable'} ${title}: ${enabledLabel(item)}`} onChange={() => void toggleEnabled(item)} />}</span>
            </div>
          })}
          {!providerUnavailable && filtered.length === 0 && !error && <p className="ad-empty">{search ? 'No definitions match this search.' : 'No definitions were returned for this provider and scope. You can create a native definition here.'}</p>}
        </div>
      </section>
      <section className="ad-detail" aria-label="Definition editor">
        {editor ? <AgentEditorPanel editor={editor} setEditor={setEditor} busy={busy} dirty={dirty} canEditExisting={canEditExisting} canWrite={canWrite(editor.scope)} canOverride={!(listScope === 'project' && !trusted)} confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete} fieldErrors={fieldErrors} clearFieldError={(key) => setFieldErrors((current) => { if (!(key in current)) return current; const next = { ...current }; delete next[key]; return next })} issues={issues} error={error} notice={notice} modelOptions={modelOptions} thinkingLevels={thinkingLevels} onSave={(event) => void save(event)} onRevert={() => { if (baseline) { setEditor(baseline); setFieldErrors({}); setError(null) } }} onDelete={() => void remove()} onOverride={() => { const source = editor.source; if (source) guard(() => startCreate(source)) }} onBack={() => guard(() => openEditor(null))} />
          : <div className="ad-placeholder"><h2>Select a definition</h2><p>Choose an agent from the list to read and edit its native file, or create a new one.</p></div>}
      </section>
    </div>
  </main>
}
