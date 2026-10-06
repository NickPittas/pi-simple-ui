import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { NativeConfigFile } from '../../shared/native-config.ts'
import './native-config.css'

type Props = { bridge?: DesktopBridge; scope?: RuntimeScope; group: 'pi' | 'extension'; title: string }
type Notice = { kind: 'info' | 'success' | 'warning' | 'error'; text: string; actions?: 'saved' | 'conflict' }
type Loaded = { text: string; revision: string; exists: boolean }

const NEW_FILE_TEXT = '{\n}\n'

function jsonError(text: string): string | null {
  try { JSON.parse(text); return null } catch (error) { return error instanceof Error ? error.message : 'Invalid JSON' }
}

export function NativeConfigPage({ bridge, scope, group, title }: Props) {
  const [files, setFiles] = useState<NativeConfigFile[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [text, setText] = useState('')
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const readSeq = useRef(0)
  const scopeKey = `${scope?.ownerId ?? ''}:${scope?.generation ?? ''}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const visible = useMemo(() => (files ?? []).filter((file) => file.group === group), [files, group])
  const selected = visible.find((file) => file.id === selectedId) ?? null
  const dirty = loaded !== null && text !== loaded.text
  const invalid = useMemo(() => (loaded ? jsonError(text) : null), [text, loaded])

  const loadFile = useCallback(async (id: string, keepNotice = false) => {
    const scope = scopeRef.current
    if (!bridge || !scope) return
    const seq = ++readSeq.current
    setReading(true); setReadError(null); if (!keepNotice) setNotice(null); setConfirmRestart(false); setPendingSwitch(null)
    const result = await bridge.invoke('native.config.read', { id }, scope)
    if (seq !== readSeq.current) return
    setReading(false)
    if (!result.ok) { setLoaded(null); setReadError(result.error.message); return }
    const value = result.value
    setLoaded({ text: value.text, revision: value.revision, exists: value.exists })
    setText(value.exists ? value.text : NEW_FILE_TEXT)
  }, [bridge])

  const loadList = useCallback(async () => {
    const scope = scopeRef.current
    if (!bridge || !scope) return
    setListError(null)
    const result = await bridge.invoke('native.config.list', {}, scope)
    if (!result.ok) { setFiles([]); setListError(result.error.message); return }
    setFiles(result.value.files)
  }, [bridge])

  // New runtime scope (e.g. after Pi restart): drop everything and re-list.
  useEffect(() => {
    readSeq.current++
    setFiles(null); setSelectedId(null); setLoaded(null); setText(''); setReadError(null); setPendingSwitch(null); setConfirmRestart(false); setSaving(false)
    if (bridge && scopeRef.current) void loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, scopeKey, loadList])  // loadList is stable per bridge; scope is read via scopeRef

  // Keep the restart outcome notice across the scope change by only clearing notices on user actions.
  useEffect(() => {
    if (files && !selectedId) {
      const first = files.find((file) => file.group === group)
      if (first) { setSelectedId(first.id); void loadFile(first.id, true) }
    }
  }, [files, selectedId, group, loadFile])

  const choose = (id: string) => {
    if (id === selectedId) return
    if (dirty) { setPendingSwitch(id); return }
    setSelectedId(id); void loadFile(id)
  }

  const save = async () => {
    const scope = scopeRef.current
    if (!bridge || !scope || !selected || !loaded || !dirty || invalid || saving) return
    setSaving(true); setNotice(null)
    const result = await bridge.invoke('native.config.write', { id: selected.id, text, expectedRevision: loaded.exists ? loaded.revision : '' }, scope)
    setSaving(false)
    if (!result.ok) { setNotice({ kind: 'error', text: result.error.message }); return }
    const { outcome, revision, reason } = result.value
    if (outcome === 'saved' && revision !== null) {
      setLoaded({ text, revision, exists: true })
      setNotice({ kind: 'success', text: 'Saved. Pi reads this file at startup.', actions: 'saved' })
      setFiles((current) => current?.map((file) => file.id === selected.id ? { ...file, exists: true } : file) ?? current)
    } else if (outcome === 'conflict') {
      setNotice({ kind: 'warning', text: 'This file changed on disk since you opened it.', actions: 'conflict' })
    } else {
      setNotice({ kind: 'error', text: reason ?? (outcome === 'invalid' ? 'The server rejected this content as invalid.' : 'The write was rejected.') })
    }
  }

  const restart = async () => {
    if (!bridge) return
    setRestarting(true)
    const result = await bridge.invoke('native.pi.restart', {})
    setRestarting(false); setConfirmRestart(false)
    if (!result.ok) { setNotice({ kind: 'error', text: result.error.message }); return }
    setNotice(result.value.outcome === 'restarted' ? { kind: 'success', text: 'Pi restarted with your new settings.' } : { kind: 'error', text: result.value.reason ?? 'Pi could not be restarted.' })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); return }
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const area = event.currentTarget
      const start = area.selectionStart, end = area.selectionEnd
      const next = `${text.slice(0, start)}  ${text.slice(end)}`
      setText(next)
      requestAnimationFrame(() => { area.selectionStart = area.selectionEnd = start + 2 })
    }
  }

  const renderGroup = (kind: 'user' | 'project', heading: string) => {
    const rows = visible.filter((file) => file.scope === kind)
    if (rows.length === 0) return null
    return <div className="ncfg-group" key={kind}><h2>{heading}</h2><div className="ncfg-rows">{rows.map((file) => <button type="button" key={file.id} className={`ncfg-row${file.id === selectedId ? ' ncfg-row-current' : ''}`} aria-current={file.id === selectedId ? 'true' : undefined} aria-pressed={file.id === selectedId} onClick={() => choose(file.id)}>
      <span className="ncfg-row-label">{file.label}</span>
      <span className="ncfg-row-path" title={file.path}>{file.path}</span>
      {(!file.exists || file.sensitive) && <span className="ncfg-badges">{!file.exists && <span className="ncfg-badge">missing</span>}{file.sensitive && <span className="ncfg-badge ncfg-badge-warn">may contain secrets</span>}</span>}
    </button>)}</div></div>
  }

  const disabled = !bridge || !scope
  const body = disabled
    ? <p className="ncfg-empty">Open a workspace to load Pi&apos;s configuration.</p>
    : files === null
      ? <p className="ncfg-empty" role="status">Loading configuration files…</p>
      : <div className="ncfg-layout">
        <nav className="ncfg-list" aria-label={`${title} files`}>
          {listError && <div className="ncfg-notice ncfg-error" role="alert"><span>{listError}</span><button type="button" onClick={() => void loadList()}>Retry</button></div>}
          {visible.length === 0 && !listError ? <p className="ncfg-empty">No configuration files found for this section.</p> : <>{renderGroup('user', 'User (~/.pi/agent)')}{renderGroup('project', 'Project (.pi in this workspace)')}</>}
        </nav>
        <section className="ncfg-editor" aria-label="Editor">
          {!selected ? <p className="ncfg-empty">Select a file to edit.</p> : <>
            {pendingSwitch && <div className="ncfg-notice ncfg-warning" role="status"><span>You have unsaved changes in this file.</span><button type="button" onClick={() => { const id = pendingSwitch; setPendingSwitch(null); setSelectedId(id); void loadFile(id) }}>Discard changes</button><button type="button" onClick={() => setPendingSwitch(null)}>Cancel</button></div>}
            {selected.sensitive && <div className="ncfg-notice ncfg-info" role="status">This file may contain API keys. It stays on this machine.</div>}
            {notice && <div className={`ncfg-notice ncfg-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.text}</span>
              {notice.actions === 'saved' && !confirmRestart && <button type="button" onClick={() => setConfirmRestart(true)}>Restart Pi session</button>}
              {notice.actions === 'conflict' && <><button type="button" onClick={() => void loadFile(selected.id)}>Reload (discard my edits)</button><button type="button" onClick={() => setNotice(null)}>Keep editing</button></>}
            </div>}
            {confirmRestart && <div className="ncfg-notice ncfg-warning" role="status"><span>Restart Pi now? Any reply in progress will be stopped. Your session continues from its saved history.</span><button type="button" disabled={restarting} onClick={() => void restart()}>Restart</button><button type="button" disabled={restarting} onClick={() => setConfirmRestart(false)}>Cancel</button></div>}
            <div className="ncfg-meta">
              <span className="ncfg-path" title={selected.path}>{selected.path}</span>
              <span className="ncfg-status">{loaded ? (!loaded.exists && !dirty ? 'New file' : dirty ? 'Unsaved changes' : loaded.exists ? 'Saved' : 'New file') : ''}</span>
              {loaded && (invalid ? <span className="ncfg-json ncfg-json-bad" title={invalid}>Invalid JSON: {invalid}</span> : <span className="ncfg-json ncfg-json-ok">Valid JSON</span>)}
            </div>
            {reading && <p className="ncfg-empty" role="status">Loading file…</p>}
            {readError && <div className="ncfg-notice ncfg-error" role="alert"><span>{readError}</span><button type="button" onClick={() => void loadFile(selected.id)}>Retry</button></div>}
            {loaded && !reading && <>
              <textarea className="ncfg-textarea" aria-label={`Edit ${selected.label}`} value={text} spellCheck={false} wrap="off" autoCapitalize="off" autoCorrect="off" onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} />
              <div className="ncfg-actions">
                <button type="button" className="ncfg-primary" disabled={!dirty || !!invalid || saving} onClick={() => void save()}>{saving ? 'Saving…' : loaded.exists ? 'Save' : 'Create file'}</button>
                <button type="button" disabled={!dirty || saving} onClick={() => setText(loaded.exists ? loaded.text : NEW_FILE_TEXT)}>Revert</button>
                <button type="button" disabled={saving} onClick={() => void loadFile(selected.id)}>Reload from disk</button>
              </div>
            </>}
          </>}
        </section>
      </div>
  return <section className="area-page ncfg-page" aria-label={title}>
    <div className="eyebrow"><span className="eyebrow-line" />PI DESKTOP</div>
    <h1>{title}</h1>
    <p className="area-lede">Edit Pi&apos;s own configuration files. Unknown keys and formatting are kept exactly as written.</p>
    {body}
  </section>
}
