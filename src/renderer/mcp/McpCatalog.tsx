import { useEffect, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { MCP_IPC, type McpPromptGetResponse, type McpPromptListResponse, type McpResourceListResponse, type McpResourceTemplatesListResponse, type McpToolsListResponse, type McpServerInstructionsResponse } from '../../shared/mcp.ts'
import { McpExposure } from './McpExposure'

function pretty(value: unknown) { try { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) } catch { return String(value) } }

export function McpCatalog({ bridge, scope, server, trusted = false }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly server: string; readonly trusted?: boolean }) {
  const [prompts, setPrompts] = useState<McpPromptListResponse['prompts']>([])
  const [resources, setResources] = useState<McpResourceListResponse['resources']>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [args, setArgs] = useState<Record<string, string>>({})
  const [result, setResult] = useState<McpPromptGetResponse | null>(null)
  const [resourceResult, setResourceResult] = useState<unknown>(null)
  const [tools, setTools] = useState<McpToolsListResponse['tools']>([])
  const [toolsTruncated, setToolsTruncated] = useState(false)
  const [templates, setTemplates] = useState<McpResourceTemplatesListResponse['templates']>([])
  const [templatesTruncated, setTemplatesTruncated] = useState(false)
  const [instructions, setInstructions] = useState<McpServerInstructionsResponse | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (!bridge || !scope) return () => { live = false }
    void Promise.all([bridge.invoke(MCP_IPC.promptsList, { server }, scope), bridge.invoke(MCP_IPC.resourcesList, { server }, scope), bridge.invoke(MCP_IPC.toolsList, { server }, scope), bridge.invoke(MCP_IPC.resourceTemplatesList, { server }, scope), bridge.invoke(MCP_IPC.serverInstructions, { server }, scope)]).then(([p, r, t, rt, si]) => {
      if (!live) return
      if (p.ok) setPrompts(p.value.prompts); else setError(p.error.message)
      if (r.ok) setResources(r.value.resources); else setError(r.error.message)
      if (t.ok) { if (t.value.outcome === 'listed') { setTools(t.value.tools); setToolsTruncated(t.value.truncated) } else setError(`Tool catalog ${t.value.outcome}.`) } else setError(t.error.message)
      if (rt.ok) { if (rt.value.outcome === 'listed') { setTemplates(rt.value.templates); setTemplatesTruncated(rt.value.truncated) } else setError(`Resource templates ${rt.value.outcome}.`) } else setError(rt.error.message)
      if (si.ok) setInstructions(si.value); else setError(si.error.message)
    }).catch(() => { if (live) setError('Could not load server capabilities.') })
    return () => { live = false }
  }, [bridge, scope, server])
  const choosePrompt = (name: string) => { setSelected(name); setArgs({}); setResult(null) }
  const runPrompt = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!bridge || !scope || !selected) return
    const response = await bridge.invoke(MCP_IPC.promptsGet, { server, prompt: selected, arguments: args }, scope)
    if (response.ok) { setResult(response.value); setError(null) } else setError(response.error.message)
  }
  const readResource = async (uri: string) => {
    if (!bridge || !scope) return
    const response = await bridge.invoke(MCP_IPC.resourcesRead, { server, uri }, scope)
    if (!response.ok) setError(response.error.message)
    else if (response.value.outcome === 'unsupported') { setResourceResult('This server does not support reading this resource.'); setStatus('Resource read unsupported.') }
    else { setResourceResult(response.value.contents); setStatus(`Read ${uri}`) }
  }
  const openApp = async (uri: string) => {
    if (!bridge || !scope) return
    setStatus(`Opening ${uri} in the native sandboxed MCP app window…`)
    const response = await bridge.invoke(MCP_IPC.appsOpen, { server, resourceUri: uri }, scope)
    if (!response.ok) { setError(response.error.message); setStatus(null); return }
    setStatus(response.value.outcome === 'opened' ? `Opened native MCP app window${response.value.windowId !== null ? ` ${response.value.windowId}` : ''}.` : `MCP app window ${response.value.outcome}.`)
  }
  return <section className="mcp-catalog" aria-label={`${server} capabilities`}>
    <div className="mcp-catalog-grid">
      <section className="mcp-catalog-card"><h3>Resources</h3>{resources.length === 0 ? <p className="mcp-empty">No resources reported.</p> : <ul className="mcp-capability-list">{resources.map((item) => <li key={item.uri}><div><strong>{item.title || item.name}</strong><small>{item.uri}{item.mimeType ? ` · ${item.mimeType}` : ''}</small>{item.description && <small>{item.description}</small>}</div>{item.mimeType?.toLowerCase().includes('mcp-app') ? <button type="button" onClick={() => void openApp(item.uri)}>Open app</button> : <button type="button" onClick={() => void readResource(item.uri)}>Read</button>}</li>)}</ul>}{templatesTruncated && <p role="note">The native resource-template catalog is truncated.</p>}{templates.length > 0 && <><h4>Resource templates</h4><ul className="mcp-capability-list">{templates.map((item) => <li key={item.uriTemplate}><div><strong>{item.title || item.name}</strong><small>{item.uriTemplate}</small>{item.description && <small>{item.description}</small>}</div></li>)}</ul></>}{instructions?.outcome === 'available' && instructions.instructions && <details><summary>Server instructions</summary><pre>{instructions.instructions}</pre></details>}{instructions?.outcome === 'denied' && <p role="status">Server instructions are denied by the host.</p>}{instructions?.outcome === 'unavailable' && <p role="status">Server instructions are unavailable in the current native runtime.</p>}</section>
      <section className="mcp-catalog-card"><h3>Prompts</h3>{prompts.length === 0 ? <p className="mcp-empty">No prompts reported.</p> : <ul className="mcp-capability-list">{prompts.map((item) => <li key={item.name}><div><strong>{item.title || item.name}</strong>{item.description && <small>{item.description}</small>}</div><button type="button" onClick={() => choosePrompt(item.name)}>Use</button></li>)}</ul>}
        {selected && <form className="mcp-prompt-form" onSubmit={runPrompt}><h4>{prompts.find((item) => item.name === selected)?.title || selected}</h4>{prompts.find((item) => item.name === selected)?.arguments?.map((arg) => <label key={arg.name}>{arg.name}{arg.required ? ' *' : ''}{arg.description && <small>{arg.description}</small>}<input required={arg.required} value={args[arg.name] ?? ''} onChange={(event) => setArgs((current) => ({ ...current, [arg.name]: event.target.value }))} /></label>)}<button type="submit">Get prompt</button></form>}
      </section>
      <section className="mcp-catalog-card"><h3>Tools</h3>{toolsTruncated && <p role="note">The native tool catalog is truncated.</p>}{tools.length === 0 ? <p className="mcp-empty">No native tools reported.</p> : <ul className="mcp-capability-list">{tools.map((tool) => <li key={tool.name}><div><strong>{tool.title || tool.name}</strong>{tool.description && <small>{tool.description}</small>}<small>{tool.exposure.exposure} · {tool.exposure.source} · {tool.exposure.serverState}</small></div><details><summary>Native schema & annotations</summary><pre>{pretty({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations, taskSupport: tool.taskSupport })}</pre></details></li>)}</ul>}{tools.length > 0 && <McpExposure bridge={bridge} scope={scope} serverName={server} trusted={trusted}/>}</section>
    </div>
    {(result || resourceResult !== null) && <section className="mcp-result-view"><header><h3>{result ? `Prompt: ${result.prompt}` : 'Resource result'}</h3><button type="button" onClick={() => { setResult(null); setResourceResult(null) }}>Close result</button></header>{result?.description && <p>{result.description}</p>}<pre>{pretty(result?.messages ?? resourceResult)}</pre></section>}
    {status && <p role="status" aria-live="polite" className="mcp-feedback">{status}</p>}{error && <p role="alert" className="mcp-error">{error}</p>}
  </section>
}
