import type { NativeModelState, NativeThinkingLevel } from '../../shared/native-pi.ts';

type Props = { state: NativeModelState | null; pending: boolean; loading: boolean; error: string | null; onModel: (provider: string, id: string) => void; onThinking: (level: NativeThinkingLevel) => void };
export function NativeModelControls({ state, pending, loading, error, onModel, onThinking }: Props) {
  const disabled = pending || loading || !state || state.busy;
  const active = state?.model;
  return <div className="chat-composer-controls">
    <label>Model <select aria-label="Model" disabled={disabled} value={active ? `${active.provider}/${active.id}` : ''} onChange={(event) => { const model = state?.models.find((item) => `${item.provider}/${item.id}` === event.target.value); if (model) onModel(model.provider, model.id); }}>
      {active && !state?.models.some((item) => item.provider === active.provider && item.id === active.id) && <option value={`${active.provider}/${active.id}`}>{active.name} (current; unavailable)</option>}
      {state?.models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}
    </select></label>
    {active && !state?.models.some((item) => item.provider === active.provider && item.id === active.id) && <small>Current model is not in the available catalogue.</small>}
    <label>Thinking <select aria-label="Thinking" disabled={disabled} value={state?.thinkingLevel ?? ''} onChange={(event) => onThinking(event.target.value as NativeThinkingLevel)}>
      {state?.thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
    </select></label>
    {loading && <small>Loading native controls…</small>}{error && <small role="alert">{error}</small>}
  </div>;
}
