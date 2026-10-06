import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { WORKERS_IPC, WORKER_SNAPSHOT_DEFAULT_LIMIT, type WorkerEvent, type WorkerSnapshot, type WorkerSummary } from '../../shared/workers.ts'
import type { NativePiSessionSnapshot } from '../../shared/native-pi.ts'
import { NativeObservedConversation, WorkerTranscript } from './WorkerDetail.tsx'

type Props = { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly onOpenWorker?: (workerId: string) => void }
type InlineWorkerConversationsProps = Props & { readonly nativeChildren?: readonly NativePiSessionSnapshot[] }
function messageKey(value: unknown, index: number): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) { const item = value as Record<string, unknown>; if (typeof item.id === 'string') return item.id; if (typeof item.messageId === 'string') return item.messageId }
  return `${index}:${JSON.stringify(value)}`
}
function mergeSnapshots(oldValue: WorkerSnapshot | undefined, fresh: WorkerSnapshot, freshOffset = 0): WorkerSnapshot {
  if (!oldValue) return fresh
  const ordered = new Map<string, unknown>()
  oldValue.messages.forEach((item, index) => ordered.set(messageKey(item, index), item))
  fresh.messages.forEach((item, index) => ordered.set(messageKey(item, freshOffset + index), item))
  return { ...fresh, messages: [...ordered.values()] as WorkerSnapshot['messages'] }
}

function LegacyInlineWorkerConversations({ bridge, scope, onOpenWorker }: Props) {
  const [workers, setWorkers] = useState<readonly WorkerSummary[]>([])
  const [snapshots, setSnapshots] = useState<Record<string, WorkerSnapshot>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scopeKey = scope ? `${scope.ownerId}:${scope.generation}` : 'none'
  const latestScope = useRef(scopeKey)
  const previousScope = useRef<string>('')
  latestScope.current = scopeKey
  const snapshotRef = useRef(snapshots)
  snapshotRef.current = snapshots
  const loadTranscript = useCallback(async (workerId: string, append = false) => {
    if (!bridge || !scope) return
    const requestScope = `${scope.ownerId}:${scope.generation}`
    setLoading(true); setError(null)
    try {
      let cursor: string | undefined = append ? snapshotRef.current[workerId]?.nextCursor ?? undefined : '0'
      let combined: WorkerSnapshot | undefined = append ? snapshotRef.current[workerId] : undefined
      if (append && !cursor) { setLoading(false); return }
      let previousCursor = ''
      for (let page = 0; page < 10_000; page += 1) {
        const response = await bridge.invoke(WORKERS_IPC.snapshot, { workerId, cursor, limit: WORKER_SNAPSHOT_DEFAULT_LIMIT }, scope)
        if (latestScope.current !== requestScope) return
        if (!response.ok) { setError(response.error.message); break }
        if (!response.value) { setError('Worker transcript is no longer available.'); break }
        const snapshot = response.value
        const pageOffset = Number(cursor ?? 0)
        combined = combined ? mergeSnapshots(combined, snapshot, Number.isSafeInteger(pageOffset) ? pageOffset : combined.messages.length) : snapshot
        if (snapshot.nextCursor === null) break
        if (snapshot.nextCursor === previousCursor || snapshot.nextCursor === cursor) { setError('The native worker pager returned a repeated cursor; stopping safely.'); break }
        previousCursor = snapshot.nextCursor
        cursor = snapshot.nextCursor
      }
      if (combined) setSnapshots((current) => ({ ...current, [workerId]: mergeSnapshots(current[workerId], combined!, 0) }))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load a worker transcript.') }
    finally { setLoading(false) }
  }, [bridge, scope])
  const refreshWorkers = useCallback(async () => {
    if (!bridge || !scope) return
    const requestScope = `${scope.ownerId}:${scope.generation}`
    const response = await bridge.invoke(WORKERS_IPC.list, {}, scope)
    if (latestScope.current !== requestScope) return
    if (!response.ok) { setError(response.error.message); return }
    setWorkers(response.value.workers)
    for (const worker of response.value.workers) void loadTranscript(worker.id)
  }, [bridge, scope, loadTranscript])
  useEffect(() => {
    const key = scope ? `${scope.ownerId}:${scope.generation}` : 'none'
    if (previousScope.current !== key) { previousScope.current = key; setWorkers([]); setSnapshots({}); setError(null) }
    let active = true; let unsubscribe: (() => void) | undefined
    if (!bridge || !scope) return () => { active = false }
    void bridge.invoke(WORKERS_IPC.list, {}, scope).then((result) => { if (active && result.ok) { setWorkers(result.value.workers); result.value.workers.forEach((worker) => void loadTranscript(worker.id)) } else if (active && !result.ok) setError(result.error.message) })
    void bridge.subscribe(WORKERS_IPC.events, scope, (event: WorkerEvent) => {
      if (!active) return
      void bridge.invoke(WORKERS_IPC.list, {}, scope).then((result) => { if (active && result.ok) setWorkers(result.value.workers) })
      void loadTranscript(event.workerId)
    }).then((result) => { if (!active) { if (result.ok) result.value() } else if (result.ok) unsubscribe = result.value; else setError(result.error.message) })
    return () => { active = false; unsubscribe?.() }
  }, [bridge, scope, scope?.ownerId, scope?.generation, loadTranscript])
  if (!bridge || !scope) return null
  if (!workers.length && !error) return null
  const byId = new Map(workers.map((worker) => [worker.id, worker]))
  const roots = [...new Set(workers.map((worker) => worker.rootId))]
  return <section className="inline-worker-conversations" aria-label="Observed worker conversations" aria-busy={loading}>
    <header><div><span className="eyebrow"><span className="eyebrow-line"/>OBSERVED SUBAGENTS</span><h2>Worker conversations</h2><p>These transcripts are the workers reported by the active provider. A link to this root conversation is shown only when the backend reports one.</p></div><button type="button" onClick={() => void refreshWorkers()}>Refresh workers</button></header>
    {error && <p role="alert" className="inline-worker-error">{error}</p>}
    {roots.map((rootId) => { const group = workers.filter((worker) => worker.rootId === rootId).sort((a, b) => a.id === rootId ? -1 : b.id === rootId ? 1 : a.startedAt - b.startedAt); const root = byId.get(rootId); return <section className="inline-worker-group" key={rootId} aria-label={`Worker group ${root?.name ?? rootId}`}><h3>{root ? root.name : 'Reported root unavailable'} <small>{rootId}</small></h3>{group.map((worker) => {
      const snapshot = snapshots[worker.id]
      const parent = worker.parentId ? byId.get(worker.parentId) : undefined
      return <article className="inline-worker-card" key={worker.id}><header><div><span className={`worker-detail-state worker-status-${worker.status}`}>{worker.status}</span><h4>{worker.name}</h4><p>{worker.description || worker.type}</p></div><button type="button" onClick={() => onOpenWorker?.(worker.id)}>Open in Workers</button></header><dl><div><dt>Provider</dt><dd>{worker.provider ?? 'Not reported'}</dd></div><div><dt>Parent</dt><dd>{parent?.name ?? (worker.parentId ? `Unknown reported parent (${worker.parentId})` : 'No parent reported')}</dd></div>{snapshot && snapshot.ancestry.length > 0 && <div><dt>Reported ancestry</dt><dd>{snapshot.ancestry.map((id) => byId.get(id)?.name ?? `Unknown (${id})`).join(' / ')}</dd></div>}<div><dt>Root relation</dt><dd>{worker.id === rootId ? 'Provider reports this worker as group root; relation to active conversation is unknown.' : `Provider reports root ${rootId}; relation to active conversation is unknown.`}</dd></div>{snapshot && <div><dt>Transcript coverage</dt><dd>{snapshot.historyComplete === true ? 'Complete' : snapshot.historyComplete === false ? `Paged · ${snapshot.messages.length}${snapshot.totalMessages !== null ? ` of ${snapshot.totalMessages}` : ''}` : 'Extent not reported'}{snapshot.nextCursor ? ' · more available' : ''}</dd></div>}</dl>{worker.error && <p role="alert">{worker.error}</p>}{snapshot ? <WorkerTranscript snapshot={snapshot} paging={loading} loadingMore={() => void loadTranscript(worker.id, true)}/> : <p role="status">Loading observed worker transcript…</p>}</article>
    })}</section> })}
  </section>
}

export function InlineWorkerConversations({ nativeChildren, ...legacyProps }: InlineWorkerConversationsProps) {
  if (nativeChildren !== undefined) {
    return <>{nativeChildren.filter((snapshot) => snapshot.classification !== 'root').map((snapshot) =>
      <NativeObservedConversation key={`${snapshot.sessionId}:${snapshot.sessionGeneration}`} snapshot={snapshot} />,
    )}</>
  }
  return <LegacyInlineWorkerConversations {...legacyProps} />
}
