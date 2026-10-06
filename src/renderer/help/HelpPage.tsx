import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { DIAGNOSTIC_SUBSYSTEMS, type DiagnosticLevel, type DiagnosticSubsystem, type DiagnosticsSnapshot, type DiagnosticsTrustSnapshot } from '../../shared/diagnostics.ts'
import type { CommandDispatchResponse } from '../../shared/commands.ts'
import { TransferDialogs } from './TransferDialogs'
import './help.css'

type NativeInfoCommand = 'hotkeys' | 'changelog' | 'session' | 'bug'
const infoCommands: readonly { command: NativeInfoCommand; title: string; description: string }[] = [
  { command: 'hotkeys', title: 'Keyboard shortcuts', description: 'Ask the native help command for the current shortcut reference.' },
  { command: 'changelog', title: 'Changelog', description: 'Open the native changelog command.' },
  { command: 'session', title: 'Session information', description: 'Request the active session summary from the native command.' },
]
function details(value: unknown) { try { return JSON.stringify(value, null, 2) } catch { return String(value) } }

export function HelpPage({ bridge, scope, onTrustUi, transferMode, transferFormat, onTransferModeConsumed }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly onTrustUi?: () => void; readonly transferMode?: 'import' | 'export'; readonly transferFormat?: 'html' | 'jsonl'; readonly onTransferModeConsumed?: () => void }) {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null)
  const [trust, setTrust] = useState<DiagnosticsTrustSnapshot | null>(null)
  const [level, setLevel] = useState<'all' | DiagnosticLevel>('all')
  const [category, setCategory] = useState<'all' | DiagnosticSubsystem>('all')
  const [commandResults, setCommandResults] = useState<Partial<Record<NativeInfoCommand, string>>>({})
  const [commandBusy, setCommandBusy] = useState<NativeInfoCommand | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const readDiagnostics = useCallback(async () => {
    if (!bridge || !scope) { setLoading(false); return }
    setLoading(true); setError(null)
    const [read, trustResult] = await Promise.all([bridge.invoke('diagnostics.read', {}, scope), bridge.invoke('diagnostics.trust', {}, scope)])
    if (read.ok) setDiagnostics(read.value); else setError(read.error.message)
    if (trustResult.ok) setTrust(trustResult.value); else setError((current) => current ?? trustResult.error.message)
    setLoading(false)
  }, [bridge, scope])
  useEffect(() => { void readDiagnostics().catch(() => { setError('Could not read diagnostics.'); setLoading(false) }) }, [readDiagnostics])
  const filtered = useMemo(() => (diagnostics?.entries ?? []).filter((item) => (level === 'all' || item.level === level) && (category === 'all' || item.subsystem === category)).slice().reverse(), [diagnostics, level, category])
  const runCommand = async (command: NativeInfoCommand) => {
    if (!bridge || !scope || commandBusy) return
    setCommandBusy(command); setCommandResults((current) => ({ ...current, [command]: undefined }))
    const result = await bridge.invoke('commands.dispatch', { input: `/${command}` }, scope)
    setCommandBusy(null)
    if (!result.ok) setCommandResults((current) => ({ ...current, [command]: `Could not run /${command}: ${result.error.message}` }))
    else setCommandResults((current) => ({ ...current, [command]: formatCommandResult(result.value) }))
  }
  const exportDiagnostics = async () => {
    if (!bridge || !scope) return
    setExportStatus(null)
    const response = await bridge.invoke('diagnostics.export', {}, scope)
    if (!response.ok) setExportStatus(`Export failed: ${response.error.message}`)
    else setExportStatus(response.value.outcome === 'saved' ? 'Diagnostics saved using the native save flow.' : response.value.outcome === 'cancelled' ? 'Diagnostics export cancelled.' : 'Diagnostics export failed.')
  }
  return <main className="help-page" aria-label="Help and diagnostics">
    <header className="help-page-heading"><div><span className="eyebrow"><span className="eyebrow-line"/>HELP & SUPPORT</span><h1>Help</h1><p>App help, transfers, and native diagnostic information.</p></div></header>
    <p className="help-native-note"><strong>App help, not native help.</strong> The information below is separate from the native <code>/help</code> command.</p>
    <section className="help-info-grid" aria-label="Native information commands">{infoCommands.map((item) => <article className="help-info-card" key={item.command}><span className="help-command-tag">/{item.command}</span><h2>{item.title}</h2><p>{item.description}</p><button type="button" disabled={commandBusy !== null} onClick={() => void runCommand(item.command)}>{commandBusy === item.command ? 'Running…' : `Run /${item.command}`}</button>{commandResults[item.command] && <p role="status" className="help-command-result">{commandResults[item.command]}</p>}</article>)}</section>
    <section className="help-bug-card"><div><span className="help-command-tag">/bug</span><h2>Bug report helper</h2><p>Run the native bug-report command. This page does not submit a report or invent a report link. The current command response only confirms dispatch; it does not return a prepared report payload or URL.</p></div><button type="button" disabled={commandBusy !== null} onClick={() => void runCommand('bug')}>{commandBusy === 'bug' ? 'Running…' : 'Run /bug'}</button>{commandResults.bug && <p role="status" className="help-command-result">{commandResults.bug}</p>}</section>
      <TransferDialogs bridge={bridge} scope={scope} openMode={transferMode} initialFormat={transferFormat} onModeConsumed={onTransferModeConsumed}/>
    <section className="help-diagnostics"><header><div><span className="help-kicker">LOCAL HOST RECORDS</span><h2>Diagnostics</h2><p>Filter by level and category. Export uses the native save flow.</p></div><button type="button" className="help-primary" onClick={() => void exportDiagnostics()}>Export diagnostics</button></header>
      {exportStatus && <p role="status" className="help-result">{exportStatus}</p>}{loading ? <p className="help-muted">Loading diagnostics…</p> : <>
        {error && <p role="alert" className="help-error">{error}</p>}
        <div className="help-filter-row"><label>Level<select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}><option value="all">All levels</option>{(['debug', 'info', 'warn', 'error'] as const).map((item) => <option key={item}>{item}</option>)}</select></label><label>Category<select value={category} onChange={(event) => setCategory(event.target.value as typeof category)}><option value="all">All categories</option>{DIAGNOSTIC_SUBSYSTEMS.map((item) => <option key={item}>{item}</option>)}</select></label><span>{filtered.length} entries</span></div>
        {filtered.length === 0 ? <p className="help-muted">No diagnostic entries match these filters.</p> : <ol className="help-log-list" aria-live="polite">{filtered.map((entry, index) => <li key={`${entry.timestamp}-${index}`}><time>{new Date(entry.timestamp).toLocaleString()}</time><span className={`help-level level-${entry.level}`}>{entry.level}</span><span className="help-subsystem">{entry.subsystem}</span><div><p>{entry.message}</p>{entry.details !== undefined && <details><summary>Details</summary><pre>{details(entry.details)}</pre></details>}</div></li>)}</ol>}
        {diagnostics && <p className="help-retention">Generated {new Date(diagnostics.generatedAt).toLocaleString()} · retention {diagnostics.retentionDays} days · configuration values and credential material are not included.</p>}
      </>}
    </section>
    <section className="help-trust-card"><header><div><span className="help-kicker">WORKSPACE ACCESS</span><h2>Trust state</h2></div><button type="button" onClick={onTrustUi}>Open workspace trust controls</button></header>
      {!trust || trust.status === 'unavailable' ? <p className="help-muted">Workspace trust details are unavailable.</p> : trust.workspaces.length === 0 ? <p className="help-muted">No workspace trust records.</p> : <ul>{trust.workspaces.map((workspace) => <li key={workspace.workspaceId}><div><strong>{workspace.path}</strong><small>{workspace.active ? 'Active workspace' : 'Other workspace'} · {workspace.workspaceStatus}</small></div><span className={`help-trust-pill trust-${workspace.decision}`}>{workspace.decision}</span>{workspace.requiresReapproval && <small>Requires reapproval</small>}</li>)}</ul>}
      <p className="help-trust-hint">To grant or revoke trust, use the workspace selector’s Recent folders controls. This page only reports trust state.</p>
    </section>
  </main>
}

function formatCommandResult(result: CommandDispatchResponse): string {
  if (result.outcome === 'rejected') return `/${result.outcome}: ${result.reason}.`
  if (result.outcome === 'builtin-adapter-pending') return `/${result.commandName} was recognized, but its native UI adapter is not available.`
  if (result.outcome === 'cancelled') return `/${result.commandName} cancelled; no selection was applied.`
  if (result.outcome === 'effect-data') return `/${result.commandName} · ${result.effect}${result.truncated ? ' · response truncated' : ''}\n${details(result.data)}`
  if (result.outcome === 'menu-request') return `/${result.commandName} returned a native ${result.menu} menu. Open the command from the conversation to continue it.`
  return `/${result.commandName} dispatched.`
}
