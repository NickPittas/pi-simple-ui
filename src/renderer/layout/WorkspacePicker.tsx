import { useRef, useState } from 'react'
import type { DesktopBridge } from '../../shared/ipc-contracts.ts'
import type { WorkspaceSnapshot, WorkspaceOperationResult } from '../../shared/workspaces.ts'

export function WorkspacePicker({ bridge, snapshot, onSnapshot }: { bridge?: DesktopBridge; snapshot: WorkspaceSnapshot | null; onSnapshot: (s: WorkspaceSnapshot) => void }) {
  const input = useRef<HTMLInputElement>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const apply = (value: WorkspaceOperationResult) => { onSnapshot(value.snapshot); setError(value.outcome === 'missing' ? 'That folder is no longer available.' : '') }
  async function call(action: () => Promise<import('../../shared/ipc-contracts.ts').IpcResult<WorkspaceOperationResult>>) {
    if (!bridge || busy) return
    setBusy(true); setError('')
    try { const result = await action(); if (result.ok) apply(result.value); else setError(result.error.message) }
    catch { setError('The workspace request could not be completed.') } finally { setBusy(false) }
  }
  async function chooseFolder() {
    if (!bridge || busy) return
    setBusy(true); setError('')
    try {
      const picked = await bridge.invoke('workspaces.pick-folder', {})
      if (!picked.ok) { setError(picked.error.message); return }
      // Closing the native picker without a choice has no workspace side effect.
      if (picked.value.path === null) return
      const opened = await bridge.invoke('workspaces.open', { path: picked.value.path })
      if (opened.ok) apply(opened.value)
      else setError(opened.error.message)
    } catch { setError('The folder picker could not be completed.') }
    finally { setBusy(false) }
  }
  const active = snapshot?.workspaces.find(w => w.id === snapshot.activeWorkspaceId)
  return <div className="workspace-picker">
    <div className="workspace-label">WORKSPACE</div>
    <div className="workspace-card"><span className="workspace-glyph" aria-hidden="true">⌂</span><span className="workspace-copy"><strong>{active?.name ?? 'No workspace'}</strong><small>{active?.path ?? 'Choose a folder to begin'}{active && active.status !== 'available' ? ` · ${active.status}` : ''}</small>{active && <small>Trust is managed by the native Pi process</small>}</span><span className="workspace-dot" aria-hidden="true" /></div>
    <button type="button" aria-label={busy ? 'Choosing folder' : 'Open folder'} className="secondary-button workspace-choose" disabled={busy || !bridge} onClick={() => void chooseFolder()}>{busy ? 'Choosing folder…' : 'Open folder…'}</button>
    <form className="workspace-path" onSubmit={e => { e.preventDefault(); const path = input.current?.value.trim(); if (path) void call(() => bridge!.invoke('workspaces.open', { path })) }}><label htmlFor="workspace-path">Or enter a folder path</label><div><input id="workspace-path" ref={input} type="text" placeholder="/path/to/project" disabled={busy || !bridge} /><button className="secondary-button" disabled={busy || !bridge}>{busy ? 'Opening…' : 'Open'}</button></div></form>
    {!!snapshot?.workspaces.length && <details className="recent-workspaces"><summary>Recent folders</summary>{snapshot.workspaces.map(w => <div className="recent-row" key={w.id}><button className="text-button recent-open" disabled={busy || !bridge} onClick={() => void call(() => bridge!.invoke('workspaces.open-recent', { workspaceId: w.id }))}>{w.name}<small>{w.path}{w.status !== 'available' ? ` · ${w.status}` : ''}</small></button></div>)}</details>}
    {snapshot?.pendingPath && <div className="pending-workspace" role="status">Opening… {snapshot.pendingPath}<button className="text-button" disabled={busy} onClick={() => void call(() => bridge!.invoke('workspaces.cancel', {}))}>Cancel</button></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>
}
