import { useCallback, useEffect, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { NativeResourcesOverview, OverviewPackage } from '../../shared/native-resources-overview.ts'
import './resources-overview.css'

type Area = 'skills' | 'templates' | 'extensions' | 'mcp' | 'agents'
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function contribution(item: OverviewPackage): string {
  const parts: string[] = []
  if (item.contributions) {
    const { commands, skills, prompts } = item.contributions
    if (commands) parts.push(plural(commands, 'command'))
    if (skills) parts.push(plural(skills, 'skill'))
    if (prompts) parts.push(plural(prompts, 'prompt'))
  }
  if (item.manifestExtensions !== null) parts.push(`${plural(item.manifestExtensions, 'extension')} declared`)
  if (parts.length) return parts.join(' · ')
  return item.contributions ? 'No commands reported' : 'Not reported'
}

export function ResourcesPage({ bridge, scope, onSkills, onTemplates, onNavigate }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly cwd?: string; readonly trusted?: boolean; readonly onSkills: () => void; readonly onTemplates: () => void; readonly onNavigate?: (area: Area) => void }) {
  const [data, setData] = useState<NativeResourcesOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    if (!bridge || !scope) return
    setLoading(true); setError(null)
    const result = await bridge.invoke('native.resources.overview', {}, scope)
    setLoading(false)
    if (!result.ok) setError(result.error.message); else setData(result.value)
  }, [bridge, scope])
  useEffect(() => { void load() }, [load])

  const commandTotals = data?.packages.reduce((sum, item) => sum + (item.contributions?.commands ?? 0), 0) ?? 0
  const skillTotal = data ? data.topLevel.skills.length + data.packages.reduce((s, p) => s + (p.contributions?.skills ?? 0), 0) : null
  const promptTotal = data ? data.topLevel.prompts.length + data.packages.reduce((s, p) => s + (p.contributions?.prompts ?? 0), 0) : null
  const tiles: readonly [string, number | null][] = [
    ['Packages', data?.packages.length ?? null],
    ['Extension commands', data ? commandTotals : null],
    ['Skills', skillTotal],
    ['Prompts', promptTotal],
    ['Themes', data?.topLevel.themes.length ?? null],
    ['Context files', data?.contextFiles.length ?? null],
  ]
  const notes = data ? Object.values(data.errors).filter((v): v is string => !!v) : []
  const links: readonly [string, () => void][] = [
    ['Skills', onSkills], ['Prompt templates', onTemplates],
    ['Extensions', () => onNavigate?.('extensions')], ['MCP servers', () => onNavigate?.('mcp')], ['Agent definitions', () => onNavigate?.('agents')],
  ]
  const top = data?.topLevel
  return <main className="resources-page" aria-label="Resources overview">
    <header className="ro-heading"><div><span className="eyebrow"><span className="eyebrow-line" />RESOURCES</span><h1>Resources</h1><p>What Pi loads in this workspace. Read-only; manage items on their own pages.</p></div><button type="button" className="ro-refresh" disabled={loading || !scope} aria-busy={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh'}</button></header>
    {error && <p className="ro-error" role="alert">{error}</p>}
    {notes.map((note) => <p className="ro-note" key={note}>{note}</p>)}
    <div className="ro-tiles" role="list">{tiles.map(([label, value]) => <article key={label} role="listitem"><span>{label}</span><strong>{value ?? '—'}</strong></article>)}</div>
    <nav className="ro-links" aria-label="Manage resources">{links.map(([label, go]) => <button type="button" key={label} onClick={go}>{label}</button>)}</nav>
    <section className="ro-section" aria-labelledby="ro-packages"><h2 id="ro-packages">Packages</h2>
      <p className="ro-hint">Installing or updating packages is not available in the app yet — use <code>pi install</code> in a terminal.</p>
      {!data ? <p className="ro-empty">{loading ? 'Loading…' : 'No data.'}</p> : data.packages.length === 0 ? <p className="ro-empty">No packages are configured.</p> : <div className="ro-table-wrap"><table className="ro-table"><thead><tr><th>Package</th><th>Kind</th><th>Scope</th><th>Version</th><th>Installed</th><th>Contributes</th></tr></thead><tbody>
        {data.packages.map((item) => <tr key={`${item.scope}:${item.source}`}>
          <td><span className="ro-mono" title={item.installedPath ?? item.source}>{item.source}</span>{item.filters.length > 0 && <small className="ro-filters">Filtered: {item.filters.map((f) => `${f.type} (${f.patterns.length ? f.patterns.join(', ') : 'none'})`).join('; ')}</small>}</td>
          <td><span className={`ro-badge ro-kind-${item.kind}`}>{item.kind}</span></td>
          <td>{item.scope}</td>
          <td>{item.packageVersion ?? '—'}{item.pin && <small className="ro-pin"> pinned {item.pin}</small>}</td>
          <td><span className={item.installed ? 'ro-yes' : 'ro-no'} aria-label={item.installed ? 'Installed' : 'Not installed'}>{item.installed ? '✓' : '✗'}</span></td>
          <td>{contribution(item)}</td></tr>)}
      </tbody></table></div>}
    </section>
    <section className="ro-section" aria-labelledby="ro-context"><h2 id="ro-context">Context files</h2>
      {data && data.contextFiles.length > 0 ? <ul className="ro-list">{data.contextFiles.map((file) => <li key={file.path}><span className="ro-mono" title={file.path}>{file.path}</span><span>{file.scope}</span><span>{file.bytes.toLocaleString()} bytes</span></li>)}</ul> : <p className="ro-empty">{data ? 'No AGENTS.md or CLAUDE.md found.' : '—'}</p>}
    </section>
    <section className="ro-section" aria-labelledby="ro-top"><h2 id="ro-top">Top-level items</h2>
      <p className="ro-hint">Items in the user and project resource folders, outside any package.</p>
      {top ? <div className="ro-top-grid">{([['Skills', top.skills], ['Prompts', top.prompts], ['Extensions', top.extensions], ['Themes', top.themes]] as const).map(([label, items]) => <article key={label}><h3>{label} <span>{items.length}</span></h3>{items.length ? <ul>{items.map((item) => <li key={`${item.scope}:${item.name}`}><span className="ro-mono">{item.name}</span><small>{item.scope}</small></li>)}</ul> : <p className="ro-empty">None</p>}</article>)}</div> : <p className="ro-empty">—</p>}
    </section>
  </main>
}
