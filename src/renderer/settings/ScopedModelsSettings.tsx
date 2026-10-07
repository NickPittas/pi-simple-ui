import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { fuzzyFilter } from '../models/fuzzy.ts'
import { modelKey, moveEntry, parseEnabledModels, serializeEnabledModels, setProvider, toggleModel, unknownEntries, type CatalogueModel } from './scoped-models-edit.ts'
import './native-config.css'

// Id of the user settings.json entry in src/main/config/native-config-files.ts (`${scope}:${relative}`).
const SETTINGS_ID = 'user:settings.json'
type Props = { bridge?: DesktopBridge; scope?: RuntimeScope; allModels: readonly CatalogueModel[] }
type Notice = { kind: 'info' | 'success' | 'warning' | 'error'; text: string; actions?: 'saved' | 'conflict' }
type Loaded = { text: string; revision: string; exists: boolean; enabled: string[] }

export function ScopedModelsSettings({ bridge, scope, allModels }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [enabled, setEnabled] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const seq = useRef(0)
  const scopeKey = `${scope?.ownerId ?? ''}:${scope?.generation ?? ''}`

  const load = useCallback(async (keepNotice = false) => {
    const sc = scopeRef.current
    if (!bridge || !sc) return
    const mine = ++seq.current
    setError(null); setConfirmRestart(false); if (!keepNotice) setNotice(null)
    const result = await bridge.invoke('native.config.read', { id: SETTINGS_ID }, sc)
    if (mine !== seq.current) return
    if (!result.ok) { setLoaded(null); setError(result.error.message); return }
    const { text, revision, exists } = result.value
    const parsed = parseEnabledModels(exists ? text : '')
    if (!parsed.ok) { setLoaded(null); setError(`Cannot edit scoped models: ${parsed.error}`); return }
    setLoaded({ text: exists ? text : '', revision, exists, enabled: parsed.enabled })
    setEnabled(parsed.enabled)
  }, [bridge])

  useEffect(() => { setLoaded(null); if (bridge && scopeRef.current) void load(true) }, [bridge, scopeKey, load])

  const dirty = loaded !== null && JSON.stringify(enabled) !== JSON.stringify(loaded.enabled)
  const unknown = useMemo(() => new Set(unknownEntries(enabled, allModels)), [enabled, allModels])
  const visible = useMemo(() => fuzzyFilter(allModels, query, (m) => [m.name, m.id, modelKey(m)]), [allModels, query])
  const groups = useMemo(() => {
    const map = new Map<string, CatalogueModel[]>()
    for (const model of visible) map.set(model.provider, [...(map.get(model.provider) ?? []), model])
    return [...map.entries()]
  }, [visible])

  const save = async () => {
    const sc = scopeRef.current
    if (!bridge || !sc || !loaded || !dirty || saving) return
    const out = serializeEnabledModels(loaded.text, enabled)
    if (!out.ok) { setNotice({ kind: 'error', text: out.error }); return }
    setSaving(true); setNotice(null)
    const result = await bridge.invoke('native.config.write', { id: SETTINGS_ID, text: out.text, expectedRevision: loaded.exists ? loaded.revision : '' }, sc)
    setSaving(false)
    if (!result.ok) { setNotice({ kind: 'error', text: result.error.message }); return }
    const { outcome, revision, reason } = result.value
    if (outcome === 'saved' && revision !== null) {
      setLoaded({ text: out.text, revision, exists: true, enabled: [...enabled] })
      setNotice({ kind: 'success', text: 'Saved. Restart Pi to apply.', actions: 'saved' })
    } else if (outcome === 'conflict') {
      setNotice({ kind: 'warning', text: 'This file changed on disk since you opened it.', actions: 'conflict' })
    } else {
      setNotice({ kind: 'error', text: reason ?? (outcome === 'invalid' ? 'The server rejected this content as invalid.' : 'The write was rejected.') })
    }
  }

  const restart = async () => {
    if (!bridge) return
    setRestarting(true)
    const result = await bridge.invoke('native.pi.restart', {})
    setRestarting(false); setConfirmRestart(false)
    if (!result.ok) { setNotice({ kind: 'error', text: result.error.message }); return }
    setNotice(result.value.outcome === 'restarted' ? { kind: 'success', text: 'Pi restarted with your new settings.' } : { kind: 'error', text: result.value.reason ?? 'Pi could not be restarted.' })
  }

  if (!bridge || !scope) return <p className="ncfg-empty">Open a workspace to edit scoped models.</p>
  return <div className="smodels">
    {error && <div className="ncfg-notice ncfg-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>Retry</button></div>}
    {notice && <div className={`ncfg-notice ncfg-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.text}</span>
      {notice.actions === 'saved' && !confirmRestart && <button type="button" onClick={() => setConfirmRestart(true)}>Restart Pi to apply</button>}
      {notice.actions === 'conflict' && <><button type="button" onClick={() => void load()}>Reload (discard my edits)</button><button type="button" onClick={() => setNotice(null)}>Keep editing</button></>}
    </div>}
    {confirmRestart && <div className="ncfg-notice ncfg-warning" role="status"><span>Restart Pi now? Any reply in progress will be stopped. Your session continues from its saved history.</span><button type="button" disabled={restarting} onClick={() => void restart()}>Restart</button><button type="button" disabled={restarting} onClick={() => setConfirmRestart(false)}>Cancel</button></div>}
    {loaded && <>
      <div className="smodels-bar">
        <input className="smodels-search" type="search" placeholder="Search models" aria-label="Search models" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" onClick={() => setEnabled(allModels.map(modelKey))}>Enable all</button>
        <button type="button" onClick={() => setEnabled([])}>Clear</button>
      </div>
      <div className="smodels-cols">
        <div className="smodels-col" role="group" aria-label="Catalogue">
          <h3>Catalogue</h3>
          {groups.map(([provider, items]) => {
            const all = allModels.filter((m) => m.provider === provider).map(modelKey)
            const full = all.every((k) => enabled.includes(k))
            return <div key={provider}>
              <label className="smodels-provider"><input type="checkbox" aria-label={`Select all ${provider}`} checked={full} onChange={() => setEnabled(setProvider(enabled, allModels, provider, !full))} />{provider}</label>
              {items.map((m) => <label className="smodels-item" key={modelKey(m)}><input type="checkbox" checked={enabled.includes(modelKey(m))} onChange={() => setEnabled(toggleModel(enabled, modelKey(m)))} /><span title={m.name}>{m.id}</span></label>)}
            </div>
          })}
          {groups.length === 0 && <p className="ncfg-empty">No matching models.</p>}
        </div>
        <div className="smodels-col" role="group" aria-label="Enabled models">
          <h3>Enabled ({enabled.length})</h3>
          {enabled.length === 0 && <p className="ncfg-empty">None enabled — Pi uses every model.</p>}
          {enabled.map((key, i) => <div className="smodels-item" key={key}>
            <span title={key}>{key}</span>
            {unknown.has(key) && <span className="smodels-flag">not in catalogue</span>}
            <button type="button" aria-label={`Move ${key} up`} disabled={i === 0} onClick={() => setEnabled(moveEntry(enabled, i, -1))}>↑</button>
            <button type="button" aria-label={`Move ${key} down`} disabled={i === enabled.length - 1} onClick={() => setEnabled(moveEntry(enabled, i, 1))}>↓</button>
            <button type="button" aria-label={`Remove ${key}`} onClick={() => setEnabled(enabled.filter((k) => k !== key))}>✕</button>
          </div>)}
        </div>
      </div>
      <div className="smodels-actions">
        <button type="button" className="ncfg-primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" disabled={!dirty || saving} onClick={() => setEnabled(loaded.enabled)}>Revert</button>
      </div>
    </>}
  </div>
}
