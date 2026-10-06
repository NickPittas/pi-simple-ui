import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import type { EnabledModelsState, ModelInfo } from '../../shared/models.ts';

export function ScopedModelsPage({ bridge, scope }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope }) {
  const [state, setState] = useState<EnabledModelsState | null>(null);
  const [catalog, setCatalog] = useState<readonly ModelInfo[]>([]);
  const [draft, setDraft] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [focus, setFocus] = useState(0);
  const reload = useCallback(async () => {
    if (!bridge || !scope) return;
    const [enabled, models] = await Promise.all([bridge.invoke('models.enabled.read', {}, scope), bridge.invoke('models.search', {}, scope)]);
    if (!enabled.ok) { setError(enabled.error.message); return; }
    setState(enabled.value);
    setDraft(enabled.value.orderedIds.map((reference) => `${reference.provider}/${reference.id}`));
    if (models.ok) setCatalog(models.value.models);
  }, [bridge, scope]);
  useEffect(() => { void reload().catch(() => setError('Could not load enabled models.')); }, [reload]);
  const modelByKey = useMemo(() => new Map(catalog.map((model) => [`${model.provider}/${model.id}`, model])), [catalog]);
  const entries = useMemo(() => {
    const known = new Set(catalog.map((model) => `${model.provider}/${model.id}`));
    const missing: Array<{ key: string; model: ModelInfo }> = draft.filter((key) => !known.has(key)).map((key) => { const [provider, ...rest] = key.split('/'); return { key, model: { id: rest.join('/'), provider, label: rest.join('/'), available: false, authState: 'missing' as const } }; });
    return [...catalog.map((model) => ({ key: `${model.provider}/${model.id}`, model })), ...missing];
  }, [catalog, draft]);
  const groups = useMemo(() => {
    const grouped = new Map<string, typeof entries>();
    for (const entry of entries) grouped.set(entry.model.provider, [...(grouped.get(entry.model.provider) ?? []), entry]);
    return [...grouped.entries()].map(([provider, models]) => [provider, [...models].sort((a, b) => {
      const aOrder = draft.indexOf(a.key); const bOrder = draft.indexOf(b.key);
      return aOrder < 0 ? (bOrder < 0 ? 0 : 1) : bOrder < 0 ? -1 : aOrder - bOrder;
    })] as const);
  }, [entries, draft]);
  const toggle = (key: string) => setDraft((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const move = (index: number, amount: -1 | 1) => {
    const next = index + amount;
    if (next < 0 || next >= draft.length) return;
    setDraft((current) => { const result = [...current]; [result[index], result[next]] = [result[next], result[index]]; return result; });
    setFocus(next);
  };
  const keyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); move(focus, event.key === 'ArrowUp' ? -1 : 1);
    }
  };
  const save = async () => {
    if (!bridge || !scope || !state || saving) return;
    setSaving(true); setError(null); setNotice(null);
    const result = await bridge.invoke('models.enabled.update', { expectedRevision: state.revision, update: { action: 'set', patterns: draft } }, scope);
    setSaving(false);
    if (!result.ok) { setError(result.error.message); return; }
    setState(result.value.state);
    setDraft(result.value.state.orderedIds.map((model) => `${model.provider}/${model.id}`));
    if (result.value.outcome === 'conflict') { setNotice('Enabled models changed elsewhere. The latest native settings have been reloaded; review and save again.'); return; }
    setNotice('Enabled models saved. Native model order persists and is restored at the next start.');
  };
  const setAll = () => setDraft(catalog.filter((model) => model.available).map((model) => `${model.provider}/${model.id}`));
  const clear = () => setDraft([]);
  const enabledCount = draft.length;
  return <section className="scoped-models" aria-labelledby="enabled-models-heading">
    <header className="scoped-models-heading"><div><h2 id="enabled-models-heading">Enabled models</h2><p>Order controls the native model cycle. Changes take effect after Save.</p></div><span>{enabledCount} enabled</span></header>
    {state?.diagnostics.map((diagnostic) => <p className="models-diagnostic" key={diagnostic}>{diagnostic}</p>)}
    {!state ? <p role={error ? 'alert' : 'status'}>{error ?? 'Loading enabled models…'}</p> : <>
      <div className="scoped-model-actions"><button type="button" onClick={setAll}>Enable all available</button><button type="button" onClick={clear}>Clear</button><button type="button" className="models-save" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button><button type="button" onClick={() => { setDraft(state.orderedIds.map((model) => `${model.provider}/${model.id}`)); setNotice(null); }}>Cancel</button></div>
       <p id="scoped-model-order-help" className="scoped-model-note">Order persists natively and restores on next start. Focus an enabled model’s order button, then use Alt+Arrow Up or Alt+Arrow Down to move it.</p>
      {error && <p className="models-inline-error" role="alert">{error}</p>}{notice && <p className="models-notice" role="status">{notice}</p>}
      <div className="scoped-model-groups">{groups.map(([provider, models]) => <section className="scoped-provider-group" key={provider}><header><h3>{provider}</h3><label><input type="checkbox" checked={models.filter(({ model }) => model.available).every(({ key }) => draft.includes(key)) && models.some(({ model }) => model.available)} onChange={() => { const available = models.filter(({ model }) => model.available).map(({ key }) => key); const allChecked = available.every((key) => draft.includes(key)); setDraft((current) => allChecked ? current.filter((key) => !available.includes(key)) : [...current, ...available.filter((key) => !current.includes(key))]); }} />All available</label></header>
         <ul className="scoped-model-list" aria-label={`${provider} models`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" aria-describedby="scoped-model-order-help" onKeyDown={keyDown}>{models.map(({ key, model }) => <li key={key} className="scoped-model-item" data-enabled={draft.includes(key)}>
          <label><input type="checkbox" disabled={!model.available && !draft.includes(key)} checked={draft.includes(key)} onChange={() => toggle(key)} /><span><strong>{model.label || model.id}</strong><small>{model.id}{!model.available ? ' · unavailable' : ''}</small></span></label>
          {draft.includes(key) && <div className="scoped-order-controls"><span>Order {draft.indexOf(key) + 1}</span><button type="button" aria-label={`Move ${model.label || model.id} up`} disabled={draft.indexOf(key) === 0} onFocus={() => setFocus(draft.indexOf(key))} onClick={() => move(draft.indexOf(key), -1)}>↑</button><button type="button" aria-label={`Move ${model.label || model.id} down`} disabled={draft.indexOf(key) === draft.length - 1} onFocus={() => setFocus(draft.indexOf(key))} onClick={() => move(draft.indexOf(key), 1)}>↓</button></div>}
          {!modelByKey.has(key) && <small className="models-missing-note">No longer present in search results</small>}
        </li>)}</ul></section>)}</div>
    </>}
  </section>;
}
