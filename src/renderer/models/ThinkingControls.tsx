import { useEffect, useState } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import type { ModelThinkingLevel, ThinkingState } from '../../shared/models.ts';

export function ThinkingControls({ bridge, scope }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope }) {
  const [state, setState] = useState<ThinkingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!bridge || !scope) return () => { active = false; };
    void bridge.invoke('models.thinking.read', {}, scope).then((result) => { if (active && result.ok) setState(result.value); else if (active && !result.ok) setError(result.error.message); }).catch(() => { if (active) setError('Could not load thinking settings.'); });
    return () => { active = false; };
  }, [bridge, scope]);
  const change = async (level: ModelThinkingLevel) => {
    if (!bridge || !scope) return;
    setError(null);
    const result = await bridge.invoke('models.thinking.update', { level }, scope);
    if (!result.ok) { setError(result.error.message); return; }
    setState(result.value);
  };
  return <section className="model-thinking" aria-labelledby="thinking-heading"><div><h2 id="thinking-heading">Thinking</h2><p>Choose a level supported by the current model.</p></div>
    {!state ? <p role={error ? 'alert' : 'status'}>{error ?? 'Loading thinking levels…'}</p> : <div className="thinking-levels" role="group" aria-label="Thinking level">{state.allowed.map((level) => <button type="button" key={level} aria-pressed={state.current === level} className={state.current === level ? 'is-current' : ''} onClick={() => void change(level)}>{level}{state.current === level && <span className="thinking-current-mark">Current</span>}</button>)}</div>}
    {state?.clamped && <p className="thinking-clamped" role="status">The model adjusted the requested level. Current native level: <strong>{state.current}</strong>.</p>}
    {error && state && <p className="models-inline-error" role="alert">{error}</p>}
  </section>;
}
