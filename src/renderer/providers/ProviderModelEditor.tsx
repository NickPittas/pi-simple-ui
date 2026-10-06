import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { ProviderModelConfigDiagnostic, ProviderModelConfigEntry, ProviderModelConfigState, ProviderSummary } from '../../shared/providers.ts'
import { useDialogA11y } from '../a11y/useDialogA11y.ts'

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function containsRedaction(value: unknown): boolean { return typeof value === 'string' ? value.includes('[REDACTED]') : Array.isArray(value) ? value.some(containsRedaction) : record(value) ? Object.values(value).some(containsRedaction) : false }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function diff(oldValue: Record<string, unknown>, nextValue: Record<string, unknown>): { patch: Record<string, unknown>; remove: string[][] } {
  const patch: Record<string, unknown> = {}; const remove: string[][] = []
  const visit = (before: Record<string, unknown>, after: Record<string, unknown>, path: string[], rootPatch: Record<string, unknown>) => {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!Object.hasOwn(after, key)) { if (!containsRedaction(before[key])) remove.push([...path, key]); continue }
      const oldChild = before[key]; const newChild = after[key]
      if (same(oldChild, newChild)) continue
      if (record(oldChild) && record(newChild)) {
        const childPatch: Record<string, unknown> = {}
        visit(oldChild, newChild, [...path, key], childPatch)
        if (Object.keys(childPatch).length) {
          if (path.length === 0) rootPatch[key] = childPatch
          else rootPatch[key] = childPatch
        }
      } else rootPatch[key] = newChild
    }
  }
  visit(oldValue, nextValue, [], patch)
  return { patch, remove }
}
function explain(outcome: string): string { return ({ saved: 'Saved native provider model configuration.', conflict: 'Native models.json changed elsewhere. Reloaded the latest values; review before saving again.', 'not-found': 'This provider model definition no longer exists.', invalid: 'The native provider rejected this model configuration. Review its diagnostics.', busy: 'The native model runtime is busy; no changes were applied.', unauthorized: 'This configuration change is not authorized.' } as Record<string, string>)[outcome] ?? `Native configuration result: ${outcome}.` }

export function ProviderModelEditor({ bridge, scope, provider }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly provider: ProviderSummary }) {
  const [state, setState] = useState<ProviderModelConfigState | null>(null)
  const [entry, setEntry] = useState<ProviderModelConfigEntry | null>(null)
  const [json, setJson] = useState('{}')
  const [apiKey, setApiKey] = useState('')
  const [removeApiKey, setRemoveApiKey] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<readonly ProviderModelConfigDiagnostic[]>([])
  const [refreshConsentOpen, setRefreshConsentOpen] = useState(false)
  const [refreshAcknowledged, setRefreshAcknowledged] = useState(false)
  const refreshDialogRef = useRef<HTMLDivElement>(null)
  const closeRefreshConsent = () => { if (busy) return; setRefreshConsentOpen(false); setRefreshAcknowledged(false) }
  const refreshDialogKeyDown = useDialogA11y(refreshDialogRef, closeRefreshConsent, refreshConsentOpen)
  const load = useCallback(async () => {
    if (!bridge || !scope) { setError('Provider configuration is unavailable without a connected native runtime.'); return }
    const response = await bridge.invoke('providers.model-config.list', {}, scope)
    if (!response.ok) { setError(response.error.message); return }
    setState(response.value)
    const read = await bridge.invoke('providers.model-config.read', { providerId: provider.provider }, scope)
    if (!read.ok) { setError(read.error.message); return }
    const found = read.value.entry
    setState(read.value.state)
    setEntry(found)
    setJson(JSON.stringify(found?.definition ?? { models: [] }, null, 2))
    setApiKey(''); setRemoveApiKey(false); setError(null)
  }, [bridge, scope, provider.provider])
  useEffect(() => { void load() }, [load])
  const beginEdit = () => { setEditing(true); setConfirmDelete(false); setError(null); setNotice(null) }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!bridge || !scope || !state || busy) return
    let parsed: unknown
    try { parsed = JSON.parse(json) } catch { setError('Enter valid JSON for the native provider definition.'); return }
    if (!record(parsed)) { setError('The native provider definition must be a JSON object.'); return }
    const definition = parsed
    if (!record(definition)) { setError('Native provider definition must be an object.'); return }
    if (!entry && containsRedaction(definition)) { setError('Do not paste redacted secret markers into a new provider definition. Enter write-only secrets in the dedicated secret field.'); return }
    if (entry && containsRedaction(diff(entry.definition as Record<string, unknown>, definition).patch)) { setError('This edit changes a native array/object containing a write-only secret marker. Leave that field unchanged, or remove the secret explicitly using its write-only control.'); return }
    setBusy(true); setError(null)
    const result = entry ? await (() => {
      const changed = diff(entry.definition as Record<string, unknown>, definition)
      const removed = [...changed.remove]
      if (removeApiKey) removed.push(['apiKey'])
      const oldModels = Array.isArray(entry.definition.models) ? entry.definition.models : []
      const newModels = Array.isArray(definition.models) ? definition.models : []
      const nextIds = new Set(newModels.filter(record).map((model) => model.id).filter((id): id is string => typeof id === 'string'))
      const removeModelIds = oldModels.filter(record).map((model) => model.id).filter((id): id is string => typeof id === 'string' && !nextIds.has(id))
      const patch: Record<string, unknown> = { ...changed.patch }
      if (apiKey) patch.apiKey = apiKey
      if (Array.isArray(patch.models)) patch.models = (patch.models as unknown[]).filter((model) => !record(model) || typeof model.id !== 'string' || !removeModelIds.includes(model.id))
      return bridge.invoke('providers.model-config.update', { expectedRevision: state.revision, providerId: provider.provider, patch, ...(removed.length ? { remove: removed } : {}), ...(removeModelIds.length ? { removeModelIds } : {}) }, scope)
    })() : await bridge.invoke('providers.model-config.create', { expectedRevision: state.revision, providerId: provider.provider, definition: { ...definition, ...(apiKey ? { apiKey } : {}) } }, scope)
    setBusy(false)
    if (!result.ok) { setError(result.error.message); return }
    setState(result.value.state)
    setDiagnostics(result.value.diagnostics)
    if (result.value.outcome === 'saved') { setEntry(result.value.state.providers.find((item) => item.providerId === provider.provider) ?? null); setEditing(false); setApiKey(''); setRemoveApiKey(false); setNotice(explain(result.value.outcome)); return }
    setError(explain(result.value.outcome)); await load()
  }
  const remove = async () => {
    if (!bridge || !scope || !state || !entry) return
    setBusy(true); setError(null)
    const result = await bridge.invoke('providers.model-config.delete', { expectedRevision: state.revision, providerId: provider.provider }, scope)
    setBusy(false)
    if (!result.ok) { setError(result.error.message); return }
    setState(result.value.state)
    setDiagnostics(result.value.diagnostics)
    if (result.value.outcome === 'saved') { setEntry(null); setJson(JSON.stringify({ models: [] }, null, 2)); setEditing(false); setConfirmDelete(false); setNotice('Deleted this native models.json provider override.'); return }
    setError(explain(result.value.outcome)); await load()
  }
  const refresh = async () => {
    if (!bridge || !scope || !refreshAcknowledged || busy) return
    setBusy(true); setError(null); setNotice(null)
    let result
    try { result = await bridge.invoke('providers.model-config.refresh', { acknowledgeCredentialCommands: true }, scope) }
    catch (cause) { setBusy(false); setError(cause instanceof Error ? cause.message : 'Native provider refresh failed.'); return }
    setBusy(false); setRefreshConsentOpen(false); setRefreshAcknowledged(false)
    if (!result.ok) setError(result.error.message)
    else {
      setDiagnostics(result.value.state.diagnostics)
      if (result.value.outcome === 'refreshed') {
        setState(result.value.state)
        const found = result.value.state.providers.find((item) => item.providerId === provider.provider) ?? null
        setEntry(found); setJson(JSON.stringify(found?.definition ?? { models: [] }, null, 2))
        setNotice('Native provider availability refreshed.')
      } else {
        setError(result.value.outcome === 'failed'
          ? result.value.state.diagnostics.map((item) => item.message).join(' ') || 'Native availability refresh failed. No refreshed provider data was accepted.'
          : 'Native availability refresh is unauthorized.')
      }
    }
  }
  const configuredSecrets = entry?.secretPaths ?? []
  return <details className="provider-models"><summary>{entry ? `${provider.modelIds.length} models · native models.json override` : 'Edit native models.json override'}</summary>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {[...(state?.diagnostics ?? []), ...diagnostics].map((item, index) => <p role="alert" key={`${item.code}-${index}`}>{item.message}</p>)}
    {!editing ? <div><p>{entry ? `Revision ${state?.revision}. Secrets are write-only and never loaded into this form.` : 'No custom models.json definition exists for this provider.'}</p>{entry && <pre>{JSON.stringify(entry.definition, null, 2)}</pre>}<button type="button" onClick={beginEdit}>{entry ? 'Edit definition' : 'Create definition'}</button><button type="button" disabled={busy} onClick={() => { setRefreshAcknowledged(false); setRefreshConsentOpen(true) }}>Refresh native availability</button>{entry && <button type="button" onClick={() => setConfirmDelete(true)}>Delete override…</button>}{confirmDelete && entry && <div role="alertdialog" aria-label="Confirm provider model configuration deletion"><p>Delete the models.json provider override for {provider.provider}?</p><button type="button" disabled={busy} onClick={() => void remove()}>Confirm delete</button><button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button></div>}</div> : <form onSubmit={(event) => void save(event)}><label>Native provider definition (JSON)<textarea rows={14} value={json} disabled={busy} onChange={(event) => setJson(event.target.value)}/></label><p>Redacted secret markers are never sent back. Omitted fields remain unchanged. Removed custom model IDs are sent explicitly.</p><label>Set API key (write-only)<input type="password" autoComplete="new-password" value={apiKey} disabled={busy} onChange={(event) => setApiKey(event.target.value)} placeholder={entry?.apiKeyConfigured ? 'Configured · leave blank to preserve' : 'Optional'} /></label>{entry?.apiKeyConfigured && <label><input type="checkbox" checked={removeApiKey} disabled={busy} onChange={(event) => setRemoveApiKey(event.target.checked)}/>Remove existing API key</label>}<div><button type="button" disabled={busy} onClick={() => { setEditing(false); setError(null); void load() }}>Cancel</button><button type="submit" disabled={busy}>{busy ? 'Saving…' : entry ? 'Save changes' : 'Create override'}</button></div></form>}
    {refreshConsentOpen && <div className="help-dialog-backdrop"><div className="help-dialog" role="alertdialog" aria-modal="true" aria-labelledby="provider-refresh-consent-title" tabIndex={-1} ref={refreshDialogRef} onKeyDown={refreshDialogKeyDown}><header><div><span className="help-kicker">NATIVE MODEL REFRESH</span><h2 id="provider-refresh-consent-title">Refresh provider availability?</h2></div><button type="button" aria-label="Close confirmation" onClick={closeRefreshConsent}>×</button></header><div className="help-dialog-content"><p>This native refresh may run configured credential commands for <strong>other providers too</strong>. It is not limited to {provider.label}. Continue only if you want Pi to run those configured commands.</p><label className="help-confirm-check"><input type="checkbox" checked={refreshAcknowledged} disabled={busy} onChange={(event) => setRefreshAcknowledged(event.target.checked)}/>I understand that refresh may execute configured credential commands across providers.</label><div className="help-dialog-actions"><button type="button" disabled={busy} onClick={closeRefreshConsent}>Cancel</button><button type="button" className="help-primary" disabled={busy || !refreshAcknowledged} onClick={() => void refresh()}>{busy ? 'Refreshing…' : 'Continue and refresh'}</button></div></div></div></div>}
  </details>
}
