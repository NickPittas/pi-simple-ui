import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { NativeUsageRange, NativeUsageScope, NativeUsageSummaryResult, NativeUsageTotals } from '../../shared/native-usage.ts'
import './native-usage.css'

type Props = { bridge?: DesktopBridge; scope?: RuntimeScope; trusted: boolean; workspacePath?: string; onOpenSession?: (file: string) => void }

const SCOPES: Array<{ id: NativeUsageScope; label: string }> = [
  { id: 'current-session', label: 'Current session' },
  { id: 'workspace', label: 'This workspace' },
  { id: 'all', label: 'All sessions' },
]
const RANGES: Array<{ id: NativeUsageRange; label: string }> = [
  { id: 'today', label: 'Today' }, { id: '7d', label: 'Last 7 days' }, { id: '30d', label: 'Last 30 days' }, { id: 'all', label: 'All time' },
]
const AUTO_REFRESH_MS = 5000

export function formatTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(Math.round(value))
}
export function formatCost(value: number | null): string {
  if (value === null) return 'n/a'
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}
const formatWhen = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }

function Kpi({ label, value, accent, title }: { label: string; value: string; accent: string; title?: string }) {
  return <div className="nusage-kpi" style={{ borderTopColor: `var(--c-${accent})` }} title={title}><span>{label}</span><strong>{value}</strong></div>
}

function DayChart({ days }: { days: NativeUsageSummaryResult['byDay'] }) {
  if (days.length === 0) return <p className="nusage-empty">No dated usage in this range.</p>
  const shown = days.slice(-60)
  const max = Math.max(1, ...shown.map((d) => d.totalTokens))
  const W = 720, H = 150, pad = 18, gap = 3
  const bw = Math.max(2, (W - pad * 2) / shown.length - gap)
  return <div className="nusage-chart" role="img" aria-label={`Tokens per day, ${shown.length} days`}>
    <svg viewBox={`0 0 ${W} ${H + 18}`} preserveAspectRatio="none">
      <line x1={pad} y1={H} x2={W - pad} y2={H} stroke="var(--c-surface1)" />
      {shown.map((d, i) => {
        const x = pad + i * (bw + gap)
        const hOut = (d.outputTokens / max) * (H - 8), hIn = (d.inputTokens / max) * (H - 8), hCache = ((d.cacheReadTokens + d.cacheWriteTokens) / max) * (H - 8)
        return <g key={d.date}>
          <title>{`${d.date}: ${formatTokens(d.totalTokens)} tokens, ${formatCost(d.cost)}`}</title>
          <rect x={x} y={H - hCache} width={bw} height={hCache} fill="var(--c-teal)" opacity=".75" />
          <rect x={x} y={H - hCache - hIn} width={bw} height={hIn} fill="var(--c-blue)" />
          <rect x={x} y={H - hCache - hIn - hOut} width={bw} height={hOut} fill="var(--c-green)" />
        </g>
      })}
      <text x={pad} y={H + 14} fill="var(--c-subtext0)" fontSize="10" fontFamily="var(--font-mono)">{shown[0].date}</text>
      <text x={W - pad} y={H + 14} fill="var(--c-subtext0)" fontSize="10" fontFamily="var(--font-mono)" textAnchor="end">{shown[shown.length - 1].date}</text>
    </svg>
    <div className="nusage-legend"><span><i style={{ background: 'var(--c-blue)' }} />input</span><span><i style={{ background: 'var(--c-green)' }} />output</span><span><i style={{ background: 'var(--c-teal)' }} />cache</span><span className="nusage-muted">peak {formatTokens(max)}/day</span></div>
  </div>
}

const cells = (t: NativeUsageTotals) => <>
  <td>{formatTokens(t.totalTokens)}</td><td>{formatTokens(t.inputTokens)}</td><td>{formatTokens(t.outputTokens)}</td><td>{formatTokens(t.cacheReadTokens + t.cacheWriteTokens)}</td><td>{formatCost(t.cost)}</td><td>{t.messages}</td>
</>
const head = (first: string) => <thead><tr><th>{first}</th><th>Total</th><th>Input</th><th>Output</th><th>Cache</th><th>Cost</th><th>Msgs</th></tr></thead>

export function NativeUsagePage({ bridge, scope, trusted, workspacePath, onOpenSession }: Props) {
  const [tab, setTab] = useState<NativeUsageScope>('current-session')
  const [range, setRange] = useState<NativeUsageRange>('all')
  const [data, setData] = useState<NativeUsageSummaryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const scopeKey = `${scope?.ownerId ?? ''}:${scope?.generation ?? ''}`

  const load = useCallback(async (quiet: boolean) => {
    const current = scopeRef.current
    if (!bridge || !current || !trusted) return
    const mine = ++seq.current
    if (!quiet) setLoading(true)
    const result = await bridge.invoke('native.usage.summary', { scope: tab, range }, current)
    if (mine !== seq.current) return
    setLoading(false)
    if (!result.ok) { setError(result.error.message); return }
    setError(null); setData(result.value)
  }, [bridge, tab, range, trusted])

  useEffect(() => { setData(null); void load(false); return () => { seq.current++ } }, [load, scopeKey])

  useEffect(() => {
    if (tab !== 'current-session' || !trusted) return
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(true) }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [tab, trusted, load])

  useEffect(() => {
    if (tab !== 'current-session' || !bridge || !scope || !trusted) return
    let stop: (() => void) | undefined
    let active = true
    void bridge.subscribe('native.pi.events', scope, (envelope) => {
      const payload = envelope.kind === 'event' ? envelope.payload : null
      if (typeof payload === 'object' && payload !== null && !Array.isArray(payload) && ((payload as { type?: unknown }).type === 'turn_end' || (payload as { type?: unknown }).type === 'agent_end')) void load(true)
    }).then((result) => { if (!result.ok) return; if (active) stop = result.value; else result.value() }).catch(() => undefined)
    return () => { active = false; stop?.() }
  }, [tab, bridge, scopeKey, trusted, load])

  const canOpen = tab === 'workspace' && !!onOpenSession
  return <section className="area-page nusage-page">
    <div className="eyebrow"><span className="eyebrow-line" />PI DESKTOP</div>
    <h1>Usage</h1>
    <p className="area-lede">{workspacePath ?? 'No workspace'} - computed read-only from Pi session files</p>
    {!trusted || !scope ? <div className="empty-state"><h2>No active workspace</h2><p>Open an available workspace to see usage.</p></div> : <>
      <div className="nusage-bar">
        <div className="nusage-tabs" role="tablist" aria-label="Usage scope">
          {SCOPES.map((s) => <button key={s.id} role="tab" aria-selected={tab === s.id} className={`nusage-tab${tab === s.id ? ' nusage-tab-current' : ''}`} onClick={() => setTab(s.id)}>{s.label}</button>)}
        </div>
        <label className="nusage-range">Range <select value={range} onChange={(e) => setRange(e.target.value as NativeUsageRange)}>{RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
        <button className="nusage-refresh" disabled={loading} onClick={() => void load(false)}>{loading ? 'Loading...' : 'Refresh'}</button>
      </div>
      {error && <div className="nusage-error" role="alert">{error}</div>}
      {data?.error && <div className="nusage-error" role="alert">{data.error}</div>}
      {!data && !error && <p className="nusage-empty">{loading ? 'Reading session files...' : 'No data yet.'}</p>}
      {data && !data.error && <>
        <div className="nusage-kpis">
          <Kpi label="Total tokens" value={formatTokens(data.totals.totalTokens)} accent="blue" title={`${data.totals.totalTokens.toLocaleString()} tokens`} />
          <Kpi label="Input" value={formatTokens(data.totals.inputTokens)} accent="green" />
          <Kpi label="Output" value={formatTokens(data.totals.outputTokens)} accent="peach" />
          <Kpi label="Cache read" value={formatTokens(data.totals.cacheReadTokens)} accent="teal" />
          <Kpi label="Cache write" value={formatTokens(data.totals.cacheWriteTokens)} accent="mauve" />
          <Kpi label="Cost" value={formatCost(data.totals.cost)} accent="green" title={data.totals.cost === null ? 'No cost recorded by Pi for these messages' : undefined} />
          <Kpi label="Messages" value={String(data.totals.messages)} accent="blue" />
        </div>
        <div className="nusage-meta">{data.filesScanned} session file(s) read{data.capped ? ' (capped)' : ''} - updated {formatWhen(data.generatedAt)}</div>
        {data.notes.map((note) => <div key={note} className="nusage-note">{note}</div>)}
        <section className="nusage-card"><h2>Tokens by day</h2><DayChart days={data.byDay} /></section>
        <section className="nusage-card"><h2>By model</h2>{data.byModel.length === 0 ? <p className="nusage-empty">No model usage in this range.</p> : <div className="nusage-scroll"><table>{head('Model')}<tbody>{data.byModel.map((m) => <tr key={`${m.provider}/${m.model}`}><th scope="row"><span className="nusage-muted">{m.provider}/</span>{m.model}</th>{cells(m)}</tr>)}</tbody></table></div>}</section>
        <section className="nusage-card"><h2>Top sessions</h2>{data.bySession.length === 0 ? <p className="nusage-empty">No sessions with usage in this range.</p> : <div className="nusage-scroll"><table>{head('Session')}<tbody>{data.bySession.map((s) => <tr key={s.file}><th scope="row">{canOpen ? <button className="nusage-link" onClick={() => onOpenSession?.(s.file)}>{s.title}</button> : <span>{s.title}</span>}<small>{formatWhen(s.modified)}</small></th>{cells(s)}</tr>)}</tbody></table></div>}</section>
        {data.subagents && <section className="nusage-card"><h2>Subagents (approximate)</h2><div className="nusage-sub"><span>{formatTokens(data.subagents.totalTokens)} tokens</span><span>in {formatTokens(data.subagents.inputTokens)}</span><span>out {formatTokens(data.subagents.outputTokens)}</span><span>cache {formatTokens(data.subagents.cacheReadTokens + data.subagents.cacheWriteTokens)}</span><span>{formatCost(data.subagents.cost)}</span><span>{data.subagents.messages} msgs / {data.subagentFiles} transcripts</span></div></section>}
      </>}
    </>}
  </section>
}
