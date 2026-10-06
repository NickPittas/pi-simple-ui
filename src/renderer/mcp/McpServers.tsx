import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { NativeMcpFileInfo, NativeMcpListResult, NativeMcpMutationResult, NativeMcpOrigin, NativeMcpServerView } from '../../shared/native-mcp.ts'
import { Switch } from '../agents/AgentFieldControls.tsx'
import { blankEditor, editorFor, McpServerEditor, snapshotOf, toConfigInput, type McpEditorState } from './McpServerEditor.tsx'
import '../agents/agents.css'
import './mcp.css'

const originShort: Record<NativeMcpOrigin, string> = { 'shared-global': 'shared', 'agents-global': 'agents', 'agents-nested': 'agents', user: 'user', 'shared-project': 'project', project: 'project' }
const transportLabel = (server: NativeMcpServerView): string => server.transport === 'override' ? 'override' : server.transport
const summary = (server: NativeMcpServerView): string => server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url ?? server.socket ?? 'Partial entry (overrides another source)'

export function McpServers({ bridge, scope, trusted = false }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly trusted?: boolean }) {
  const [data, setData] = useState<NativeMcpListResult | null>(null)
  const [editor, setEditor] = useState<McpEditorState | null>(null)
  const [baseline, setBaseline] = useState<McpEditorState | null>(null)
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null)
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [hasMcpCommand, setHasMcpCommand] = useState(false)
  const [commandNote, setCommandNote] = useState<string | null>(null)
  const [createOrigin, setCreateOrigin] = useState<NativeMcpOrigin>('user')
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const scopeKey = `${scope?.ownerId ?? ''}:${scope?.generation ?? ''}`

  const dirty = !!editor && !!baseline && snapshotOf(editor) !== snapshotOf(baseline)
  const open = (next: McpEditorState | null) => { setEditor(next); setBaseline(next); setConfirmDelete(false); setFieldErrors({}); setEditorError(null) }
  const guard = (action: () => void) => { if (dirty && !busy) setPendingNav(() => action); else action() }

  const load = useCallback(async () => {
    const current = scopeRef.current
    if (!bridge || !current) return null
    try {
      const result = await bridge.invoke('native.mcp.list', {}, current)
      if (!result.ok) { setError(result.error.message); return null }
      setData(result.value); setError(null)
      return result.value
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read MCP configuration.'); return null }
  }, [bridge])

  // New Pi runtime generation (for example after a restart): drop local state and re-read the files.
  useEffect(() => { setData(null); open(null); setPendingNav(null); setConfirmRestart(false); void load() }, [scopeKey, load])

  // The adapter's own slash command is the only status/reconnect surface; offer actions only if Pi lists it.
  useEffect(() => {
    const current = scopeRef.current
    if (!bridge || !current) { setHasMcpCommand(false); return }
    let cancelled = false
    void bridge.invoke('native.pi.commands-list', {}, current).then((result) => {
      if (cancelled) return
      setHasMcpCommand(result.ok && result.value.commands.some((command) => command.source === 'extension' && command.name.replace(/^\//, '') === 'mcp'))
    }).catch(() => { if (!cancelled) setHasMcpCommand(false) })
    return () => { cancelled = true }
  }, [bridge, scopeKey])

  const fileOf = (origin: NativeMcpOrigin): NativeMcpFileInfo | undefined => data?.files.find((file) => file.origin === origin)
  const canWrite = (origin: NativeMcpOrigin): boolean => !!fileOf(origin)?.writable && (origin !== 'project' && origin !== 'shared-project' ? true : trusted)

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (data?.servers ?? []).filter((server) => !needle || server.name.toLowerCase().includes(needle) || summary(server).toLowerCase().includes(needle))
  }, [data, search])

  const finish = (result: NativeMcpMutationResult, okText: string): boolean => {
    if (result.outcome === 'saved') { setNotice(okText); if (result.restartRequired) setRestartNeeded(true); return true }
    return false
  }

  const read = (server: NativeMcpServerView) => { setNotice(null); open(editorFor(server)) }
  const create = () => { setNotice(null); open(blankEditor(createOrigin)) }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    const current = scopeRef.current
    if (!bridge || !current || !editor || busy) return
    const built = toConfigInput(editor)
    setFieldErrors(built.errors)
    if (!built.config) return
    setBusy(true); setEditorError(null); setNotice(null)
    try {
      const file = fileOf(editor.origin)
      const result = await bridge.invoke('native.mcp.save', { origin: editor.origin, name: editor.name, newName: editor.newName.trim(), expectedRevision: file?.revision ?? '', config: built.config }, current)
      if (!result.ok) { setEditorError(result.error.message); return }
      if (!finish(result.value, 'Saved to the native MCP config.')) {
        setEditorError(result.value.outcome === 'conflict' ? 'The file changed on disk. Reload, review the latest values, and save again.' : result.value.reason ?? 'The change was not saved.')
        if (result.value.outcome === 'conflict') await load()
        return
      }
      const fresh = await load()
      const saved = fresh?.servers.find((server) => server.origin === editor.origin && server.name === editor.newName.trim())
      open(saved ? editorFor(saved) : null)
    } catch (cause) { setEditorError(cause instanceof Error ? cause.message : 'Save failed.') } finally { setBusy(false) }
  }

  const remove = async () => {
    const current = scopeRef.current
    if (!bridge || !current || !editor || !editor.name || busy) return
    setBusy(true); setEditorError(null)
    try {
      const result = await bridge.invoke('native.mcp.remove', { origin: editor.origin, name: editor.name, expectedRevision: fileOf(editor.origin)?.revision ?? '' }, current)
      if (!result.ok) { setEditorError(result.error.message); return }
      if (!finish(result.value, `Removed ${editor.name}.`)) { setConfirmDelete(false); setEditorError(result.value.reason ?? 'The server was not removed.'); if (result.value.outcome === 'conflict') await load(); return }
      open(null); await load()
    } catch (cause) { setEditorError(cause instanceof Error ? cause.message : 'Remove failed.') } finally { setBusy(false) }
  }

  const toggle = async (server: NativeMcpServerView) => {
    const current = scopeRef.current
    if (!bridge || !current || togglingId || !server.writable) return
    setTogglingId(server.id); setError(null)
    try {
      const result = await bridge.invoke('native.mcp.enable', { origin: server.origin, name: server.name, enabled: server.disabled, expectedRevision: fileOf(server.origin)?.revision ?? '' }, current)
      if (!result.ok) { setError(result.error.message); return }
      if (!finish(result.value, `${server.name} ${server.disabled ? 'enabled' : 'disabled'} in the config file.`)) { setError(result.value.reason ?? 'The change was not saved.'); if (result.value.outcome === 'conflict') await load(); return }
      const fresh = await load()
      if (editor && editor.origin === server.origin && editor.name === server.name) { const updated = fresh?.servers.find((item) => item.id === server.id); if (updated && !dirty) open(editorFor(updated)) }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Change failed.') } finally { setTogglingId(null) }
  }

  const restart = async () => {
    if (!bridge) return
    setRestarting(true)
    try {
      const result = await bridge.invoke('native.pi.restart', {})
      setConfirmRestart(false)
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.outcome === 'restarted') { setRestartNeeded(false); setNotice('Pi restarted; the adapter re-read the MCP config.') } else setError(result.value.reason ?? 'Pi could not be restarted.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Pi could not be restarted.') } finally { setRestarting(false) }
  }

  /** Sends the adapter's own `/mcp reconnect <name>` to the root Pi session through the normal submit path. */
  const reconnect = async (name: string) => {
    const current = scopeRef.current
    if (!bridge || !current) return
    setCommandNote(null)
    try {
      const snapshot = await bridge.invoke('native.pi.snapshot', {}, current)
      if (!snapshot.ok) { setCommandNote(snapshot.error.message); return }
      const session = snapshot.value.sessions.find((item) => item.sessionId === snapshot.value.rootSessionId)
      if (!session) { setCommandNote('No Pi session is available to receive the command.'); return }
      const ack = await bridge.invoke('native.pi.submit', { requestId: crypto.randomUUID(), sessionId: session.sessionId, sessionGeneration: session.sessionGeneration, text: `/mcp reconnect ${name}` }, current)
      setCommandNote(ack.ok && ack.value.outcome === 'accepted' ? `Sent /mcp reconnect ${name} to Pi. The result appears in the conversation.` : ack.ok ? ack.value.reason ?? 'Pi did not accept the command.' : ack.error.message)
    } catch (cause) { setCommandNote(cause instanceof Error ? cause.message : 'Could not send the command.') }
  }

  const unavailable = !bridge || !scope
  const selectedId = editor?.mode === 'edit' && editor.name ? `${editor.origin}:${editor.name}` : undefined
  const selected = data?.servers.find((server) => server.id === selectedId)
  const writableOrigins = (['user', 'shared-project', 'project'] as const).filter((origin) => canWrite(origin))
  const file = editor ? fileOf(editor.origin) : undefined

  return <main className="mcp-page agent-definitions-page" aria-label="MCP servers">
    <header className="ad-header"><span className="eyebrow"><span className="eyebrow-line" />NATIVE PI CONFIG</span><h1>MCP servers</h1><p>Edit the MCP server entries Pi's <code>pi-mcp-adapter</code> reads. Pi owns connections, sign-in and tools; this page only edits the config files.</p></header>
    <p className="ad-banner mcp-owner" role="note"><span>Status comes from Pi. Connection state and tool listings appear in the conversation (status key <code>mcp</code>, <code>/mcp</code> command); this app does not connect to servers or run OAuth.{!hasMcpCommand && ' The /mcp command is not listed by the current Pi session.'}</span></p>
    {restartNeeded && <div className="ad-banner ad-banner-warn" role="status"><span>Restart Pi to apply: the adapter reads MCP config when a session starts.</span>
      {confirmRestart ? <><button type="button" className="ad-btn ad-btn-primary" disabled={restarting} onClick={() => void restart()}>{restarting ? 'Restarting…' : 'Restart now'}</button><button type="button" className="ad-btn" disabled={restarting} onClick={() => setConfirmRestart(false)}>Cancel</button></>
        : <button type="button" className="ad-btn" onClick={() => setConfirmRestart(true)}>Restart Pi session</button>}</div>}
    {confirmRestart && <p className="ad-banner ad-banner-warn" role="status"><span>Any reply in progress will be stopped. Your session continues from its saved history.</span></p>}
    {unavailable && <p className="ad-banner ad-banner-warn" role="status">MCP configuration requires an active native runtime.</p>}
    {error && <p className="ad-banner ad-banner-err" role="alert">{error}</p>}
    {!editor && notice && <p className="ad-banner ad-banner-ok" role="status" aria-live="polite">{notice}</p>}
    {!editor && commandNote && <p className="ad-banner" role="status">{commandNote}</p>}
    {pendingNav && <div className="ad-banner ad-banner-warn ad-discard" role="alertdialog" aria-label="Unsaved changes"><span>You have unsaved changes. Discard them and continue?</span><button type="button" className="ad-btn" onClick={() => setPendingNav(null)}>Keep editing</button><button type="button" className="ad-btn ad-btn-danger" onClick={() => { const run = pendingNav; setPendingNav(null); run() }}>Discard</button></div>}
    <div className="ad-toolbar" role="search">
      <label className="ad-tool ad-tool-search"><span>Search</span><input type="search" className="ad-input" placeholder="Filter by name, command or URL" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label className="ad-tool"><span>Add to</span><select className="ad-input" value={createOrigin} onChange={(event) => setCreateOrigin(event.target.value as NativeMcpOrigin)}>{writableOrigins.map((origin) => <option key={origin} value={origin}>{origin === 'user' ? 'User (Pi agent dir)' : origin === 'project' ? 'Project .pi/mcp.json' : 'Project .mcp.json'}</option>)}</select></label>
      <div className="ad-tool-actions"><button type="button" className="ad-btn" onClick={() => void load()}>Reload</button><button type="button" className="ad-btn ad-btn-primary" disabled={unavailable || !canWrite(createOrigin)} onClick={() => guard(create)}>New server</button></div>
    </div>
    <div className={`ad-layout${editor ? ' has-editor' : ''}`}>
      <section className="ad-list" aria-label="MCP servers" aria-busy={!data && !error}>
        <div role="listbox" aria-label="Servers" className="ad-listbox">
          {filtered.map((server) => {
            const isSelected = selectedId === server.id
            return <div className={`ad-row-item${isSelected ? ' is-selected' : ''}${server.shadowedBy ? ' is-shadowed' : ''}`} key={server.id}>
              <button type="button" role="option" aria-selected={isSelected} className="ad-row-main" onClick={() => guard(() => read(server))} title={server.shadowedBy ? `Overridden or merged by the ${originShort[server.shadowedBy]} source` : summary(server)}>
                <span className={`ad-dot ${server.effectiveDisabled ? 'ad-dot-warn' : 'ad-dot-ok'}`} aria-label={server.effectiveDisabled ? 'Disabled' : 'Enabled'} />
                <span className="ad-row-text"><span className="ad-row-name">{server.name}</span><span className="ad-row-desc">{summary(server)}</span></span>
                <span className="mcp-badge">{transportLabel(server)}</span>
                <span className={`ad-scope scope-${originShort[server.origin] === 'project' ? 'project' : 'user'}`}>{originShort[server.origin]}</span>
              </button>
              <span className="ad-row-switch">{togglingId === server.id ? <span className="ad-spinner" role="status" aria-label="Updating" /> : <Switch checked={!server.disabled} disabled={!server.writable || !!togglingId || (server.origin !== 'user' && !trusted)} label={`${server.disabled ? 'Enable' : 'Disable'} ${server.name}`} onChange={() => void toggle(server)} />}</span>
            </div>
          })}
          {!unavailable && data && filtered.length === 0 && <p className="ad-empty">{search ? 'No servers match this search.' : 'No MCP servers are configured in the adapter’s config files.'}</p>}
        </div>
      </section>
      <section className="ad-detail" aria-label="Server editor">
        {editor && file ? <>
          {hasMcpCommand && selected && /^\S+$/.test(selected.name) && editor.mode === 'edit' && <div className="mcp-actions"><button type="button" className="ad-btn ad-btn-sm" onClick={() => void reconnect(selected.name)}>Reconnect in Pi</button>{commandNote && <span className="ad-help">{commandNote}</span>}</div>}
          <McpServerEditor editor={editor} setEditor={setEditor} originLabel={file.label} filePath={file.path} canWrite={canWrite(editor.origin)} busy={busy} dirty={dirty} fieldErrors={fieldErrors} error={editorError}
            confirmDelete={confirmDelete} setConfirmDelete={setConfirmDelete} onSave={(event) => void save(event)} onRevert={() => { if (baseline) { setEditor(baseline); setFieldErrors({}); setEditorError(null) } }} onDelete={() => void remove()} onBack={() => guard(() => open(null))} />
        </> : <div className="ad-placeholder"><h2>Select a server</h2><p>Choose a server to edit its entry, or add a new one. Sources: {data ? data.files.filter((item) => item.exists).map((item) => item.path).join(', ') || 'no config files found yet' : 'loading'}.</p></div>}
      </section>
    </div>
  </main>
}
