import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import type { ModelInfo, ModelProviderInfo, ModelReference } from '../../shared/models.ts';
import { ScopedModelsPage } from './ScopedModelsPage';
import { ThinkingControls } from './ThinkingControls';
import './models.css';

export interface ModelPickerProps { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope }
export function ModelPicker({ bridge, scope }: ModelPickerProps) {
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<readonly ModelInfo[]>([]);
  const [selected, setSelected] = useState<ModelReference | null>(null);
  const [providers, setProviders] = useState<readonly ModelProviderInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeByProvider, setActiveByProvider] = useState<Record<string, number>>({});
  useEffect(() => {
    let active = true;
    if (!bridge || !scope) return () => { active = false; };
    void bridge.invoke('models.providers', {}, scope).then((result) => { if (active && result.ok) setProviders(result.value.providers); }).catch(() => undefined);
    return () => { active = false; };
  }, [bridge, scope]);
  useEffect(() => {
    let active = true; setLoading(true); setError(null);
    if (!bridge || !scope) { setLoading(false); return () => { active = false; }; }
    const timer = window.setTimeout(() => {
      void bridge.invoke('models.search', query.trim() ? { query: query.trim() } : {}, scope).then((result) => {
        if (!active) return;
        if (!result.ok) { setError(result.error.message); setLoading(false); return; }
        setModels(result.value.models); setSelected(result.value.selected); setLoading(false);
      }).catch(() => { if (active) { setError('Could not search models.'); setLoading(false); } });
    }, 160);
    return () => { active = false; window.clearTimeout(timer); };
  }, [bridge, scope, query]);
  const groups = useMemo(() => {
    const grouped = new Map<string, ModelInfo[]>();
    models.forEach((model) => grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]));
    return [...grouped.entries()];
  }, [models]);
  const choose = async (model: ModelInfo) => {
    if (!bridge || !scope || !model.available) return;
    const result = await bridge.invoke('models.select', { provider: model.provider, id: model.id }, scope);
    if (!result.ok) { setError(result.error.message); return; }
    setSelected({ provider: result.value.provider, id: result.value.id });
    setNotice(`Selected ${result.value.label || result.value.id}.`);
  };
  const providerById = new Map(providers.map((provider) => [provider.provider, provider]));
  return <main className="models-page" aria-label="Models">
    <header className="models-page-heading"><div><span className="eyebrow"><span className="eyebrow-line"/>MODEL SETTINGS</span><h1>Models</h1><p>Choose the active model and manage the model cycle for this workspace.</p></div></header>
    {error && <p className="models-inline-error" role="alert">{error}</p>}{notice && <p className="models-notice" role="status">{notice}</p>}
    <div className="models-top-grid">
      <section className="model-picker" aria-labelledby="model-picker-heading"><header><div><h2 id="model-picker-heading">Choose a model</h2><p>Unavailable models remain visible with their native reason.</p></div></header>
        <label className="models-search-label" htmlFor="models-query">Search models</label><input className="models-search" id="models-query" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Model or provider" />
        {loading ? <p role="status" className="models-empty">Searching models…</p> : groups.length === 0 ? <p className="models-empty">No models match this search.</p> : <div className="model-provider-groups">{groups.map(([provider, items]) => {
          const enabledIndices = items.flatMap((item, index) => item.available ? [index] : []);
          const activeIndex = enabledIndices.includes(activeByProvider[provider] ?? 0) ? activeByProvider[provider]! : enabledIndices[0] ?? 0;
          const listKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            if (enabledIndices.length === 0) return;
            event.preventDefault();
            const position = enabledIndices.indexOf(activeIndex);
            const next = event.key === 'Home' ? enabledIndices[0]! : event.key === 'End' ? enabledIndices[enabledIndices.length - 1]! : enabledIndices[Math.max(0, Math.min(enabledIndices.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1)))]!;
            setActiveByProvider((current) => ({ ...current, [provider]: next }));
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus();
          };
          return <section className="model-provider-group" key={provider}><h3>{provider}</h3><div role="listbox" aria-label={`${provider} models`} onKeyDown={listKeyDown}>{items.map((model, index) => {
           const isSelected = selected?.provider === model.provider && selected.id === model.id;
          const auth = providerById.get(model.provider);
          const unavailableReason = !model.available ? auth?.hasCredential ? 'Unavailable' : 'Authentication required' : null;
           return <button type="button" role="option" tabIndex={activeIndex === index ? 0 : -1} aria-selected={isSelected} disabled={!model.available} key={`${model.provider}/${model.id}`} className={`model-option${isSelected ? ' is-selected' : ''}${!model.available ? ' is-unavailable' : ''}`} onFocus={() => setActiveByProvider((current) => ({ ...current, [provider]: index }))} onClick={() => void choose(model)}>
            <span className="model-option-main"><strong>{model.label || model.id}</strong><small>{model.id}</small></span><span className="model-option-badges">{isSelected && <span className="model-selected-badge">Selected</span>}{unavailableReason && <span className="model-unavailable-badge" title={unavailableReason}>{unavailableReason}</span>}{model.available && <span className={`model-auth-badge auth-${model.authState}`}>{model.authState === 'configured' ? 'Ready' : model.authState === 'credential-stored' ? 'Credential stored' : 'No credential'}</span>}</span>
          </button>;
         })}</div></section>})}</div>}
      </section>
      <ThinkingControls bridge={bridge} scope={scope} />
    </div>
    <section className="models-providers" aria-labelledby="providers-heading"><header><div><h2 id="providers-heading">Providers</h2><p>Authentication details only; provider login flows are handled in a later Providers area.</p></div></header><div className="provider-strip">{providers.length === 0 ? <p className="models-empty">Provider information is not available.</p> : providers.map((provider) => <article className="provider-card" key={provider.provider}><div><strong>{provider.label}</strong><small>{provider.provider}</small></div><span className={`provider-auth-state ${provider.hasCredential ? 'has-credential' : 'needs-credential'}`}>{provider.hasCredential ? 'Credential available' : 'No credential'}</span><small>{provider.availableModelCount} of {provider.modelCount} models available · {provider.authMethod}</small></article>)}</div></section>
    <ScopedModelsPage bridge={bridge} scope={scope} />
  </main>;
}
