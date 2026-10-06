import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts';
import { type ProviderAccountSummary, type ProviderAccountsSnapshot, type ProviderSummary } from '../../shared/providers.ts';
import { ProviderLogin } from './ProviderLogin';
import { ProviderModelEditor } from './ProviderModelEditor';
import { useDialogA11y } from '../a11y/useDialogA11y.ts';
import './providers.css';

export interface ProviderAccountsProps { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly initialLoginProvider?: string }
export function ProviderAccounts({ bridge, scope, initialLoginProvider }: ProviderAccountsProps) {
  const [snapshot, setSnapshot] = useState<ProviderAccountsSnapshot | null>(null);
  const [loginProvider, setLoginProvider] = useState<ProviderSummary | null>(null);
  const [switching, setSwitching] = useState<ProviderAccountSummary | null>(null);
  const [loggingOut, setLoggingOut] = useState<ProviderAccountSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const confirmKeyDown = useDialogA11y(confirmRef, () => { if (!busy) { setSwitching(null); setLoggingOut(null); } }, !!switching || !!loggingOut);
  const refresh = useCallback(async () => {
    if (!bridge || !scope) return;
    const result = await bridge.invoke('providers.accounts-read', {}, scope);
    if (!result.ok) { setError(result.error.message); return; }
    setSnapshot(result.value); setError(null);
  }, [bridge, scope]);
  useEffect(() => { void refresh().catch(() => setError('Could not load provider accounts.')); }, [refresh]);
  useEffect(() => {
    if (!initialLoginProvider || !snapshot) return;
    const target = snapshot.providers.find((provider) => provider.provider === initialLoginProvider && provider.loginMethods.length > 0);
    if (target) setLoginProvider(target);
    else setError(`The native command selected ${initialLoginProvider}, but no sign-in method is available in this runtime.`);
  }, [initialLoginProvider, snapshot]);
  const refreshProvider = async (provider: string) => {
    if (!bridge || !scope) return;
    const result = await bridge.invoke('providers.auth-refresh', { provider }, scope);
    if (!result.ok) setError(result.error.message);
    else { setMessage(`Refresh result: ${result.value.status}.`); await refresh(); }
  };
  const switchAccount = async () => {
    if (!bridge || !scope || !switching) return;
    const provider = snapshot?.providers.find((item) => item.provider === switching.providerId);
    const modelId = switching.modelIds[0] ?? provider?.modelIds[0];
    if (!modelId) { setMessage('This account has no model available for selection.'); setSwitching(null); return; }
    setBusy(true); const result = await bridge.invoke('providers.accounts-switch', { provider: switching.providerId, modelId }, scope); setBusy(false);
    if (!result.ok) setError(result.error.message);
    else setMessage(result.value.outcome === 'selected' ? `Selected ${result.value.provider} / ${result.value.modelId}.` : `Account selection ${result.value.outcome}.`);
    setSwitching(null); await refresh();
  };
  const logout = async () => {
    if (!bridge || !scope || !loggingOut) return;
    setBusy(true); const result = await bridge.invoke('providers.auth-logout', { provider: loggingOut.providerId }, scope); setBusy(false);
    if (!result.ok) setError(result.error.message);
    else setMessage(`Logout result: ${result.value.status}${result.value.state ? ` · ${result.value.state.available ? 'provider available' : 'provider unavailable'}` : ''}.`);
    setLoggingOut(null); await refresh();
  };
  const loginComplete = async () => { setMessage('Sign-in completed.'); await refresh(); };
  return <main className="providers-page" aria-label="Provider accounts">
    <header className="providers-page-heading"><div><span className="eyebrow"><span className="eyebrow-line"/>ACCOUNTS & AUTHENTICATION</span><h1>Providers</h1><p>Provider credentials are managed by the native host. Secret values are never displayed here.</p></div><button className="provider-quiet-action" type="button" onClick={() => void refresh()}>Refresh accounts</button></header>
    {error && <p className="provider-error" role="alert">{error}</p>}{message && <p className="provider-notice" role="status">{message}</p>}
     {switching && <div ref={confirmRef} className="provider-confirm" role="alertdialog" aria-modal="true" aria-label="Confirm account switch" onKeyDown={confirmKeyDown}><p>Switch the active model account to <strong>{switching.label}</strong>? Selection changes the current session model.</p><button type="button" disabled={busy} onClick={() => void switchAccount()}>Confirm switch</button><button type="button" onClick={() => setSwitching(null)}>Cancel</button></div>}
     {loggingOut && <div ref={confirmRef} className="provider-confirm" role="alertdialog" aria-modal="true" aria-label="Confirm logout" onKeyDown={confirmKeyDown}><p>Log out <strong>{loggingOut.label}</strong>? The native provider may reject logout when the credential is a numbered slot.</p><button type="button" disabled={busy} onClick={() => void logout()}>Confirm logout</button><button type="button" onClick={() => setLoggingOut(null)}>Cancel</button></div>}
    {!snapshot ? <p role="status">Loading provider accounts…</p> : <>
      <section className="provider-accounts-section"><h2>Accounts</h2>{snapshot.accounts.length === 0 ? <p className="provider-empty">No configured provider accounts were reported.</p> : <div className="provider-account-list">{snapshot.accounts.map((account) => <article className={`provider-account${account.selected ? ' is-selected' : ''}`} key={account.providerId}>
        <div className="provider-account-main"><span className="provider-state-dot" aria-hidden="true"/><div><strong>{account.label}</strong><small>{account.providerId} · {account.authMethod}</small></div>{account.selected && <span className="provider-current-badge">Current</span>}</div>
        <div className="provider-account-badges"><span className={account.configured ? 'provider-badge is-good' : 'provider-badge'}>{account.configured ? 'Configured' : 'Not configured'}</span><span className={account.available ? 'provider-badge is-good' : 'provider-badge is-warning'}>{account.available ? 'Available' : 'Unavailable'}</span><span className="provider-badge">{account.modelIds.length} models</span></div>
        <div className="provider-account-actions">{!account.selected && <button type="button" onClick={() => setSwitching(account)}>Switch account</button>}<button type="button" onClick={() => setLoggingOut(account)}>Log out</button><button type="button" onClick={() => void refreshProvider(account.providerId)}>Refresh auth</button></div>
      </article>)}</div>}</section>
      <section className="providers-catalog-section"><h2>Provider status</h2><div className="provider-account-list">{snapshot.providers.map((provider) => <article className="provider-account provider-summary-card" key={provider.provider}><div className="provider-account-main"><span className="provider-state-dot" aria-hidden="true"/><div><strong>{provider.label}</strong><small>{provider.provider} · {provider.authMethod}</small></div></div><div className="provider-account-badges"><span className={provider.hasCredential ? 'provider-badge is-good' : 'provider-badge is-warning'}>{provider.hasCredential ? 'Credential stored' : 'No credential'}</span><span className={provider.available ? 'provider-badge is-good' : 'provider-badge is-warning'}>{provider.available ? 'Available' : 'Unavailable'}</span></div><div className="provider-account-actions">{provider.loginMethods.length > 0 && <button type="button" onClick={() => setLoginProvider(provider)}>Sign in</button>}<button type="button" onClick={() => void refreshProvider(provider.provider)}>Refresh</button></div><ProviderModelEditor bridge={bridge} scope={scope} provider={provider} /></article>)}</div></section>
    </>}
    {loginProvider && <div className="provider-login-layer"><ProviderLogin bridge={bridge} scope={scope} provider={loginProvider} onClose={() => setLoginProvider(null)} onComplete={() => void loginComplete()} /></div>}
  </main>;
}
