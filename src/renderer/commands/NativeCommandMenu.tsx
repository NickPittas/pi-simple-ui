import { useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { CommandDispatchResponse, NativeCommandMenuKind } from '../../shared/commands.ts'
import { useDialogA11y } from '../a11y/useDialogA11y.ts'
import './commands.css'

type MenuRequest = Extract<CommandDispatchResponse, { outcome: 'menu-request' }>
type Props = { readonly request: MenuRequest; readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly sessionId?: string; readonly onClose: () => void; readonly onResult: (result: CommandDispatchResponse) => void; readonly onNavigate?: (area: 'providers' | 'models' | 'sessions' | 'settings' | 'help', intent?: string) => void }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function text(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : [] }
function labelFor(kind: NativeCommandMenuKind): string { return ({ settings: 'Native settings', model: 'Choose a model', thinking: 'Thinking level', 'scoped-models': 'Scoped models', login: 'Sign in', logout: 'Sign out', tree: 'Session history', fork: 'Fork from a message', resume: 'Resume a session', import: 'Import session', export: 'Export session' })[kind] }

export function NativeCommandMenu({ request, bridge, scope, sessionId, onClose, onResult, onNavigate }: Props) {
  const ref = useRef<HTMLElement>(null)
  const [selected, setSelected] = useState<string>('')
  const [enabled, setEnabled] = useState<Set<string>>(new Set())
  const [persist, setPersist] = useState(false)
  const [busy, setBusy] = useState(false)
  const [finished, setFinished] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const state = request.initialState
  const schema = request.selection
  const cancelDialog = useDialogA11y(ref, () => { if (!busy) { if (finished || !bridge || !scope) onClose(); else void choose({ kind: 'cancel' }) } }, true)
  useEffect(() => {
    if (request.binding.scope.ownerId !== scope?.ownerId || request.binding.scope.generation !== scope?.generation || sessionId !== request.binding.sessionId) setError('This native menu belongs to a previous runtime or session. Cancel it and reopen the command.')
    else setError(null)
  }, [request, scope, sessionId])
  useEffect(() => {
    const initial = text(state.initialSelectedId) || text(state.selected) || text(state.current) || (schema?.kind === 'scoped-models' ? '' : '')
    setSelected(initial)
    if (schema?.kind === 'scoped-models') {
      setEnabled(new Set(array(state.initialEnabledModelReferences).filter((entry): entry is string => typeof entry === 'string')))
      setPersist(false)
    }
  }, [request])
  const available = useMemo(() => schema?.kind === 'argument' ? schema.values : [], [schema])
  const scopeValid = !!sessionId && request.binding.scope.ownerId === scope?.ownerId && request.binding.scope.generation === scope?.generation && sessionId === request.binding.sessionId
  async function choose(selection: { kind: 'cancel' } | { kind: 'argument'; value: string } | { kind: 'scoped-models'; enabledModelReferences: readonly string[]; persist: boolean }) {
    if (finished) return
    if (!bridge || !scope || (selection.kind !== 'cancel' && !scopeValid)) { setError('The native menu is stale or unavailable. Reopen the command in the active session.'); return }
    setBusy(true); setError(null)
    try {
      const result = await bridge.invoke('commands.dispatch', { menuSelection: { menuId: request.menuId, selection } }, scope)
      setBusy(false)
      if (!result.ok) { setFinished(true); setError(`${result.error.message} Reopen the command before trying again.`); return }
      onResult(result.value)
      if (result.value.outcome !== 'menu-request') { setFinished(true); onClose() }
    } catch (cause) { setBusy(false); setFinished(true); setError(`${cause instanceof Error ? cause.message : 'Could not continue this native menu.'} Reopen the command before trying again.`) }
  }
  const heading = labelFor(request.menu)
  const settingsState = request.menu === 'settings' ? { effective: state.effective, global: state.global, project: state.project, projectTrusted: state.projectTrusted, currentModel: state.currentModel } : null
  return <div className="command-menu-backdrop"><section ref={ref} className="native-command-menu" role="dialog" aria-modal="true" aria-labelledby="native-command-menu-title" onKeyDown={cancelDialog}>
    <header><div><span className="command-menu-kicker">NATIVE COMMAND · /{request.commandName}</span><h2 id="native-command-menu-title">{heading}</h2></div><button type="button" aria-label="Close menu" disabled={busy} onClick={() => { if (finished || !bridge || !scope) onClose(); else void choose({ kind: 'cancel' }) }}>×</button></header>
    {!scopeValid && <p role="alert" className="command-menu-error">This menu expired after a runtime or session change. No selection was applied.</p>}
    {error && <p role="alert" className="command-menu-error">{error}</p>}
    {request.menu === 'settings' && settingsState && <><p className="command-menu-intro">Current native state. No settings are changed by this view.</p><dl className="native-settings-summary"><dt>Current model</dt><dd>{text(state.currentModel, 'Not selected')}</dd><dt>Project trusted</dt><dd>{state.projectTrusted === true ? 'Yes' : 'No'}</dd><dt>Effective settings</dt><dd><pre>{JSON.stringify(settingsState.effective ?? {}, null, 2)}</pre></dd><dt>Global settings</dt><dd><pre>{JSON.stringify(settingsState.global ?? {}, null, 2)}</pre></dd><dt>Project settings</dt><dd><pre>{JSON.stringify(settingsState.project ?? {}, null, 2)}</pre></dd></dl><button type="button" disabled={!scopeValid || busy || finished} onClick={async () => { await choose({ kind: 'cancel' }); onClose(); onNavigate?.('settings') }}>Open native settings editor</button></>}
    {(request.menu === 'model' || request.menu === 'thinking' || request.menu === 'logout') && schema?.kind === 'argument' && <><p className="command-menu-intro">{request.menu === 'model' ? `Current: ${text(state.selected, 'none')}${state.truncated ? ' · list truncated' : ''}` : request.menu === 'thinking' ? `Current: ${available.includes(text(state.current)) ? text(state.current) : 'not available'}${state.levels && Array.isArray(state.levels) && state.levels.length > 0 ? ` · ${state.levels.length} native levels` : ''}` : 'Choose a provider with stored credentials, then confirm sign-out.'}</p><ul className="native-choice-list" aria-label={heading}>{available.map((value) => {
      const stringValue = String(value)
      if (request.menu === 'model') { const model = array(state.models).map(record).find((item) => `${text(item.provider)}/${text(item.id)}` === stringValue); return <li key={stringValue}><button type="button" disabled={busy || !scopeValid} aria-pressed={selected === stringValue} onClick={() => { setSelected(stringValue); void choose({ kind: 'argument', value: stringValue }) }}><strong>{text(model?.name, stringValue)}</strong><small>{stringValue}{model?.contextWindow ? ` · ${String(model.contextWindow)} context` : ''}</small></button></li> }
      if (request.menu === 'thinking') return <li key={stringValue}><button type="button" disabled={busy || !scopeValid} aria-pressed={selected === stringValue} onClick={() => void choose({ kind: 'argument', value: stringValue })}>{stringValue}</button></li>
      const credential = array(state.credentials).map(record).find((item) => item.providerId === stringValue); return <li key={stringValue}><button type="button" disabled={busy || !scopeValid} aria-pressed={confirmLogout === stringValue} onClick={() => setConfirmLogout(stringValue)}><strong>{stringValue}</strong><small>{text(credential?.type, 'Stored credential')}</small></button></li>
    })}</ul></>}
    {request.menu === 'logout' && confirmLogout && <div className="command-menu-confirm" role="group" aria-label="Confirm provider logout"><p>Sign out of <strong>{confirmLogout}</strong>? This native action removes the stored provider credential.</p><button type="button" disabled={busy || !scopeValid} onClick={() => void choose({ kind: 'argument', value: confirmLogout })}>Confirm sign out</button><button type="button" disabled={busy} onClick={() => setConfirmLogout(null)}>Keep signed in</button></div>}
    {request.menu === 'login' && schema?.kind === 'argument' && <><p className="command-menu-intro">Choose a provider to continue through Pi’s native sign-in flow.</p><ul className="native-choice-list" aria-label="Providers available for sign-in">{schema.values.map((id) => { const provider = array(state.providers).map(record).find((item) => item.id === id); return <li key={id}><button type="button" disabled={!scopeValid || busy || finished} onClick={() => void choose({ kind: 'argument', value: id })}><strong>{text(provider?.name, id)}</strong><small>{provider?.configured === true ? 'Configured' : 'Not configured'} · {provider?.oauth === true ? 'OAuth' : ''}{provider?.apiKey === true ? ' API key' : ''}</small></button></li> })}</ul></>}
    {request.menu === 'scoped-models' && schema?.kind === 'scoped-models' && <><p className="command-menu-intro">Choose which models are available to this session. {schema.canPersist ? 'You may persist these settings.' : 'Persistent settings are unavailable in this workspace.'}</p><div className="native-scoped-models">{array(state.availableModels).map((value) => { const model = record(value); const reference = `${text(model.provider)}/${text(model.id)}`; return <label key={reference}><input type="checkbox" checked={enabled.has(reference)} disabled={busy || !scopeValid} onChange={(event) => setEnabled((current) => { const next = new Set(current); if (event.target.checked) next.add(reference); else next.delete(reference); return next })}/><span><strong>{text(model.name, reference)}</strong><small>{reference}</small></span></label> })}</div><label className="native-persist-choice"><input type="checkbox" checked={persist} disabled={busy || !schema.canPersist || !scopeValid} onChange={(event) => setPersist(event.target.checked)}/> Save model scope to trusted settings</label><button type="button" className="command-menu-primary" disabled={busy || !scopeValid} onClick={() => void choose({ kind: 'scoped-models', enabledModelReferences: [...enabled], persist })}>Apply model scope</button></>}
    {(request.menu === 'tree' || request.menu === 'fork' || request.menu === 'resume') && schema?.kind === 'argument' && <><p className="command-menu-intro">{request.menu === 'tree' ? 'Select a history entry to move the active branch.' : request.menu === 'fork' ? 'Select a user message as the fork point.' : 'Select a session to resume.'}{state.truncated === true ? ' The native list is truncated.' : ''}</p><ul className={`native-session-list ${request.menu === 'tree' ? 'is-tree' : ''}`} aria-label={heading}>{(request.menu === 'tree' ? array(state.entries) : request.menu === 'fork' ? array(state.messages) : array(state.sessions)).map((value, index) => { const item = record(value); const id = text(item.id, text(item.entryId, text(item.sessionId))); const valueForChoice = request.menu === 'resume' ? text(item.sessionId) : id; const depth = Number(item.depth) || 0; const current = request.menu === 'tree' && id === text(state.leafId) || request.menu === 'resume' && id === text(state.currentSessionId); return <li key={valueForChoice || index}><button type="button" disabled={busy || !scopeValid || !valueForChoice} aria-current={current ? 'true' : undefined} onClick={() => setSelected(valueForChoice)} style={{ paddingInlineStart: `${12 + Math.min(depth, 12) * 16}px` }}><strong>{request.menu === 'tree' ? text(item.label, text(item.type, 'Entry')) : request.menu === 'fork' ? text(item.text, 'User message') : text(item.name, text(item.firstMessage, `Session ${id}`))}</strong><small>{request.menu === 'tree' ? text(item.type) : request.menu === 'fork' ? `Message ${id}` : `${text(item.messageCount, '0')} messages${item.modifiedAt ? ` · ${new Date(Number(item.modifiedAt)).toLocaleString()}` : ''}`}</small></button></li> })}</ul><div className="command-menu-actions"><button type="button" disabled={busy || !scopeValid || !selected} onClick={() => void choose({ kind: 'argument', value: selected })}>{request.menu === 'tree' ? 'Go to entry' : request.menu === 'fork' ? 'Fork here' : 'Resume session'}</button>{request.menu === 'tree' && <button type="button" onClick={() => { onClose(); onNavigate?.('sessions') }}>Open session tree</button>}</div></>}
    {(request.menu === 'import' || request.menu === 'export') && <><p className="command-menu-intro">Continue in the app’s native transfer dialog. The menu has no transfer-selection continuation, so it will be cancelled before the native file flow opens.</p><button type="button" disabled={!scopeValid || busy || finished} onClick={async () => { await choose({ kind: 'cancel' }); onClose(); onNavigate?.('help', request.menu === 'export' && state.defaultFormat === 'jsonl' ? 'export:jsonl' : request.menu) }}>{request.menu === 'import' ? 'Open session import' : `Open ${text(state.defaultFormat, 'html').toUpperCase()} export`}</button></>}
    <footer><button type="button" disabled={busy} onClick={() => { if (finished || !bridge || !scope) onClose(); else void choose({ kind: 'cancel' }) }}>{finished ? 'Close' : 'Cancel without changes'}</button></footer>
  </section></div>
}
