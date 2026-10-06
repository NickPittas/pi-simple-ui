import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { type NativeSettingsScope, type SettingsDescriptor, type SettingsFieldValue, type SettingsReadResponse, type SettingsSchemaResponse } from '../../shared/settings.ts'
import { ScopedField } from './ScopedField'
import './settings.css'

const scopes: readonly NativeSettingsScope[] = ['user', 'project', 'session']
const scopeLabels: Record<NativeSettingsScope, string> = { user: 'User', project: 'Project', session: 'Session' }

export function SettingsPage({ bridge, runtimeScope, trusted = false }: { readonly bridge?: DesktopBridge; readonly runtimeScope?: RuntimeScope; readonly trusted?: boolean }) {
  const [schema, setSchema] = useState<SettingsSchemaResponse | null>(null)
  const [scope, setScope] = useState<NativeSettingsScope>('user')
  const [fields, setFields] = useState<readonly SettingsFieldValue[]>([])
  const [dirty, setDirty] = useState<Record<string, unknown>>({})
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [source, setSource] = useState('all')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const scopeKey = runtimeScope ? `${runtimeScope.ownerId}:${runtimeScope.generation}` : 'none'
  const readScope = useCallback(async (target: NativeSettingsScope) => {
    if (!bridge || !runtimeScope) return
    const response = await bridge.invoke('settings.read', { scope: target }, runtimeScope)
    if (!response.ok) { setError(response.error.message); return }
    setFields(response.value.fields)
  }, [bridge, runtimeScope])
  const load = useCallback(async () => {
    if (!bridge || !runtimeScope) { setLoading(false); return }
    setLoading(true); setError(null)
    const [descriptorResult, readResult] = await Promise.all([bridge.invoke('settings.schema', {}, runtimeScope), bridge.invoke('settings.read', { scope }, runtimeScope)])
    if (!descriptorResult.ok) setError(descriptorResult.error.message); else setSchema(descriptorResult.value)
    if (!readResult.ok) setError((current) => current ?? readResult.error.message); else setFields(readResult.value.fields)
    setLoading(false)
  }, [bridge, runtimeScope, scope])
  useEffect(() => { setDirty({}); setConflicts([]); void load().catch(() => { setError('Could not load native settings.'); setLoading(false) }) }, [load, scopeKey])
  useEffect(() => {
    if (!bridge || !runtimeScope) return
    let live = true; let unsubscribe: (() => void) | undefined
    void bridge.subscribe('settings.events', runtimeScope, (event) => {
      if (!live || event.scope !== scope) return
      void readScope(scope)
      setConflicts((current) => current.includes(event.key) ? current : [...current, event.key])
    }).then((result) => { if (!live) { if (result.ok) result.value() } else if (result.ok) unsubscribe = result.value })
    return () => { live = false; unsubscribe?.() }
  }, [bridge, runtimeScope, scope, scopeKey, readScope])
  const visibleDescriptors = useMemo(() => (schema?.descriptors ?? []).filter((descriptor) => descriptor.scopes.includes(scope)
    && (source === 'all' || descriptor.source === source)
    && `${descriptor.key} ${descriptor.source}`.toLowerCase().includes(search.toLowerCase().trim())), [schema, scope, source, search])
  const groups = useMemo(() => {
    const map = new Map<string, SettingsDescriptor[]>()
    for (const descriptor of visibleDescriptors) map.set(descriptor.source, [...(map.get(descriptor.source) ?? []), descriptor])
    return [...map.entries()].sort(([a], [b]) => a === 'native' ? -1 : b === 'native' ? 1 : a.localeCompare(b))
  }, [visibleDescriptors])
  const fieldMap = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields])
  const eligibleScopes = useMemo(() => scopes.filter((candidate) => candidate === 'user' || candidate !== 'project' || trusted).filter((candidate) => schema?.descriptors.some((item) => item.scopes.includes(candidate))), [schema, trusted])
  const update = async (descriptor: SettingsDescriptor, reset: boolean) => {
    if (!bridge || !runtimeScope) return
    const field = fieldMap.get(descriptor.key)
    if (!field || !field.editableScopes.includes(scope) || (scope === 'project' && !trusted)) return
    const key = descriptor.key; setBusyKey(key); setError(null)
    const response = reset
      ? await bridge.invoke('settings.reset', { key, scope, expectedRevision: field.revision }, runtimeScope)
      : await bridge.invoke('settings.update', { key, scope, expectedRevision: field.revision, value: dirty[key] }, runtimeScope)
    setBusyKey(null)
    if (!response.ok) { setError(response.error.message); return }
    if (response.value.outcome === 'conflict') {
      await readScope(scope); setDirty((current) => { const next = { ...current }; delete next[key]; return next })
      setConflicts((current) => current.includes(key) ? current : [...current, key]); return
    }
    setFields((current) => current.map((item) => item.key === key ? response.value.field : item))
    setDirty((current) => { const next = { ...current }; delete next[key]; return next })
    setConflicts((current) => current.filter((item) => item !== key))
  }
  const cancel = () => setDirty({})
  const sources = [...new Set(schema?.descriptors.map((item) => item.source) ?? [])]
  const scopeTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = eligibleScopes.indexOf(scope)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? eligibleScopes.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + eligibleScopes.length) % eligibleScopes.length
    const nextScope = eligibleScopes[next]
    if (nextScope) { setScope(nextScope); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus() }
  }
  return <main className="native-settings-page" aria-label="Native settings">
    <header className="native-settings-heading"><div><span className="eyebrow"><span className="eyebrow-line"/>NATIVE CONFIGURATION</span><h1>Settings</h1><p>Scoped Pi and extension settings. App preferences are managed separately.</p></div><button type="button" className="settings-reload" onClick={() => void load()}>Reload settings</button></header>
    {!trusted && <p className="settings-scope-notice">Project settings are read-only until this workspace is trusted. User and session settings remain available.</p>}
    <div className="settings-scope-tabs" role="group" aria-label="Settings scope">{eligibleScopes.map((item) => <button type="button" aria-pressed={scope === item} className={scope === item ? 'is-current' : ''} key={item} onKeyDown={scopeTabKeyDown} onClick={() => setScope(item)}>{scopeLabels[item]}</button>)}</div>
    <div className="settings-toolbar"><label>Search settings<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter by key or source" /></label><label>Source<select value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option>{sources.map((item) => <option key={item}>{item}</option>)}</select></label><span aria-live="polite">{visibleDescriptors.length} settings</span></div>
    {error && <p role="alert" className="settings-error">{error}</p>}{loading ? <p className="settings-empty">Loading settings…</p> : groups.length === 0 ? <section className="settings-empty-state"><h2>No matching settings</h2><p>Try a different scope or search term.</p></section> : <div className="settings-groups">{groups.map(([sourceName, descriptors]) => <section className="settings-source-group" key={sourceName}><header><span>{sourceName === 'native' ? 'PI NATIVE SETTINGS' : 'EXTENSION PROVIDER'}</span><h2>{sourceName}</h2></header><div className="settings-field-list">{descriptors.map((descriptor) => {
      const field = fieldMap.get(descriptor.key); const value = Object.hasOwn(dirty, descriptor.key) ? dirty[descriptor.key] : field?.value ?? field?.effective
      return <ScopedField key={`${scope}:${descriptor.key}`} descriptor={descriptor} field={field} scope={scope} value={value} dirty={Object.hasOwn(dirty, descriptor.key)} busy={busyKey === descriptor.key} changedElsewhere={conflicts.includes(descriptor.key)} onChange={(next) => setDirty((current) => ({ ...current, [descriptor.key]: next }))} onSave={() => void update(descriptor, false)} onReset={() => void update(descriptor, true)} />
    })}</div></section>)}</div>}
    {Object.keys(dirty).length > 0 && <footer className="settings-dirty-footer"><span>{Object.keys(dirty).length} unsaved change(s)</span><button type="button" onClick={cancel} disabled={busyKey !== null}>Cancel changes</button></footer>}
  </main>
}
