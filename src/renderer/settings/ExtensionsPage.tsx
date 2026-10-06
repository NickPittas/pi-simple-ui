import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { type NativeSettingsScope, type SettingsDescriptor, type SettingsFieldValue, type SettingsSchemaResponse } from '../../shared/settings.ts'
import { ScopedField } from './ScopedField'

export function ExtensionsPage({ bridge, runtimeScope, trusted = false, onSettings, onModels, onMcp }: { readonly bridge?: DesktopBridge; readonly runtimeScope?: RuntimeScope; readonly trusted?: boolean; readonly onSettings?: (source: string) => void; readonly onModels?: () => void; readonly onMcp?: () => void }) {
  const [schema, setSchema] = useState<SettingsSchemaResponse | null>(null)
  const [fields, setFields] = useState<readonly SettingsFieldValue[]>([])
  const [scope, setScope] = useState<NativeSettingsScope>('user')
  const [dirty, setDirty] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const load = useCallback(async () => {
    if (!bridge || !runtimeScope) return
    const [schemaResult, readResult] = await Promise.all([
      bridge.invoke('settings.schema', {}, runtimeScope), bridge.invoke('settings.read', { scope }, runtimeScope),
    ])
    if (schemaResult.ok) setSchema(schemaResult.value); else setError(schemaResult.error.message)
    if (readResult.ok) setFields(readResult.value.fields); else setError((current) => current ?? readResult.error.message)
  }, [bridge, runtimeScope, scope])
  useEffect(() => { setDirty({}); void load().catch(() => setError('Could not load extension settings.')) }, [load])
  const providers = useMemo(() => [...new Set(schema?.descriptors.map((item) => item.source).filter((source) => source !== 'native') ?? [])].sort(), [schema])
  const bySource = (source: string) => (schema?.descriptors ?? []).filter((item) => item.source === source && item.scopes.includes(scope))
  const fieldMap = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields])
  const update = async (descriptor: SettingsDescriptor, reset: boolean) => {
    if (!bridge || !runtimeScope) return
    const field = fieldMap.get(descriptor.key)
    if (!field || !field.editableScopes.includes(scope) || (scope === 'project' && !trusted)) return
    setBusy(descriptor.key); setError(null); setConflict(null)
    const response = reset ? await bridge.invoke('settings.reset', { key: descriptor.key, scope, expectedRevision: field.revision }, runtimeScope) : await bridge.invoke('settings.update', { key: descriptor.key, scope, expectedRevision: field.revision, value: dirty[descriptor.key] }, runtimeScope)
    setBusy(null)
    if (!response.ok) { setError(response.error.message); return }
    if (response.value.outcome === 'conflict') { setConflict(descriptor.key); const latest = await bridge.invoke('settings.read', { scope }, runtimeScope); if (latest.ok) setFields(latest.value.fields); setDirty((current) => { const next = { ...current }; delete next[descriptor.key]; return next }); return }
    setFields((current) => current.map((item) => item.key === descriptor.key ? response.value.field : item)); setDirty((current) => { const next = { ...current }; delete next[descriptor.key]; return next })
  }
  return <main className="extensions-settings-page" aria-label="Extension settings"><header className="extensions-settings-heading"><div><span className="eyebrow"><span className="eyebrow-line"/>INSTALLED PROVIDERS</span><h1>Extensions</h1><p>Provider-specific settings and links to dedicated app areas.</p></div><label>Scope<select value={scope} onChange={(event) => setScope(event.target.value as NativeSettingsScope)}><option value="user">User</option><option value="project" disabled={!trusted}>Project</option><option value="session">Session</option></select></label></header>
    {!trusted && <p className="settings-scope-notice">Project-scoped extension settings are read-only until this workspace is trusted.</p>}{error && <p className="settings-error" role="alert">{error}</p>}{conflict && <p className="settings-conflict-note" role="status">Changed elsewhere. The latest value for {conflict} was reloaded.</p>}
    <div className="extension-dedicated-links"><button type="button" onClick={onModels}>Models</button><button type="button" onClick={onMcp}>MCP servers</button></div>
    {providers.length === 0 ? <p className="settings-empty">No extension settings are described by the host.</p> : <div className="extension-provider-list">{providers.map((provider) => <section className="extension-provider-card" key={provider}><header><div><span className="extension-provider-mark">EXTENSION</span><h2>{provider}</h2></div><button type="button" onClick={() => onSettings?.(provider)}>Open settings</button></header><div className="settings-field-list">{bySource(provider).map((descriptor) => { const field = fieldMap.get(descriptor.key); const value = Object.hasOwn(dirty, descriptor.key) ? dirty[descriptor.key] : field?.value ?? field?.effective; return <ScopedField key={`${scope}:${descriptor.key}`} descriptor={descriptor} field={field} scope={scope} value={value} dirty={Object.hasOwn(dirty, descriptor.key)} busy={busy === descriptor.key} changedElsewhere={conflict === descriptor.key} onChange={(next) => setDirty((current) => ({ ...current, [descriptor.key]: next }))} onSave={() => void update(descriptor, false)} onReset={() => void update(descriptor, true)} /> })}</div></section>)}</div>}
  </main>
}
