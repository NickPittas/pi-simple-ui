import type { JSONValue } from '@earendil-works/pi-coding-agent'
import type { SemanticViewProps } from './index'

function record(value: JSONValue): Record<string, JSONValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JSONValue> : null
}
function list(value: JSONValue | undefined): readonly JSONValue[] { return Array.isArray(value) ? value.slice(0, 20) : [] }
function string(value: JSONValue | undefined, fallback = '—'): string { return typeof value === 'string' ? value : fallback }
function number(value: JSONValue | undefined, fallback = 0): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function bool(value: JSONValue | undefined): boolean { return value === true }
function stamp(value: JSONValue | undefined): string { const time = number(value); return time > 0 ? new Date(time).toLocaleString() : 'Time unavailable' }

/** Presents only the native pi-web-access semantic snapshot; it never runs searches or fetches. */
export function WebAccessActivityView({ state, onAction }: SemanticViewProps) {
  const data = record(state)
  if (!data) return <section className="semantic-view web-access-view" aria-label="Web access activity"><p role="status">Native web activity is unavailable.</p></section>
  const commands = record(data.commands)
  const shortcuts = record(data.shortcuts)
  const rate = record(data.rateLimit)
  const entries = list(data.entries).map(record).filter((item): item is Record<string, JSONValue> => item !== null)
  const curators = list(data.curators).map(record).filter((item): item is Record<string, JSONValue> => item !== null)
  const cachedResults = list(data.cachedResults).map(record).filter((item): item is Record<string, JSONValue> => item !== null)
  const used = Math.max(0, number(rate?.used))
  const max = Math.max(1, number(rate?.max, 1))
  const resetMs = Math.max(0, number(rate?.resetMs))
  return <section className="semantic-view web-access-view" aria-label="Native web access activity">
    <header className="semantic-view-heading web-access-heading"><div><span className="extension-dialog-kicker">PI-WEB-ACCESS · NATIVE STATUS</span><h2>Web activity</h2><p>{data.activityVisible === true ? 'The native activity widget is visible.' : 'The native activity widget is hidden.'} Workflow: <strong>{string(data.workflow)}</strong> · tool activation: <strong>{string(data.toolActivation)}</strong></p></div><button type="button" className="extension-button extension-button-quiet" aria-pressed={data.activityVisible === true} onClick={() => onAction({ type: 'toggle-activity' })}>{data.activityVisible === true ? 'Hide activity widget' : 'Show activity widget'}{typeof shortcuts?.toggleActivity === 'string' ? ` · ${shortcuts.toggleActivity}` : ''}</button></header>
    <section className="web-access-panel" aria-label="Native command availability"><h3>Native commands</h3><dl className="web-access-config">{([['Web search', commands?.websearch], ['Curator', commands?.curator], ['Search', commands?.search], ['Google account', commands?.googleAccount]] as const).map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value === true ? 'Enabled' : value === false ? 'Disabled' : 'Unknown'}</dd></div>)}</dl><p>Configuration is read from the extension’s native settings; this view does not edit or replace native commands.</p></section>
    <section className="web-access-panel" aria-label="Curator progress"><h3>Curator runs</h3>{curators.length === 0 ? <p className="web-access-empty">No active curator runs are reported.</p> : <ul className="web-access-curators">{curators.map((curator) => <li key={string(curator.id)}><strong>{string(curator.phase)}</strong><span>{number(curator.completedCount)} / {number(curator.queryCount)} queries · {number(curator.resultCount)} results · {number(curator.errorCount)} errors</span><small>{bool(curator.browserConnected) ? 'Browser connected' : 'Browser not connected'}{curator.lastHeartbeatAgeMs === null ? ' · heartbeat unavailable' : ` · heartbeat ${Math.round(number(curator.lastHeartbeatAgeMs) / 1000)}s ago`}</small></li>)}</ul>}</section>
    <section className="web-access-panel" aria-label="Web access rate limit"><h3>Native rate limit</h3><p><strong>{used} / {max}</strong> requests used{resetMs > 0 ? ` · resets in ${Math.ceil(resetMs / 1000)}s` : ''}</p><progress max={max} value={Math.min(used, max)} aria-label={`${used} of ${max} native web access requests used`} /></section>
    <section className="web-access-panel" aria-label="Recent web activity"><h3>Recent activity</h3>{entries.length === 0 ? <p className="web-access-empty">No recent activity is reported.</p> : <ol className="web-access-entries">{entries.map((entry) => <li key={string(entry.id)}><div><strong>{string(entry.type)} · {string(entry.target)}</strong><small>{entry.status === null ? 'No HTTP status' : `HTTP ${number(entry.status)}`} · {number(entry.durationMs)} ms</small></div>{entry.error && <p role="note">{string(entry.error)}</p>}</li>)}</ol>}</section>
    <section className="web-access-panel" aria-label="Cached native search summaries"><header className="web-access-results-heading"><h3>Cached result summaries</h3><button type="button" className="extension-button extension-button-primary" disabled={cachedResults.length === 0} onClick={() => onAction({ type: 'review-search-results' })}>Review latest native search results{typeof shortcuts?.reviewSearchResults === 'string' ? ` · ${shortcuts.reviewSearchResults}` : ''}</button></header>{cachedResults.length === 0 ? <p className="web-access-empty">No cached summaries are exposed by the native extension.</p> : <ul className="web-access-results">{cachedResults.map((item) => <li key={string(item.id)}><div><strong>{string(item.title, 'Untitled result')}</strong><small>{string(item.type)} · {stamp(item.timestamp)}</small></div><p>{string(item.summary, 'No summary provided.')}</p></li>)}</ul>}<p>Review opens the extension’s native latest-results flow. This view does not search, fetch pages, or expose full cached content.</p></section>
  </section>
}
