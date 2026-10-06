import { useEffect, useMemo, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { MCP_IPC, type McpEventPayload } from '../../shared/mcp.ts'
import type { McpAppsBridge, McpAppsHostMessage } from '../../shared/mcp-apps.ts'

type Activity = { readonly id: string; readonly server: string; readonly kind: string; readonly detail: string; readonly at: number }
declare global { interface Window { mcpApps?: McpAppsBridge } }
const MAX_FEED = 80

export function McpActivity({ bridge, scope }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope }) {
  const [items, setItems] = useState<Activity[]>([])
  const [filter, setFilter] = useState('all')
  useEffect(() => {
    let active = true; let unsubscribe: (() => void) | undefined
    if (!bridge || !scope) return () => { active = false }
    void bridge.subscribe(MCP_IPC.events, scope, (event: McpEventPayload) => {
      if (!active) return
      const server = event.type === 'availability-changed' ? 'host' : event.server
      const kind = event.type === 'server-state-changed' ? 'connection' : event.type === 'server-removed' ? 'server' : 'availability'
      const detail = event.type === 'server-state-changed' ? `${event.state}${event.authentication === 'required' ? ' · authentication required' : ''}${event.error ? ` · ${event.error}` : ''}` : event.type === 'server-removed' ? 'Server removed' : `MCP host ${event.available ? 'available' : 'unavailable'}`
      setItems((current) => [{ id: `${Date.now()}-${Math.random()}`, server, kind, detail, at: Date.now() }, ...current].slice(0, MAX_FEED))
    }).then((result) => { if (!active) { if (result.ok) result.value() } else if (result.ok) unsubscribe = result.value })
    const appBridge = window.mcpApps
    const stopApp = appBridge?.onMessage((message: McpAppsHostMessage) => {
      if (message.type === 'tool-call-response') setItems((current) => [{ id: `${Date.now()}-${Math.random()}`, server: 'app', kind: 'tool call', detail: message.ok ? `Request ${message.requestId} completed` : `Request ${message.requestId} failed: ${message.error.message}`, at: Date.now() }, ...current].slice(0, MAX_FEED))
      if (message.type === 'error') setItems((current) => [{ id: `${Date.now()}-${Math.random()}`, server: 'app', kind: 'app error', detail: `${message.code}: ${message.message}`, at: Date.now() }, ...current].slice(0, MAX_FEED))
    })
    return () => { active = false; unsubscribe?.(); stopApp?.() }
  }, [bridge, scope])
  const servers = useMemo(() => [...new Set(items.map((item) => item.server))], [items])
  const visible = filter === 'all' ? items : items.filter((item) => item.server === filter)
  return <section className="mcp-activity" aria-label="MCP activity"><header><div><span className="mcp-addon-kicker">LIVE EVENTS</span><h2>Activity</h2></div><label>Filter<select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All servers</option>{servers.map((server) => <option value={server} key={server}>{server}</option>)}</select></label></header>
    {visible.length === 0 ? <p className="mcp-addon-empty">No MCP events have been observed yet. The event contract reports server state and availability; it does not publish tool-call or auth lifecycle events.</p> : <ol aria-live="polite" aria-relevant="additions" aria-label="Newest MCP activity first">{visible.map((item) => <li key={item.id}><time>{new Date(item.at).toLocaleTimeString()}</time><span className="mcp-activity-server">{item.server}</span><span className="mcp-activity-kind">{item.kind}</span><span>{item.detail}</span></li>)}</ol>}
  </section>
}
