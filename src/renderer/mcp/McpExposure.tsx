import { useEffect, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { MCP_IPC, type McpExposure, type McpServerListResponse, type McpToolsListResponse } from '../../shared/mcp.ts'
import type { McpToolExposureResolution } from '../../shared/mcp.ts'

const values: readonly (McpExposure | 'inherit')[] = ['inherit', 'direct', 'deferred', 'codemode', 'hidden']
export function McpExposure({ bridge, scope, serverName, trusted = false }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly serverName?: string; readonly trusted?: boolean }) {
  const [snapshot, setSnapshot] = useState<McpServerListResponse | null>(null)
  const [tools, setTools] = useState<McpToolsListResponse['tools']>([])
  const [resolutions, setResolutions] = useState<Record<string, McpToolExposureResolution>>({})
  const [selected, setSelected] = useState(serverName ?? '')
  const [scopeChoice, setScopeChoice] = useState<'user' | 'project'>('user')
  const [draft, setDraft] = useState<Record<string, McpExposure | 'inherit'>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = async () => {
    if (!bridge || !scope) return
    const servers = await bridge.invoke(MCP_IPC.serversList, {}, scope)
    if (!servers.ok) { setError(servers.error.message); return }
    setSnapshot(servers.value)
    const server = selected || serverName || servers.value.servers[0]?.name || ''
    if (server) setSelected(server)
    const result = server ? await bridge.invoke(MCP_IPC.toolsList, { server }, scope) : null
    if (result && !result.ok) setError(result.error.message)
    else if (result?.ok) {
      if (result.value.outcome === 'listed') {
        setTools(result.value.tools)
        const exposureReads = await Promise.all(result.value.tools.map((tool) => bridge.invoke(MCP_IPC.exposureRead, { server, tool: tool.name }, scope)))
        const next: Record<string, McpToolExposureResolution> = {}
        exposureReads.forEach((read, index) => { if (read.ok && read.value.outcome === 'resolved' && read.value.resolution) next[result.value.tools[index]!.name] = read.value.resolution; else if (!read.ok) setError(read.error.message) })
        setResolutions(next)
      }
      else { setTools([]); setError(`Tool exposure unavailable: ${result.value.outcome}.`) }
    }
  }
  useEffect(() => { void load() }, [bridge, scope, serverName, selected])
  const server = snapshot?.servers.find((item) => item.name === selected)
  const revision = scopeChoice === 'project' ? snapshot?.projectRevision : snapshot?.userRevision
  const update = async (tool: string) => {
    if (!bridge || !scope || revision === undefined || (scopeChoice === 'project' && !trusted)) return
    setBusy(tool); setError(null); setStatus(null)
    const value = draft[tool] ?? 'inherit'
    const result = await bridge.invoke(MCP_IPC.exposureUpdate, { scope: scopeChoice, expectedRevision: revision, server: selected, tool, exposure: value === 'inherit' ? null : value }, scope)
    setBusy(null)
    if (!result.ok) { setError(result.error.message); return }
    if (result.value.outcome === 'conflict') { setError('Exposure settings changed elsewhere. Reloaded current native resolution.'); await load(); return }
    if (result.value.outcome !== 'saved') { setError(`Exposure was not saved: ${result.value.outcome}.`); return }
    setStatus(`${tool} exposure saved at ${scopeChoice} scope.`)
    setDraft((current) => { const next = { ...current }; delete next[tool]; return next })
    await load()
  }
  return <section className="mcp-exposure-panel" aria-label="MCP tool exposure">
    <header><div><span className="mcp-addon-kicker">TOOL ROUTING</span><h3>Effective exposure</h3></div><label>Override scope<select value={scopeChoice} onChange={(event) => setScopeChoice(event.target.value as 'user' | 'project')}><option value="user">User</option><option value="project" disabled={!trusted}>Project</option></select></label></header>
    {server && <p>Server exposure: <strong>{server.exposure}</strong> · state: <strong>{server.runtime?.state ?? 'unknown'}</strong></p>}
    {error && <p role="alert" className="mcp-error">{error}</p>}{status && <p role="status">{status}</p>}
    {!server ? <p className="mcp-addon-empty">No server exposure data is available.</p> : tools.map((tool) => {
      const current = draft[tool.name] ?? 'inherit'
      const resolution = resolutions[tool.name] ?? tool.exposure
      return <div className="mcp-exposure-row" key={tool.name}><div><strong>{tool.title || tool.name}</strong><small>Effective: {resolution.exposure} · {resolution.source}; native: {resolution.nativeExposure} · {resolution.nativeSource}</small><small>Read-only: {tool.annotations.readOnlyHint === null ? 'unknown' : String(tool.annotations.readOnlyHint)} · Destructive: {tool.annotations.destructiveHint === null ? 'unknown' : String(tool.annotations.destructiveHint)}</small></div><label>Override<select value={current} disabled={busy === tool.name || (scopeChoice === 'project' && !trusted)} onChange={(event) => setDraft((prev) => ({ ...prev, [tool.name]: event.target.value as McpExposure | 'inherit' }))}>{values.map((value) => <option key={value} value={value}>{value === 'inherit' ? 'Inherit native exposure' : value}</option>)}</select></label><button type="button" disabled={busy === tool.name || (scopeChoice === 'project' && !trusted)} onClick={() => void update(tool.name)}>{busy === tool.name ? 'Saving…' : 'Save'}</button></div>
    })}
  </section>
}
