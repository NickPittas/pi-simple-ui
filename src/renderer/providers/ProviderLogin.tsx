import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import { type ProviderAuthEvent, type ProviderAuthLoginMethod, type ProviderAuthNotice, type ProviderAuthPrompt, type ProviderSummary } from '../../shared/providers.ts';
import { useDialogA11y } from '../a11y/useDialogA11y.ts';

export interface ProviderLoginProps { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly provider: ProviderSummary; readonly onClose: () => void; readonly onComplete: () => void }
function newJourneyId() { return `login_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`; }

export function ProviderLogin({ bridge, scope, provider, onClose, onComplete }: ProviderLoginProps) {
  const [method, setMethod] = useState<ProviderAuthLoginMethod>(provider.loginMethods[0] ?? 'oauth');
  const [journeyId, setJourneyId] = useState<string | null>(null);
  const [promptEvent, setPromptEvent] = useState<Extract<ProviderAuthEvent, { type: 'prompt' }> | null>(null);
  const [notices, setNotices] = useState<ProviderAuthNotice[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true; let unsubscribe: (() => void) | undefined;
    if (!bridge || !scope) return () => { active = false; };
    void bridge.subscribe('providers.auth-event', scope, (event) => {
      if (!active || event.provider !== provider.provider || (journeyId && event.journeyId !== journeyId)) return;
      if (!journeyId) setJourneyId(event.journeyId);
      if (event.type === 'prompt') { setPromptEvent(event); setValue(''); }
      if (event.type === 'notice') setNotices((current) => [...current.slice(-5), event.notice]);
      if (event.type === 'journey') {
        setStatus(event.status);
        if (event.status === 'completed') { setPromptEvent(null); onComplete(); }
        if (event.status === 'failed') setError('Sign-in failed. Retry the provider flow or choose another supported method.');
        if (event.status === 'cancelled') setStatus('cancelled');
      }
    }).then((result) => { if (!active) { if (result.ok) result.value(); } else if (result.ok) unsubscribe = result.value; else setError(result.error.message); });
    return () => { active = false; unsubscribe?.(); };
  }, [bridge, scope, provider.provider, journeyId, onComplete]);
  useEffect(() => { if (promptEvent && promptEvent.prompt.type !== 'select') inputRef.current?.focus(); }, [promptEvent]);
  const start = async () => {
    if (!bridge || !scope) return;
    const id = newJourneyId(); setJourneyId(id); setError(null); setStatus('starting'); setNotices([]); setPromptEvent(null); setWorking(true);
    const result = await bridge.invoke('providers.auth-login', { journeyId: id, provider: provider.provider, method }, scope);
    setWorking(false);
    if (!result.ok) { setError(result.error.message); setStatus('failed'); return; }
    if (result.value.status === 'failed' || result.value.status === 'unsupported' || result.value.status === 'not-found') { setError(`Provider sign-in ${result.value.status}.`); setStatus('failed'); }
    else if (result.value.status === 'completed') { setStatus('completed'); onComplete(); }
    else if (result.value.status === 'cancelled') setStatus('cancelled');
  };
  const cancel = async () => {
    if (!bridge || !scope || !journeyId) { onClose(); return; }
    setWorking(true);
    const result = await bridge.invoke('providers.auth-cancel', { journeyId }, scope);
    setWorking(false);
    if (!result.ok) setError(result.error.message); else if (!result.value.accepted) setError('The provider did not accept cancellation.');
    else { setStatus('cancelled'); setPromptEvent(null); }
  };
  const onDialogKeyDown = useDialogA11y(dialogRef, () => { if (journeyId) void cancel(); else onClose(); });
  const respond = async (event: FormEvent) => {
    event.preventDefault();
    if (!bridge || !scope || !journeyId || !promptEvent || !value.trim()) return;
    setWorking(true); setError(null);
    const transient = value; setValue('');
    const result = await bridge.invoke('providers.auth-respond', { journeyId, promptId: promptEvent.promptId, value: transient }, scope);
    setWorking(false);
    if (!result.ok) setError(result.error.message); else if (!result.value.accepted) setError('The provider did not accept that response.'); else setPromptEvent(null);
  };
  const copyCode = async (code: string) => { try { await navigator.clipboard.writeText(code); setCopied(true); } catch { setCopied(false); } };
  const deviceNotice = [...notices].reverse().find((notice): notice is Extract<ProviderAuthNotice, { type: 'device_code' }> => notice.type === 'device_code');
  const urlNotice = [...notices].reverse().find((notice): notice is Extract<ProviderAuthNotice, { type: 'auth_url' }> => notice.type === 'auth_url');
  return <section ref={dialogRef} className="provider-login" role="dialog" aria-modal="true" aria-labelledby="provider-login-title" onKeyDown={onDialogKeyDown}>
    <header><div><span className="provider-kicker">SIGN IN</span><h2 id="provider-login-title">{provider.label}</h2></div><button type="button" className="provider-quiet-action" disabled={working} onClick={() => { if (journeyId) void cancel(); else onClose(); }}>Close</button></header>
    {!journeyId || status === 'failed' || status === 'cancelled' ? <div className="provider-login-start"><p>{error ?? 'Choose a native sign-in method supported by this provider.'}</p>{provider.loginMethods.length > 1 && <fieldset><legend>Method</legend>{provider.loginMethods.map((item) => <label key={item}><input type="radio" name="provider-login-method" checked={method === item} onChange={() => setMethod(item)} />{item === 'api_key' ? 'API key' : 'OAuth'}</label>)}</fieldset>}<button type="button" className="provider-primary-action" disabled={working || provider.loginMethods.length === 0} onClick={() => void start()}>{status === 'failed' ? 'Retry sign-in' : 'Start sign-in'}</button></div> : <>
      <div className="provider-auth-live" aria-live="polite" aria-busy={working}>{notices.filter((notice) => notice.type === 'progress' || notice.type === 'info').map((notice, index) => <p key={index}>{notice.message}</p>)}{status && <p>{status === 'started' || status === 'starting' ? 'Sign-in in progress' : status}</p>}</div>
      {method === 'oauth' && urlNotice && <div className="provider-browser-step"><h3>Continue in browser</h3><p>{urlNotice.instructions || 'Complete sign-in in the opened browser window.'}</p><p className="provider-link-text">{urlNotice.url}</p></div>}
      {deviceNotice && <div className="provider-device-step"><h3>Enter this code</h3><div className="provider-device-code">{deviceNotice.userCode}</div><button type="button" className="provider-quiet-action" onClick={() => void copyCode(deviceNotice.userCode)}>{copied ? 'Copied' : 'Copy code'}</button><p>Verification address: <span className="provider-link-text">{deviceNotice.verificationUri}</span></p>{deviceNotice.expiresInSeconds !== undefined && <small>Expires in {deviceNotice.expiresInSeconds} seconds</small>}</div>}
      {promptEvent && <form className="provider-auth-prompt" onSubmit={respond}><label htmlFor="provider-auth-value">{promptEvent.prompt.message}</label>{promptEvent.prompt.type === 'select' ? <select id="provider-auth-value" value={value} onChange={(event) => setValue(event.target.value)} required><option value="">Choose an option</option>{promptEvent.prompt.options.map((option) => <option key={option.id} value={option.id}>{option.label}{option.description ? ` — ${option.description}` : ''}</option>)}</select> : <input ref={inputRef} id="provider-auth-value" type={promptEvent.prompt.type === 'secret' ? 'password' : 'text'} autoComplete="off" value={value} placeholder={promptEvent.prompt.placeholder} onChange={(event) => setValue(event.target.value)} required />}
        {promptEvent.prompt.type === 'secret' && <small>The host stores this credential securely. It is sent only for this sign-in response and cleared after submit.</small>}
        <button type="submit" className="provider-primary-action" disabled={working || !value.trim()}>Submit</button></form>}
      {error && <p role="alert" className="provider-login-error">{error}</p>}
      {status === 'completed' ? <p role="status">Sign-in completed.</p> : <button type="button" className="provider-cancel-action" disabled={working} onClick={() => void cancel()}>{working ? 'Please wait…' : 'Cancel sign-in'}</button>}
    </>}
    {status === 'completed' && <button type="button" className="provider-primary-action" onClick={onClose}>Done</button>}
  </section>;
}
