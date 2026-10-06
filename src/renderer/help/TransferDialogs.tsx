import { useEffect, useRef, useState } from 'react'
import type { DesktopBridge, RuntimeScope } from '../../shared/ipc-contracts.ts'
import { TRANSFER_IPC, type TransferConsentPayload, type TransferExportFormat, type TransferShareDestinationDisclosure, type TransferShareEventPayload, type TransferShareProgressPhase } from '../../shared/transfer.ts'
import { useDialogA11y } from '../a11y/useDialogA11y.ts'

type Mode = 'export' | 'import' | 'share'
type PreparedExport = { preparationId: string; format: TransferExportFormat; targetPath: string; overwriteRequired: boolean; consent: TransferConsentPayload }
type PreparedShare = { preparationId: string; consent: TransferConsentPayload; shareAvailable: boolean; destinations: readonly TransferShareDestinationDisclosure[] }
type ActiveShareOperation = { readonly operationId: string; readonly sessionId: string; readonly scopeKey: string; readonly token: number }
const sharePhaseLabels: Record<TransferShareProgressPhase, string> = {
  'exporting-jsonl': 'Preparing the session export',
  'checking-radius-auth': 'Checking Radius authentication',
  'uploading-radius': 'Sharing with the Radius organization',
  'checking-github-auth': 'Checking GitHub CLI authentication',
  'exporting-html': 'Preparing the HTML export',
  'creating-gist': 'Creating an unlisted GitHub gist',
}
function scanRows(payload: TransferConsentPayload) {
  const scan = payload.secretScan
  return [['API key matches', scan.apiKeyMatches], ['Token matches', scan.tokenMatches], ['Private-key matches', scan.privateKeyMatches], ['System-prompt matches', scan.systemPromptMatches], ['Tool-schema matches', scan.toolSchemaMatches], ['Entry-metadata matches', scan.entryMetadataMatches], ['Unscanned messages', scan.unscannedMessageCount], ['Truncated text sections', scan.truncatedTextCount]] as const
}

function ConsentSummary({ consent }: { readonly consent: TransferConsentPayload }) {
  return <div className="help-consent-summary"><section><h3>Session summary</h3><p><strong>Session:</strong> {consent.sessionId}</p><p><strong>Messages:</strong> {consent.messageCounts.total} total · {consent.messageCounts.user} user · {consent.messageCounts.assistant} assistant · {consent.messageCounts.tool} tool</p></section>
    <section><h3>Attachment references</h3><p>{consent.attachmentReferenceCount} image reference(s){consent.omittedAttachmentReferenceCount ? ` · ${consent.omittedAttachmentReferenceCount} not listed` : ''}</p>{consent.attachmentReferences.length > 0 && <ul>{consent.attachmentReferences.map((item, index) => <li key={`${item.messageIndex}-${item.contentIndex}-${index}`}>Message {item.messageIndex} · content {item.contentIndex} · {item.mimeType} · {item.reference}</li>)}</ul>}</section>
    <section className="help-secret-scan"><h3>Secret-scan summary</h3><p>Counts only; detected values are never displayed.</p><dl>{scanRows(consent).map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl><p>{consent.secretScan.scannedMessageCount} of {consent.secretScan.messageCount} messages scanned.</p>{consent.secretScan.affectedMessageIndices.length > 0 && <p>Affected message indices: {consent.secretScan.affectedMessageIndices.join(', ')}{consent.secretScan.additionalAffectedMessageCount ? ` and ${consent.secretScan.additionalAffectedMessageCount} more` : ''}</p>}</section>
  </div>
}

export function TransferDialogs({ bridge, scope, openMode, initialFormat, onModeConsumed }: { readonly bridge?: DesktopBridge; readonly scope?: RuntimeScope; readonly openMode?: 'import' | 'export'; readonly initialFormat?: TransferExportFormat; readonly onModeConsumed?: () => void }) {
  const [mode, setMode] = useState<Mode | null>(null)
  const [format, setFormat] = useState<TransferExportFormat>('html')
  const [preparedExport, setPreparedExport] = useState<PreparedExport | null>(null)
  const [preparedShare, setPreparedShare] = useState<PreparedShare | null>(null)
  const preparedShareRef = useRef(preparedShare); preparedShareRef.current = preparedShare
  const [overwrite, setOverwrite] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [shareRunning, setShareRunning] = useState(false)
  const [sharePhase, setSharePhase] = useState<TransferShareProgressPhase | null>(null)
  const [shareTerminal, setShareTerminal] = useState<Extract<TransferShareEventPayload, { readonly type: 'share-terminal' }>['outcome'] | null>(null)
  const [cancelStatus, setCancelStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const shareUnsubscribe = useRef<(() => void) | null>(null)
  const shareOperation = useRef<ActiveShareOperation | null>(null)
  const operationToken = useRef(0)
  const scopeKey = scope ? `${scope.ownerId}:${scope.generation}` : 'no-runtime'
  const currentScopeKey = useRef(scopeKey); currentScopeKey.current = scopeKey
  const stopShareEvents = () => { operationToken.current += 1; shareOperation.current = null; shareUnsubscribe.current?.(); shareUnsubscribe.current = null }
  const close = () => { if (busy) return; stopShareEvents(); setShareRunning(false); setSharePhase(null); setShareTerminal(null); setMode(null); setPreparedExport(null); setPreparedShare(null); setOverwrite(false); setConfirmed(false); setError(null); if (openMode) onModeConsumed?.() }
  const finishShare = (message: string) => { stopShareEvents(); setBusy(false); setShareRunning(false); setSharePhase(null); setShareTerminal(null); setMode(null); setPreparedShare(null); setConfirmed(false); setResult(message); if (openMode) onModeConsumed?.() }
  const dialogKeyDown = useDialogA11y(dialogRef, close, !!mode)
  useEffect(() => { if (openMode) { setMode(openMode); if (openMode === 'export' && initialFormat) setFormat(initialFormat); setError(null); setPreparedExport(null); setPreparedShare(null) } }, [openMode, initialFormat])
  useEffect(() => () => {
    const active = shareOperation.current
    stopShareEvents()
    if (active && bridge && scope) void bridge.invoke(TRANSFER_IPC.shareCancel, { preparationId: active.operationId }, scope).catch(() => {})
  }, [bridge, scopeKey])
  const previousScopeKey = useRef(scopeKey)
  useEffect(() => {
    if (previousScopeKey.current === scopeKey) return
    previousScopeKey.current = scopeKey
    setPreparedShare(null); setShareRunning(false); setSharePhase(null); setShareTerminal(null); setCancelStatus(null)
    if (mode === 'share') { setMode(null); setConfirmed(false); setError('The active runtime changed. Reopen sharing to prepare a new operation.') }
  }, [scopeKey, mode])
  const beginExport = async () => {
    if (!bridge || !scope) { setError('The native host is unavailable.'); return }
    setBusy(true); setError(null)
    const response = await bridge.invoke(TRANSFER_IPC.export, { format }, scope)
    setBusy(false)
    if (!response.ok) { setError(response.error.message); return }
    if (response.value.status === 'cancelled') { close(); setResult('Export cancelled.'); return }
    if (response.value.status === 'failed') { setError(`Export could not be prepared: ${response.value.error}.`); return }
    setPreparedExport(response.value); setOverwrite(!response.value.overwriteRequired)
  }
  const confirmExport = async () => {
    if (!bridge || !scope || !preparedExport) return
    setBusy(true); setError(null)
    const response = await bridge.invoke(TRANSFER_IPC.exportConfirm, { preparationId: preparedExport.preparationId, confirmed: true, overwriteConfirmed: overwrite }, scope)
    setBusy(false)
    if (!response.ok) { setError(response.error.message); return }
    if (response.value.status === 'overwrite-required') { setPreparedExport({ ...preparedExport, preparationId: response.value.preparationId, targetPath: response.value.targetPath, consent: response.value.consent, overwriteRequired: true }); setOverwrite(false); return }
    if (response.value.status === 'exported') { setResult(`Export saved to ${response.value.targetPath}`); close(); return }
    if (response.value.status === 'cancelled') { setResult('Export cancelled.'); close(); return }
    setError(`Export failed: ${response.value.error}.`)
  }
  const importFile = async () => {
    if (!bridge || !scope) { setError('The native host is unavailable.'); return }
    setBusy(true); setError(null)
    const response = await bridge.invoke(TRANSFER_IPC.import, {}, scope)
    setBusy(false)
    if (!response.ok) setError(response.error.message)
    else if (response.value.status === 'imported') { setResult(`Session imported: ${response.value.sessionId}`); close() }
    else if (response.value.status === 'cancelled') close()
    else setError(response.value.status === 'invalid' ? `File could not be imported: ${response.value.error}.` : `Import failed: ${response.value.error}.`)
  }
  const beginShare = async () => {
    if (!bridge || !scope) { setError('The native host is unavailable.'); return }
    setBusy(true); setError(null); setSharePhase(null); setShareTerminal(null); setCancelStatus(null)
    const response = await bridge.invoke(TRANSFER_IPC.sharePrepare, {}, scope)
    setBusy(false)
    if (!response.ok) { setError(response.error.message); return }
    if (response.value.status === 'failed') { setError(`Share could not be prepared: ${response.value.error}.`); return }
    setPreparedShare({ preparationId: response.value.preparationId, consent: response.value.consent, shareAvailable: response.value.shareAvailable, destinations: [...response.value.destinations] }); setConfirmed(false)
  }
  const confirmShare = async () => {
    if (!bridge || !scope || !preparedShare) return
    setBusy(true); setShareRunning(true); setSharePhase(null); setShareTerminal(null); setCancelStatus(null); setError(null)
    stopShareEvents()
    const operation: ActiveShareOperation = { operationId: preparedShare.preparationId, sessionId: preparedShare.consent.sessionId, scopeKey, token: operationToken.current }
    shareOperation.current = operation
    const subscription = await bridge.subscribe(TRANSFER_IPC.shareEvents, scope, (event: TransferShareEventPayload) => {
      const currentPreparation = preparedShareRef.current
      if (shareOperation.current !== operation || operation.token !== operationToken.current || operation.scopeKey !== currentScopeKey.current || !currentPreparation || currentPreparation.preparationId !== operation.operationId || currentPreparation.consent.sessionId !== operation.sessionId || event.operationId !== operation.operationId) return
      if (event.type === 'share-progress') setSharePhase(event.phase)
      else {
        setShareTerminal(event.outcome)
        setShareRunning(false)
        shareUnsubscribe.current?.(); shareUnsubscribe.current = null
      }
    })
    if (shareOperation.current !== operation || operation.scopeKey !== currentScopeKey.current) {
      if (subscription.ok) subscription.value()
      setBusy(false); setShareRunning(false)
      return
    }
    if (!subscription.ok) {
      shareOperation.current = null
      setBusy(false); setShareRunning(false)
      setError(`Could not subscribe to native sharing progress: ${subscription.error.message}. The share was not started.`)
      return
    }
    shareUnsubscribe.current = subscription.value
    let response
    try { response = await bridge.invoke(TRANSFER_IPC.shareConfirm, { preparationId: preparedShare.preparationId, confirmed: true }, scope) }
    catch (cause) { setBusy(false); setShareRunning(false); stopShareEvents(); setError(cause instanceof Error ? cause.message : 'The native share result could not be received.'); return }
    setBusy(false); setShareRunning(false)
    stopShareEvents()
    if (!response.ok) { setShareTerminal(null); setError(response.error.message) }
    else if (response.value.status === 'unavailable') { setShareTerminal(null); setError('Native sharing is unavailable because the host share operation is not connected. No upload was attempted.') }
    else if (response.value.status === 'cancelled') finishShare('Sharing cancelled by the native operation.')
    else if (response.value.status === 'shared') finishShare(response.value.destination === 'radius-organization' ? 'Shared with the Radius organization.' : 'Shared as an unlisted GitHub gist. Anyone with its URL can view it.')
    else { setShareTerminal(null); setError(`Sharing failed${response.value.phase ? ` during ${response.value.phase}` : ''}: ${response.value.message ?? response.value.error}.`) }
  }
  const cancelShare = async () => {
    if (!bridge || !scope || !preparedShare || !shareRunning) return
    setCancelStatus('Requesting cancellation from the native share operation…')
    const response = await bridge.invoke(TRANSFER_IPC.shareCancel, { preparationId: preparedShare.preparationId }, scope)
    if (!response.ok) { setError(response.error.message); return }
    setCancelStatus(response.value.status === 'cancellation-requested' ? 'Cancellation requested; waiting for the native operation to settle.' : `Cancellation could not be requested: ${response.value.error}.`)
  }
  return <section className="help-transfer-tools" aria-label="Session transfer actions">
    <h2>Move or share a session</h2><p>Transfers are prepared by the native host. Review the summary and secret-scan counts before confirming.</p>
    <div className="help-transfer-actions"><button type="button" onClick={() => { setMode('export'); setError(null); setPreparedExport(null) }}>Export session</button><button type="button" onClick={() => { setMode('import'); setError(null) }}>Import session…</button><button type="button" onClick={() => { setMode('share'); setError(null); setPreparedShare(null); setConfirmed(false) }}>Prepare share</button></div>
    {result && <p role="status" className="help-result">{result}</p>}
    {mode && <div className="help-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><div className="help-dialog" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="transfer-dialog-title" ref={dialogRef} onKeyDown={dialogKeyDown}>
      <header><div><span className="help-kicker">SESSION TRANSFER</span><h2 id="transfer-dialog-title">{mode === 'export' ? 'Export session' : mode === 'import' ? 'Import session' : 'Share session'}</h2></div><button type="button" aria-label="Close dialog" disabled={busy} onClick={close}>×</button></header>
      {mode === 'export' && !preparedExport && <div className="help-dialog-content"><label>Export format<select value={format} onChange={(event) => setFormat(event.target.value as TransferExportFormat)}><option value="html">HTML</option><option value="jsonl">JSONL</option></select></label><p>The native save dialog will choose the destination. Nothing is written until you review and confirm.</p><button type="button" className="help-primary" disabled={busy} onClick={() => void beginExport()}>{busy ? 'Preparing…' : 'Choose destination'}</button></div>}
      {preparedExport && <div className="help-dialog-content"><p><strong>Destination:</strong> <code>{preparedExport.targetPath}</code></p><ConsentSummary consent={preparedExport.consent}/>{preparedExport.overwriteRequired && <label className="help-confirm-check"><input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)}/>Replace the existing file at this destination.</label>}<div className="help-dialog-actions"><button type="button" disabled={busy} onClick={close}>Cancel export</button><button type="button" className="help-primary" disabled={busy || !overwrite} onClick={() => void confirmExport()}>{busy ? 'Saving…' : 'Confirm export'}</button></div></div>}
       {mode === 'share' && !preparedShare && <div className="help-dialog-content"><p>Review the native destinations and secret scan first. The host chooses Radius organization sharing when authenticated; otherwise it may use an unlisted GitHub gist. Nothing uploads before explicit confirmation.</p><button type="button" className="help-primary" disabled={busy} onClick={() => void beginShare()}>{busy ? 'Preparing…' : 'Review sharing options'}</button></div>}
        {preparedShare && <div className="help-dialog-content"><p className="help-warning"><strong>Possible destinations:</strong></p><ul>{preparedShare.destinations.map((destination) => <li key={destination.destination}>{destination.destination === 'radius-organization' ? 'Radius organization · visible to organization members · requires Radius authentication.' : 'Unlisted GitHub gist · visible to anyone with the URL · requires GitHub CLI authentication.'}</li>)}</ul>{!preparedShare.shareAvailable && <p role="status">Native share operation is not connected in this host build. Confirmation will not upload.</p>}{shareRunning && <p role="status" aria-live="polite">{sharePhase ? sharePhaseLabels[sharePhase] : 'Starting native share operation…'}</p>}{shareTerminal && <p role="status" aria-live="polite">Native operation reported terminal outcome: {shareTerminal}. Waiting for its final response.</p>}{cancelStatus && <p role="status">{cancelStatus}</p>}<ConsentSummary consent={preparedShare.consent}/><label className="help-confirm-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)}/>I reviewed the possible destinations, session summary, and secret-scan counts.</label><div className="help-dialog-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button>{shareRunning && <button type="button" onClick={() => void cancelShare()}>Request cancellation</button>}<button type="button" className="help-primary" disabled={busy || !confirmed} onClick={() => void confirmShare()}>{busy ? 'Working…' : preparedShare.shareAvailable ? 'Confirm share' : 'Continue (no upload available)'}</button></div></div>}
      {mode === 'import' && <div className="help-dialog-content"><p>The native file picker opens automatically. Choose a supported session export to import it.</p><button type="button" className="help-primary" disabled={busy} onClick={() => void importFile()}>{busy ? 'Importing…' : 'Choose session file'}</button></div>}
      {error && <p role="alert" className="help-dialog-error">{error}</p>}
    </div></div>}
  </section>
}
