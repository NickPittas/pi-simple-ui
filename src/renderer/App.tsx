import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopBridge } from '../shared/ipc-contracts.ts'
import type { WorkspaceSnapshot } from '../shared/workspaces.ts'
import { AppShell } from './layout/AppShell.tsx'

declare global { interface Window { piDesktop?: DesktopBridge } }

export default function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null)
  const [error, setError] = useState('')
  const latestGeneration = useRef(-1)
  const acceptSnapshot = useCallback((next: WorkspaceSnapshot) => {
    if (next.generation < latestGeneration.current) return
    latestGeneration.current = next.generation
    setSnapshot(current => !current || next.generation >= current.generation ? next : current)
  }, [])
  useEffect(() => {
    let alive = true
    const bridge = window.piDesktop
    if (!bridge) { setError('The desktop host is unavailable.'); return }
    void bridge.invoke('workspaces.list', {}).then(result => {
      if (!alive) return
      if (result.ok) acceptSnapshot(result.value)
      else setError(result.error.message)
    }).catch(() => { if (alive) setError('Could not load workspace state.') })
    let unsubscribe: (() => void) | undefined
    void bridge.subscribe('workspaces.changed', undefined, event => {
      if (alive) acceptSnapshot(event.snapshot)
    }).then(result => {
      if (result.ok) { if (alive) unsubscribe = result.value; else result.value() }
      else if (alive) setError(result.error.message)
    }).catch(() => { if (alive) setError('Could not subscribe to workspace updates.') })
    return () => { alive = false; unsubscribe?.() }
  }, [acceptSnapshot])
  return <AppShell snapshot={snapshot} bridge={window.piDesktop} initialError={error} onSnapshot={acceptSnapshot} />
}
