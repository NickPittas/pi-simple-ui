import { useState, type FormEvent } from 'react'
import {
  NATIVE_MCP_LIFECYCLES,
  type NativeMcpConfigInput,
  type NativeMcpKvView,
  type NativeMcpOrigin,
  type NativeMcpServerView,
  type NativeMcpTransport,
} from '../../shared/native-mcp.ts'
import { ChipInput, Switch, useUid } from '../agents/AgentFieldControls.tsx'

export type KvRow = { readonly id: number; readonly key: string; readonly value: string; /** A stored value exists for this key (never sent to the renderer). */ readonly stored: boolean; readonly changed: boolean; readonly hint?: string }
type Tri = '' | 'true' | 'false'
export type McpEditorState = {
  readonly mode: 'create' | 'edit'
  readonly origin: NativeMcpOrigin
  readonly name: string | null
  readonly newName: string
  readonly transport: Exclude<NativeMcpTransport, 'socket'>
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly url: string
  readonly keepUrlExtras: boolean
  readonly env: readonly KvRow[]
  readonly headers: readonly KvRow[]
  readonly lifecycle: string
  readonly auth: 'default' | 'oauth' | 'bearer' | 'none'
  readonly directTools: Tri | 'list'
  readonly idleTimeout: string
  readonly requestTimeoutMs: string
  readonly exposeResources: Tri
  readonly debug: Tri
  readonly includeTools: readonly string[]
  readonly excludeTools: readonly string[]
  readonly disabled: boolean
  readonly extraKeys: readonly string[]
  readonly warnings: readonly string[]
  readonly urlRedacted: boolean
  readonly socket?: string
}

let rowId = 0
const rows = (views: readonly NativeMcpKvView[]): KvRow[] => views.map((view) => ({ id: ++rowId, key: view.key, value: '', stored: true, changed: false, ...(view.kind === 'reference' ? { hint: '${' + view.ref + '}' } : view.kind === 'command' ? { hint: '!command' } : {}) }))
const tri = (value: boolean | undefined): Tri => value === undefined ? '' : value ? 'true' : 'false'

export function blankEditor(origin: NativeMcpOrigin): McpEditorState {
  return { mode: 'create', origin, name: null, newName: '', transport: 'stdio', command: '', args: [], cwd: '', url: '', keepUrlExtras: false, env: [], headers: [], lifecycle: '', auth: 'default', directTools: '', idleTimeout: '', requestTimeoutMs: '', exposeResources: '', debug: '', includeTools: [], excludeTools: [], disabled: false, extraKeys: [], warnings: [], urlRedacted: false }
}

export function editorFor(server: NativeMcpServerView): McpEditorState {
  return {
    mode: 'edit', origin: server.origin, name: server.name, newName: server.name,
    transport: server.transport === 'socket' ? 'override' : server.transport,
    command: server.command ?? '', args: server.args, cwd: server.cwd ?? '', url: server.url ?? '', keepUrlExtras: server.urlRedacted,
    env: rows(server.env), headers: rows(server.headers), lifecycle: server.lifecycle ?? '', auth: server.auth,
    directTools: server.directTools === 'list' ? 'list' : tri(server.directTools as boolean | undefined),
    idleTimeout: server.idleTimeout?.toString() ?? '', requestTimeoutMs: server.requestTimeoutMs?.toString() ?? '',
    exposeResources: tri(server.exposeResources), debug: tri(server.debug),
    includeTools: server.includeTools, excludeTools: server.excludeTools, disabled: server.disabled,
    extraKeys: server.extraKeys, warnings: server.warnings, urlRedacted: server.urlRedacted,
    ...(server.socket ? { socket: server.socket } : {}),
  }
}

export const snapshotOf = (editor: McpEditorState): string => JSON.stringify({ ...editor, env: editor.env.map(({ id: _id, ...row }) => row), headers: editor.headers.map(({ id: _id, ...row }) => row) })

function parseNumber(label: string, text: string): { value?: number; error?: string } {
  if (!text.trim()) return {}
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= 0 ? { value } : { error: `${label} must be a non-negative whole number.` }
}

/** Builds the save payload; secret rows that were not touched are sent without a value, so the stored value is kept by the backend. */
export function toConfigInput(editor: McpEditorState): { config?: NativeMcpConfigInput; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  if (!editor.newName.trim()) errors.name = 'Enter a server name.'
  if (editor.transport === 'stdio' && !editor.command.trim()) errors.command = 'A command is required.'
  if ((editor.transport === 'http' || editor.transport === 'sse') && !/^(https?:\/\/|\$\{|\$env:|\{env:)/.test(editor.url.trim())) errors.url = 'Enter a URL starting with http:// or https://.'
  const idle = parseNumber('Idle timeout', editor.idleTimeout); if (idle.error) errors.idleTimeout = idle.error
  const request = parseNumber('Request timeout', editor.requestTimeoutMs); if (request.error) errors.requestTimeoutMs = request.error
  const kv = (list: readonly KvRow[], label: string, field: string) => {
    const keys = new Set<string>()
    const out: { key: string; value?: string }[] = []
    for (const row of list) {
      const key = row.key.trim()
      if (!key) { errors[field] = `${label} names cannot be empty.`; continue }
      if (keys.has(key)) { errors[field] = `Duplicate ${label.toLowerCase()} "${key}".`; continue }
      keys.add(key)
      out.push(row.changed || !row.stored ? { key, value: row.value } : { key })
    }
    return out
  }
  const env = editor.transport === 'stdio' ? kv(editor.env, 'Environment variable', 'env') : undefined
  const headers = editor.transport === 'http' || editor.transport === 'sse' ? kv(editor.headers, 'Header', 'headers') : undefined
  if (Object.keys(errors).length) return { errors }
  const bool = (value: Tri): boolean | undefined => value === '' ? undefined : value === 'true'
  const direct = editor.directTools === 'list' ? 'keep' as const : bool(editor.directTools)
  const config: NativeMcpConfigInput = {
    transport: editor.transport,
    ...(editor.transport === 'stdio' ? { command: editor.command.trim(), args: editor.args, cwd: editor.cwd.trim(), ...(env ? { env } : {}) } : {}),
    ...(editor.transport === 'http' || editor.transport === 'sse' ? { url: editor.url.trim(), keepUrlExtras: editor.keepUrlExtras, auth: editor.auth, ...(headers ? { headers } : {}) } : {}),
    ...(editor.lifecycle ? { lifecycle: editor.lifecycle as NativeMcpConfigInput['lifecycle'] } : {}),
    ...(idle.value !== undefined ? { idleTimeout: idle.value } : {}),
    ...(request.value !== undefined ? { requestTimeoutMs: request.value } : {}),
    ...(bool(editor.exposeResources) !== undefined ? { exposeResources: bool(editor.exposeResources)! } : {}),
    ...(bool(editor.debug) !== undefined ? { debug: bool(editor.debug)! } : {}),
    ...(direct !== undefined ? { directTools: direct } : {}),
    includeTools: editor.includeTools, excludeTools: editor.excludeTools, disabled: editor.disabled,
  }
  return { config, errors }
}

function KvEditor({ label, rows: list, onChange, disabled, error, secret }: { label: string; rows: readonly KvRow[]; onChange: (next: readonly KvRow[]) => void; disabled: boolean; error?: string; secret: boolean }) {
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set())
  const patch = (id: number, change: Partial<KvRow>) => onChange(list.map((row) => row.id === id ? { ...row, ...change } : row))
  return <div className="mcp-kv">
    {list.map((row) => <div className="mcp-kv-row" key={row.id}>
      <input className="ad-input ad-mono" aria-label={`${label} name`} placeholder="NAME" value={row.key} disabled={disabled || row.stored} title={row.stored ? 'Remove and re-add the entry to rename it.' : undefined} onChange={(event) => patch(row.id, { key: event.target.value })} />
      <input className="ad-input ad-mono" aria-label={`${label} value for ${row.key || 'new entry'}`} autoComplete="off" spellCheck={false}
        type={secret && !revealed.has(row.id) ? 'password' : 'text'} disabled={disabled}
        placeholder={row.stored && !row.changed ? (row.hint ?? '•••••••• (stored, unchanged)') : 'value, ${ENV_VAR} or !command'}
        value={row.changed || !row.stored ? row.value : ''} onChange={(event) => patch(row.id, { value: event.target.value, changed: true })} />
      {secret && (row.changed || !row.stored) && <button type="button" className="ad-btn ad-btn-sm" disabled={disabled} onClick={() => setRevealed((current) => { const next = new Set(current); if (!next.delete(row.id)) next.add(row.id); return next })}>{revealed.has(row.id) ? 'Hide' : 'Show'}</button>}
      <button type="button" className="ad-btn ad-btn-sm" disabled={disabled} aria-label={`Remove ${row.key || 'entry'}`} onClick={() => onChange(list.filter((item) => item.id !== row.id))}>Remove</button>
    </div>)}
    <button type="button" className="ad-btn ad-btn-sm" disabled={disabled} onClick={() => onChange([...list, { id: ++rowId, key: '', value: '', stored: false, changed: true }])}>Add {label.toLowerCase()}</button>
    <p className="ad-help">Stored values are never shown. Leave an entry untouched to keep its value; type to replace it. Use <code>{'${NAME}'}</code> to reference a process environment variable instead of storing a secret in the file.</p>
    {error && <p className="ad-error" role="alert">{error}</p>}
  </div>
}

type Props = {
  editor: McpEditorState
  setEditor: (next: McpEditorState) => void
  originLabel: string
  filePath: string
  canWrite: boolean
  busy: boolean
  dirty: boolean
  fieldErrors: Record<string, string>
  error: string | null
  confirmDelete: boolean
  setConfirmDelete: (value: boolean) => void
  onSave: (event: FormEvent) => void
  onRevert: () => void
  onDelete: () => void
  onBack: () => void
}

export function McpServerEditor(p: Props) {
  const { editor, busy, fieldErrors } = p
  const uid = useUid('mcp')
  const locked = busy || !p.canWrite
  const set = (change: Partial<McpEditorState>) => p.setEditor({ ...editor, ...change })
  const triSelect = (id: string, value: Tri, onChange: (next: Tri) => void, labels: [string, string, string]) => <select id={id} className="ad-input" disabled={locked} value={value} onChange={(event) => onChange(event.target.value as Tri)}><option value="">{labels[0]}</option><option value="true">{labels[1]}</option><option value="false">{labels[2]}</option></select>
  const remote = editor.transport === 'http' || editor.transport === 'sse'
  return <form className="ad-editor" onSubmit={p.onSave} aria-label="MCP server editor">
    <div className="ad-editor-head">
      <button type="button" className="ad-btn ad-back" onClick={p.onBack}>Back</button>
      <div className="ad-editor-title">
        <h2>{editor.mode === 'create' ? 'New MCP server' : editor.name}{p.dirty && <span className="ad-dirty" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}</h2>
        <p className="ad-meta">{p.originLabel}</p>
        <p className="ad-path" title={p.filePath}>{p.filePath}</p>
      </div>
      <label className="mcp-enable"><span className="ad-label">Enabled</span><Switch checked={!editor.disabled} disabled={locked} label={editor.disabled ? 'Enable server' : 'Disable server'} onChange={(next) => set({ disabled: !next })} /></label>
    </div>
    <div className="ad-editor-body">
      {!p.canWrite && <p className="ad-banner ad-banner-warn">This source is read-only here. Edit the file directly or create an override in a writable source.</p>}
      {editor.warnings.map((warning) => <p className="ad-banner ad-banner-warn" key={warning}>{warning}</p>)}
      {p.error && <p className="ad-banner ad-banner-err" role="alert">{p.error}</p>}
      <fieldset className="ad-fieldset" disabled={locked}>
        <div className="ad-row">
          <div className="ad-field"><label htmlFor={`${uid}-name`}>Name</label><input id={`${uid}-name`} className="ad-input" value={editor.newName} aria-invalid={!!fieldErrors.name || undefined} onChange={(event) => set({ newName: event.target.value })} />{fieldErrors.name && <p className="ad-error" role="alert">{fieldErrors.name}</p>}</div>
          <div className="ad-field"><label htmlFor={`${uid}-transport`}>Transport</label>
            <select id={`${uid}-transport`} className="ad-input" value={editor.transport} onChange={(event) => set({ transport: event.target.value as McpEditorState['transport'] })}>
              <option value="stdio">stdio (local command)</option><option value="http">http (streamable HTTP)</option><option value="sse">sse (legacy HTTP+SSE)</option>
              {(editor.transport === 'override' || editor.socket) && <option value="override">override / partial entry</option>}
            </select>
            {editor.socket && <p className="ad-help">This entry uses an rmcp-mux socket (kept as is).</p>}
          </div>
        </div>
        {editor.transport === 'stdio' && <>
          <div className="ad-field"><label htmlFor={`${uid}-command`}>Command</label><input id={`${uid}-command`} className="ad-input ad-mono" value={editor.command} aria-invalid={!!fieldErrors.command || undefined} onChange={(event) => set({ command: event.target.value })} />{fieldErrors.command && <p className="ad-error" role="alert">{fieldErrors.command}</p>}</div>
          <div className="ad-field"><label htmlFor={`${uid}-args`}>Arguments</label><ChipInput id={`${uid}-args`} value={editor.args} disabled={locked} placeholder="Type an argument and press Enter" onChange={(args) => set({ args })} /></div>
          <div className="ad-field"><label htmlFor={`${uid}-cwd`}>Working directory</label><input id={`${uid}-cwd`} className="ad-input ad-mono" value={editor.cwd} onChange={(event) => set({ cwd: event.target.value })} /></div>
          <div className="ad-field"><span className="ad-label">Environment</span><KvEditor label="Variable" rows={editor.env} secret disabled={locked} error={fieldErrors.env} onChange={(env) => set({ env })} /></div>
        </>}
        {remote && <>
          <div className="ad-field"><label htmlFor={`${uid}-url`}>URL</label><input id={`${uid}-url`} className="ad-input ad-mono" value={editor.url} aria-invalid={!!fieldErrors.url || undefined} onChange={(event) => set({ url: event.target.value })} />
            {editor.urlRedacted && editor.keepUrlExtras && <p className="ad-help">The stored URL has credentials or a query string that are hidden here. They are kept unless you change the address.</p>}
            {fieldErrors.url && <p className="ad-error" role="alert">{fieldErrors.url}</p>}</div>
          <div className="ad-row">
            <div className="ad-field"><label htmlFor={`${uid}-auth`}>Authentication</label><select id={`${uid}-auth`} className="ad-input" value={editor.auth} onChange={(event) => set({ auth: event.target.value as McpEditorState['auth'] })}><option value="default">Adapter default (OAuth when no headers)</option><option value="oauth">OAuth</option><option value="bearer">Bearer token</option><option value="none">None</option></select><p className="ad-help">OAuth sign-in and bearer tokens are handled by Pi (<code>/mcp-auth</code>, <code>/mcp token</code>), not by this app.</p></div>
          </div>
          <div className="ad-field"><span className="ad-label">Headers</span><KvEditor label="Header" rows={editor.headers} secret disabled={locked} error={fieldErrors.headers} onChange={(headers) => set({ headers })} /></div>
        </>}
        <div className="ad-row">
          <div className="ad-field"><label htmlFor={`${uid}-lifecycle`}>Lifecycle</label><select id={`${uid}-lifecycle`} className="ad-input" value={editor.lifecycle} onChange={(event) => set({ lifecycle: event.target.value })}><option value="">Adapter default</option>{NATIVE_MCP_LIFECYCLES.map((item) => <option key={item} value={item}>{item}</option>)}</select></div>
          <div className="ad-field"><label htmlFor={`${uid}-direct`}>Direct tools</label>
            {editor.directTools === 'list' ? <p className="ad-help">A per-tool list is configured and is preserved as is.</p> : triSelect(`${uid}-direct`, editor.directTools as Tri, (directTools) => set({ directTools }), ['Adapter default', 'Register tools directly', 'Do not register directly'])}</div>
        </div>
        <details className="ad-more">
          <summary>More fields<span>{editor.extraKeys.length}</span></summary>
          <div className="ad-more-grid">
            <div className="ad-field"><label htmlFor={`${uid}-idle`}>Idle timeout (minutes)</label><input id={`${uid}-idle`} className="ad-input" inputMode="numeric" value={editor.idleTimeout} placeholder="default" onChange={(event) => set({ idleTimeout: event.target.value })} />{fieldErrors.idleTimeout && <p className="ad-error" role="alert">{fieldErrors.idleTimeout}</p>}</div>
            <div className="ad-field"><label htmlFor={`${uid}-req`}>Request timeout (ms)</label><input id={`${uid}-req`} className="ad-input" inputMode="numeric" value={editor.requestTimeoutMs} placeholder="default" onChange={(event) => set({ requestTimeoutMs: event.target.value })} />{fieldErrors.requestTimeoutMs && <p className="ad-error" role="alert">{fieldErrors.requestTimeoutMs}</p>}</div>
            <div className="ad-field"><label htmlFor={`${uid}-res`}>Expose resources</label>{triSelect(`${uid}-res`, editor.exposeResources, (exposeResources) => set({ exposeResources }), ['Adapter default', 'Yes', 'No'])}</div>
            <div className="ad-field"><label htmlFor={`${uid}-debug`}>Show server stderr</label>{triSelect(`${uid}-debug`, editor.debug, (debug) => set({ debug }), ['Adapter default', 'Yes', 'No'])}</div>
            <div className="ad-field"><label htmlFor={`${uid}-inc`}>Include tools</label><ChipInput id={`${uid}-inc`} value={editor.includeTools} disabled={locked} onChange={(includeTools) => set({ includeTools })} /></div>
            <div className="ad-field"><label htmlFor={`${uid}-exc`}>Exclude tools</label><ChipInput id={`${uid}-exc`} value={editor.excludeTools} disabled={locked} onChange={(excludeTools) => set({ excludeTools })} /></div>
          </div>
          <p className="ad-help">{editor.extraKeys.length ? <>Other keys kept untouched (values hidden, may hold credentials): <code>{editor.extraKeys.join(', ')}</code></> : 'No other keys in this entry. Unknown keys are preserved when you save.'}</p>
        </details>
      </fieldset>
    </div>
    <div className="ad-footer">
      {p.confirmDelete ? <div className="ad-footer-row"><span className="ad-confirm-text">Remove this server entry from {p.filePath}?</span><button type="button" className="ad-btn" onClick={() => p.setConfirmDelete(false)}>Cancel</button><button type="button" className="ad-btn ad-btn-danger" disabled={busy} onClick={p.onDelete}>Remove</button></div>
        : <div className="ad-footer-row">
          <span className="ad-footer-state">{p.dirty ? 'Unsaved changes' : 'No changes'}</span>
          {editor.mode === 'edit' && <button type="button" className="ad-btn ad-btn-danger" disabled={locked} onClick={() => p.setConfirmDelete(true)}>Remove</button>}
          <button type="button" className="ad-btn" disabled={busy || !p.dirty} onClick={p.onRevert}>Revert</button>
          <button type="submit" className="ad-btn ad-btn-primary" disabled={locked || !p.dirty}>{busy ? 'Saving…' : editor.mode === 'create' ? 'Add server' : 'Save'}</button>
        </div>}
    </div>
  </form>
}
