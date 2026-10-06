import { writeFileSync } from 'node:fs'
import type { SaveDialogOptions } from 'electron'
import type { AppPreferencesStore } from '../config/app-preferences.ts'
import type { NativeSettingsService } from '../config/native-settings-service.ts'
import type { WorkspaceService } from '../workspaces/workspace-service.ts'
import {
  DIAGNOSTIC_SUBSYSTEMS,
  type DiagnosticLevel,
  type DiagnosticLogEntry,
  type DiagnosticSubsystem,
  type DiagnosticsConfigSnapshot,
  type DiagnosticsExportResult,
  type DiagnosticsSnapshot,
  type DiagnosticsTrustSnapshot,
} from '../../shared/diagnostics.ts'
import type { TraceRetentionDays } from '../../shared/app-preferences.ts'
import { redactDiagnosticString, redactDiagnosticValue, type DiagnosticJsonValue } from './redaction.ts'

const MAX_RING_ENTRIES = 500
const MAX_ENTRY_BYTES = 12 * 1024
const MAX_CONFIG_FIELDS = 1_000
const RETENTION_VALUES: readonly TraceRetentionDays[] = [0, 1, 7, 30, 90]
const SENSITIVE_SETTING_NAME = /(?:key|token|secret|password|authorization|credential)/i

export interface DiagnosticSaveDialogResult {
  readonly canceled: boolean
  readonly filePath?: string
}

export interface DiagnosticSaveDialog {
  showSaveDialog(options: SaveDialogOptions): Promise<DiagnosticSaveDialogResult>
}

export interface DiagnosticLogServiceOptions {
  readonly preferences: Pick<AppPreferencesStore, 'read'>
  /** WorkspaceService.list() reads trust entries from ProjectTrustStore every time it builds a snapshot. */
  readonly workspaces: Pick<WorkspaceService, 'list'>
  /** NativeSettingsService.read() reports effective provenance from the active SettingsManager. */
  readonly settings: Pick<NativeSettingsService, 'read'>
  readonly saveDialog: DiagnosticSaveDialog
  readonly now?: () => number
}

function isRetentionDays(value: unknown): value is TraceRetentionDays {
  return typeof value === 'number' && RETENTION_VALUES.includes(value as TraceRetentionDays)
}

function safeTimestamp(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now()
}

function isSubsystem(value: string): value is DiagnosticSubsystem {
  return DIAGNOSTIC_SUBSYSTEMS.includes(value as DiagnosticSubsystem)
}

/** Bounded, redacting in-memory diagnostic log plus truthful runtime summaries and export. */
export class DiagnosticLogService {
  private readonly preferences: DiagnosticLogServiceOptions['preferences']
  private readonly workspaces: DiagnosticLogServiceOptions['workspaces']
  private readonly settings: DiagnosticLogServiceOptions['settings']
  private readonly saveDialog: DiagnosticSaveDialog
  private readonly now: () => number
  private entries: DiagnosticLogEntry[] = []

  constructor(options: DiagnosticLogServiceOptions) {
    this.preferences = options.preferences
    this.workspaces = options.workspaces
    this.settings = options.settings
    this.saveDialog = options.saveDialog
    this.now = options.now ?? Date.now
  }

  debug(subsystem: DiagnosticSubsystem, message: string, details?: unknown): void {
    this.record('debug', subsystem, message, details)
  }

  info(subsystem: DiagnosticSubsystem, message: string, details?: unknown): void {
    this.record('info', subsystem, message, details)
  }

  warn(subsystem: DiagnosticSubsystem, message: string, details?: unknown): void {
    this.record('warn', subsystem, message, details)
  }

  error(subsystem: DiagnosticSubsystem, message: string, details?: unknown): void {
    this.record('error', subsystem, message, details)
  }

  async read(): Promise<DiagnosticsSnapshot> {
    const retentionDays = this.readRetentionDays()
    const entries = this.retainedEntries(retentionDays)
    const trust = await this.readTrust()
    const config = this.readConfig(trust)
    return {
      generatedAt: safeTimestamp(this.now()),
      retentionDays,
      entries,
      trust,
      config,
    }
  }

  async trust(): Promise<DiagnosticsTrustSnapshot> {
    return this.readTrust()
  }

  async export(): Promise<DiagnosticsExportResult> {
    let selection: DiagnosticSaveDialogResult
    try {
      selection = await this.saveDialog.showSaveDialog({
        title: 'Export diagnostics',
        defaultPath: 'pi-diagnostics.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
    } catch {
      return { outcome: 'failed' }
    }
    if (selection.canceled) return { outcome: 'cancelled' }
    if (!selection.filePath || selection.filePath.includes('\0')) return { outcome: 'failed' }

    try {
      const snapshot = await this.read()
      const safeSnapshot = redactDiagnosticValue(snapshot)
      const text = `${JSON.stringify(safeSnapshot, null, 2)}\n`
      if (Buffer.byteLength(text, 'utf8') > MAX_RING_ENTRIES * MAX_ENTRY_BYTES) return { outcome: 'failed' }
      writeFileSync(selection.filePath, text, { encoding: 'utf8', mode: 0o600 })
      this.info('logging', 'Diagnostic export completed')
      return { outcome: 'saved' }
    } catch {
      // Filesystem errors can include user paths; never copy them into logs or IPC results.
      return { outcome: 'failed' }
    }
  }

  private record(level: DiagnosticLevel, subsystem: DiagnosticSubsystem, message: string, details?: unknown): void {
    const retentionDays = this.readRetentionDays()
    if (retentionDays === 0) {
      this.entries = []
      return
    }

    const timestamp = safeTimestamp(this.now())
    this.entries = this.retainedEntries(retentionDays, timestamp)
    const safeMessage = redactDiagnosticString(message, { maxStringLength: 4_096 })
    const safeSubsystem = isSubsystem(subsystem) ? subsystem : 'app'
    let safeDetails: DiagnosticJsonValue | undefined
    if (details !== undefined) {
      const sanitized = redactDiagnosticValue(details, {
        maxStringLength: 2_048,
        maxDepth: 6,
        maxCollectionEntries: 50,
      })
      const encoded = JSON.stringify(sanitized)
      safeDetails = Buffer.byteLength(encoded, 'utf8') <= MAX_ENTRY_BYTES / 2
        ? sanitized
        : '[details omitted: size limit]'
    }

    const entry: DiagnosticLogEntry = {
      timestamp,
      level,
      subsystem: safeSubsystem,
      message: safeMessage,
      ...(safeDetails === undefined ? {} : { details: safeDetails }),
    }
    this.entries.push(entry)
    if (this.entries.length > MAX_RING_ENTRIES) this.entries.splice(0, this.entries.length - MAX_RING_ENTRIES)
  }

  private readRetentionDays(): TraceRetentionDays {
    try {
      const value = this.preferences.read().preferences.privacy.traceRetentionDays
      return isRetentionDays(value) ? value : 0
    } catch {
      // Missing/unreadable privacy preferences fail closed: retain no diagnostic data.
      return 0
    }
  }

  private retainedEntries(retentionDays: TraceRetentionDays, now = safeTimestamp(this.now())): DiagnosticLogEntry[] {
    if (retentionDays === 0) {
      this.entries = []
      return []
    }
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
    this.entries = this.entries
      .filter((entry) => entry.timestamp >= cutoff && entry.timestamp <= now + 60_000)
      .slice(-MAX_RING_ENTRIES)
    return [...this.entries]
  }

  private async readTrust(): Promise<DiagnosticsTrustSnapshot> {
    try {
      const snapshot = await this.workspaces.list()
      return {
        status: 'available',
        source: 'pi-project-trust-store',
        workspaces: snapshot.workspaces.slice(0, 50).map((workspace) => ({
          workspaceId: workspace.id,
          path: redactDiagnosticString(workspace.path, { maxStringLength: 4_096 }),
          workspaceStatus: workspace.status,
          active: workspace.id === snapshot.activeWorkspaceId,
          decision: workspace.trust.decision,
          sourcePath: workspace.trust.sourcePath === null
            ? null
            : redactDiagnosticString(workspace.trust.sourcePath, { maxStringLength: 4_096 }),
          inherited: workspace.trust.inherited,
          requiresReapproval: workspace.trust.requiresReapproval,
        })),
      }
    } catch {
      return { status: 'unavailable', source: 'pi-project-trust-store', workspaces: [] }
    }
  }

  private readConfig(trust: DiagnosticsTrustSnapshot): DiagnosticsConfigSnapshot {
    const activeWorkspaceTrusted = trust.status === 'available'
      && trust.workspaces.some((workspace) => workspace.active && workspace.decision === 'trusted')
    const scope = activeWorkspaceTrusted ? 'project' : 'user'
    try {
      const response = this.settings.read(scope)
      return {
        status: 'available',
        scope,
        fields: response.fields
          .filter((field) => !SENSITIVE_SETTING_NAME.test(field.key))
          .slice(0, MAX_CONFIG_FIELDS)
          .map((field) => ({
            setting: redactDiagnosticString(field.key, { maxStringLength: 256 }),
            source: field.provenance,
          })),
      }
    } catch {
      return { status: 'unavailable', scope, fields: [] }
    }
  }
}

/** Installs a non-interfering fatal-exception observer; Node retains its normal crash behavior. */
export function installGlobalHandlers(log: DiagnosticLogService): () => void {
  const onUncaughtException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
    log.error('startup', 'Uncaught main-process exception', { origin, error })
  }
  process.on('uncaughtExceptionMonitor', onUncaughtException)
  return () => process.off('uncaughtExceptionMonitor', onUncaughtException)
}
