import { createReadStream, type Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent'
import type {
  SessionHistoryEntry,
  SessionLeafInfo,
  SessionRecoveryDiagnostic,
  SessionSnapshot,
  SessionsHistoryResponse,
} from '../../shared/sessions.ts'
import { toSessionContentParts, toSessionJson } from '../pi/session-events.ts'

const MAX_HISTORY_PAGE = 100
const MAX_HISTORY_OFFSET = 1_000_000
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/

export interface SessionStoreContext {
  readonly cwd: string
  readonly sessionDir: string
}

export interface SessionRecoveryReport {
  readonly sessions: readonly SessionSnapshot[]
  readonly diagnostics: readonly SessionRecoveryDiagnostic[]
}

export interface SessionStartupRecovery extends SessionRecoveryReport {
  readonly sessionManager: SessionManager | null
}

interface RecoveredSession {
  readonly manager: SessionManager
  readonly snapshot: SessionSnapshot
  readonly modifiedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNativeEntry(value: unknown, header: boolean): boolean {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.id !== 'string') return false
  if (header) {
    return value.type === 'session'
      && SESSION_ID_PATTERN.test(value.id)
      && typeof value.timestamp === 'string'
      && Number.isFinite(Date.parse(value.timestamp))
  }
  return value.type !== 'session'
    && (value.parentId === null || typeof value.parentId === 'string')
    && typeof value.timestamp === 'string'
}

async function inspectJsonlFile(path: string): Promise<'valid' | 'invalid-jsonl' | 'invalid-session' | 'unreadable'> {
  let input: ReturnType<typeof createReadStream>
  try {
    input = createReadStream(path, { encoding: 'utf8' })
  } catch {
    return 'unreadable'
  }
  let firstEntry = true
  let hasHeader = false
  try {
    const lines = createInterface({ input, crlfDelay: Infinity })
    for await (const line of lines) {
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return 'invalid-jsonl'
      }
      if (!isNativeEntry(parsed, firstEntry)) return 'invalid-session'
      if (firstEntry) hasHeader = true
      firstEntry = false
    }
  } catch {
    return 'unreadable'
  }
  return hasHeader ? 'valid' : 'invalid-session'
}

export async function inspectNativeSessionFile(
  path: string,
): Promise<'valid' | 'invalid-jsonl' | 'invalid-session' | 'unreadable'> {
  return inspectJsonlFile(path)
}

async function sessionFiles(sessionDir: string): Promise<{
  readonly files: readonly { readonly path: string; readonly entry: Dirent }[]
  readonly unreadable: boolean
}> {
  try {
    const entries = await readdir(sessionDir, { withFileTypes: true })
    return {
      files: entries
        .filter((entry) => entry.name.toLowerCase().endsWith('.jsonl'))
        .map((entry) => ({ path: join(sessionDir, entry.name), entry }))
        .sort((left, right) => left.entry.name.localeCompare(right.entry.name)),
      unreadable: false,
    }
  } catch (error) {
    return {
      files: [],
      unreadable: (error as NodeJS.ErrnoException).code !== 'ENOENT',
    }
  }
}

function leafInfo(manager: SessionManager): SessionLeafInfo | null {
  const leafId = manager.getLeafId()
  if (!leafId) return null
  const leaf = manager.getLeafEntry()
  if (!leaf) return null
  const label = manager.getLabel(leafId)
  return {
    id: leafId,
    type: leaf.type,
    timestamp: leaf.timestamp,
    ...(label ? { label } : {}),
  }
}

function snapshot(manager: SessionManager, createdAt: string): SessionSnapshot {
  const name = manager.getSessionName()
  return {
    id: manager.getSessionId(),
    ...(name ? { name } : {}),
    cwd: manager.getCwd(),
    createdAt,
    messageCount: manager.getEntries().filter((entry) => entry.type === 'message').length,
    activeLeaf: leafInfo(manager),
  }
}

function validPageNumber(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new TypeError('The session history page is invalid.')
  }
  return value
}

function contentFromEntry(entry: SessionEntry) {
  const raw = entry as unknown as Record<string, unknown>
  let content: unknown
  if (entry.type === 'message' || entry.type === 'custom_message') {
    const message = entry.type === 'message' ? raw.message : raw
    content = isRecord(message) ? message.content : undefined
  }
  if (content === undefined) return undefined
  return toSessionContentParts(content)
}

function historyItem(entry: SessionEntry, manager: SessionManager): SessionHistoryEntry {
  const base = {
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    timestamp: entry.timestamp,
  }
  const label = manager.getLabel(entry.id)
  const content = contentFromEntry(entry)
  const record = entry as unknown as Record<string, unknown>
  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    return {
      ...base,
      ...(label ? { label } : {}),
      summary: entry.summary.slice(0, 8192),
      data: toSessionJson(record.details ?? null),
    }
  }
  return {
    ...base,
    ...(label ? { label } : {}),
    ...(content ? { content } : {}),
    ...(entry.type !== 'message' && entry.type !== 'custom_message' ? { data: toSessionJson(record) } : {}),
  }
}

/** Native JSONL files and SessionManager remain the only source of conversation history. */
export class SessionStore {
  async recover(context: SessionStoreContext): Promise<SessionRecoveryReport> {
    const recovered = await this.recoverManagers(context)
    return {
      sessions: recovered.sessions.map((item) => item.snapshot),
      diagnostics: recovered.diagnostics,
    }
  }

  /** Reuse a valid persisted session for root startup; malformed candidates are skipped. */
  async recoverStartup(context: SessionStoreContext): Promise<SessionStartupRecovery> {
    const recovered = await this.recoverManagers(context)
    const newest = recovered.sessions.slice().sort((left, right) => right.modifiedAt - left.modifiedAt)[0]
    return {
      sessions: recovered.sessions.map((item) => item.snapshot),
      diagnostics: recovered.diagnostics,
      sessionManager: newest?.manager ?? null,
    }
  }

  async history(
    context: SessionStoreContext,
    sessionId: string,
    offsetValue?: number,
    limitValue?: number,
  ): Promise<SessionsHistoryResponse> {
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new TypeError('The session ID is invalid.')
    const offset = validPageNumber(offsetValue, 0, MAX_HISTORY_OFFSET)
    const limit = validPageNumber(limitValue, 50, MAX_HISTORY_PAGE)
    if (limit === 0) throw new TypeError('The session history page size is invalid.')
    const manager = await this.open(sessionId, context)
    const branch = manager.getBranch()
    const entries = branch.slice(offset, offset + limit).map((entry) => historyItem(entry, manager))
    const nextOffset = offset + entries.length < branch.length ? offset + entries.length : null
    return {
      sessionId,
      offset,
      limit,
      entries,
      nextOffset,
      activeLeaf: leafInfo(manager),
    }
  }

  async open(sessionId: string, context: SessionStoreContext): Promise<SessionManager> {
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new TypeError('The session ID is invalid.')
    const file = SessionManager.findById(context.cwd, sessionId, context.sessionDir)
    if (!file) throw new Error('The requested session was not found.')
    const inspection = await inspectJsonlFile(file)
    if (inspection !== 'valid') throw new Error('The requested session is corrupt or unreadable.')
    const manager = SessionManager.open(file, context.sessionDir)
    if (manager.getSessionId() !== sessionId || !manager.getHeader()) {
      throw new Error('The requested session is invalid.')
    }
    return manager
  }

  private async recoverManagers(context: SessionStoreContext): Promise<{
    readonly sessions: readonly RecoveredSession[]
    readonly diagnostics: readonly SessionRecoveryDiagnostic[]
  }> {
    const { files, unreadable } = await sessionFiles(context.sessionDir)
    const sessions: RecoveredSession[] = []
    const diagnostics: SessionRecoveryDiagnostic[] = []
    if (unreadable) diagnostics.push({ file: basename(context.sessionDir), reason: 'unreadable' })

    let listedPaths = new Set<string>()
    try {
      const nativeSessions = await SessionManager.list(context.cwd, context.sessionDir)
      listedPaths = new Set(nativeSessions.map((session) => resolve(session.path)))
    } catch {
      diagnostics.push({ file: basename(context.sessionDir), reason: 'unreadable' })
    }

    for (const file of files) {
      const fileName = basename(file.path)
      if (!file.entry.isFile()) {
        diagnostics.push({ file: fileName, reason: 'unreadable' })
        continue
      }
      const inspection = await inspectJsonlFile(file.path)
      if (inspection !== 'valid') {
        diagnostics.push({ file: fileName, reason: inspection })
        continue
      }
      if (!listedPaths.has(resolve(file.path))) {
        diagnostics.push({ file: fileName, reason: 'invalid-session' })
        continue
      }
      try {
        const manager = SessionManager.open(file.path, context.sessionDir)
        const header = manager.getHeader()
        if (!header
          || manager.getSessionId() !== header.id
          || resolve(manager.getSessionFile() ?? '') !== resolve(file.path)) {
          diagnostics.push({ file: fileName, reason: 'invalid-session' })
          continue
        }
        const details = await stat(file.path)
        sessions.push({
          manager,
          snapshot: snapshot(manager, header.timestamp),
          modifiedAt: details.mtimeMs,
        })
      } catch {
        diagnostics.push({ file: fileName, reason: 'invalid-session' })
      }
    }
    sessions.sort((left, right) => right.modifiedAt - left.modifiedAt)
    diagnostics.sort((left, right) => left.file.localeCompare(right.file))
    return { sessions, diagnostics }
  }
}
