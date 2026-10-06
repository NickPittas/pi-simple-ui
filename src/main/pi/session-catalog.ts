// Read-only catalog of saved Pi sessions for one workspace. Mirrors Pi's SessionManager.list (session-manager.js
// buildSessionInfo / getDefaultSessionDirPath) without importing Pi. Never writes to session files or ~/.pi.
import { createReadStream } from 'node:fs'
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { NativeSessionSummary, NativeSessionsResult } from '../../shared/native-pi.ts'

const MAX_SESSIONS = 200
const MAX_HEADER_BYTES = 64 * 1024
const MAX_LINE_CHARS = 1024 * 1024
const MAX_SCAN_BYTES = 64 * 1024 * 1024
const MAX_FIRST_MESSAGE = 200
const MAX_NAME = 200
const CONCURRENCY = 4

type DirResolution = { dir: string; error: null } | { dir: null; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function expandTilde(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

async function readSessionDirSetting(path: string): Promise<string | null> {
  let text: string
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return null
    text = await readFile(path, 'utf8')
  } catch { return null }
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) && typeof parsed.sessionDir === 'string' && parsed.sessionDir ? parsed.sessionDir : null
  } catch { return null }
}

// Pi: default per-cwd dir = <agentDir>/sessions/--<cwd sans leading slash, [/\\:] -> '-'>--  (session-manager.js getDefaultSessionDirPath).
// Pi lets a sessionDir (CLI flag, PI_CODING_AGENT_SESSION_DIR, project/global settings) replace that per-cwd dir with a flat shared dir
// filtered by header cwd. Only the default layout is supported here; any override yields an explicit error instead of a guess.
export async function resolveWorkspaceSessionDir(cwd: string): Promise<DirResolution> {
  const resolvedCwd = resolve(cwd)
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ? expandTilde(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent'))
  if (process.env.PI_CODING_AGENT_SESSION_DIR) {
    return { dir: null, error: 'Session listing supports only the default Pi session directory; PI_CODING_AGENT_SESSION_DIR is set.' }
  }
  const override = (await readSessionDirSetting(join(resolvedCwd, '.pi', 'settings.json'))) ?? (await readSessionDirSetting(join(agentDir, 'settings.json')))
  if (override !== null) {
    return { dir: null, error: 'Session listing supports only the default Pi session directory; a sessionDir setting is configured in Pi settings.' }
  }
  const safe = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return { dir: join(agentDir, 'sessions', safe), error: null }
}

async function canonical(path: string): Promise<string> {
  try { return await realpath(path) } catch { return resolve(path) }
}

// True only when `file` is an absolute existing regular .jsonl file whose real parent equals the real per-cwd session dir.
export async function validateWorkspaceSessionFile(cwd: string, file: string): Promise<string | null> {
  if (typeof file !== 'string' || file.length === 0 || file.length > 4096 || file.includes('\0')) return 'The session file path is invalid.'
  if (!isAbsolute(file)) return 'The session file path must be absolute.'
  if (!file.endsWith('.jsonl')) return 'The session file must be a .jsonl file.'
  const resolution = await resolveWorkspaceSessionDir(cwd)
  if (resolution.error !== null) return resolution.error
  try {
    const [realDir, realFile] = await Promise.all([realpath(resolution.dir), realpath(file)])
    if (resolve(realFile, '..') !== realDir) return 'The session file is not in the active workspace session directory.'
    if (!(await stat(realFile)).isFile()) return 'The session file is not a regular file.'
  } catch {
    return 'The session file does not exist in the active workspace session directory.'
  }
  return null
}

async function readHeader(path: string): Promise<Record<string, unknown> | null> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
    const end = newline >= 0 ? newline : bytesRead < buffer.length ? bytesRead : -1
    if (end < 0) return null
    const value: unknown = JSON.parse(buffer.subarray(0, end).toString('utf8'))
    return isRecord(value) && value.type === 'session' && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256 ? value : null
  } catch { return null } finally { await handle.close() }
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string).join(' ')
}

type Scan = { messageCount: number; firstMessage: string; name: string | null; lastActivity: number | null }

async function scanFile(path: string): Promise<Scan> {
  const scan: Scan = { messageCount: 0, firstMessage: '', name: null, lastActivity: null }
  const decoder = new StringDecoder('utf8')
  let current = ''
  let overflow = false
  let sawHeader = false

  const handleLine = (line: string, tooLong: boolean): void => {
    if (!tooLong && !line.trim()) return
    if (tooLong) {
      // Oversized line: cannot parse; count it only if it is evidently a message entry.
      if (sawHeader && /^\s*\{\s*"type"\s*:\s*"message"/.test(line)) scan.messageCount++
      return
    }
    if (!sawHeader) { sawHeader = true; return } // header validated separately
    const typed = /^\s*\{\s*"type"\s*:\s*"([A-Za-z_]+)"/.exec(line)
    if (typed && typed[1] !== 'message' && typed[1] !== 'session_info') return
    let entry: unknown
    try { entry = JSON.parse(line) } catch { return }
    if (!isRecord(entry)) return
    if (entry.type === 'session_info') {
      const trimmed = typeof entry.name === 'string' ? entry.name.trim() : ''
      scan.name = trimmed ? trimmed.slice(0, MAX_NAME) : null
      return
    }
    if (entry.type !== 'message') return
    scan.messageCount++
    const message = entry.message
    if (!isRecord(message) || typeof message.role !== 'string' || !('content' in message)) return
    if (message.role !== 'user' && message.role !== 'assistant') return
    const stamp = typeof message.timestamp === 'number' ? message.timestamp : typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    if (Number.isFinite(stamp)) scan.lastActivity = Math.max(scan.lastActivity ?? 0, stamp)
    if (!scan.firstMessage && message.role === 'user') {
      const text = messageText(message).replace(/\s+/g, ' ').trim()
      if (text) scan.firstMessage = text.slice(0, MAX_FIRST_MESSAGE)
    }
  }

  const feed = (text: string): void => {
    let start = 0
    for (;;) {
      const newline = text.indexOf('\n', start)
      if (newline < 0) break
      if (!overflow) {
        current += text.slice(start, newline)
        if (current.length > MAX_LINE_CHARS) overflow = true
      }
      handleLine(current, overflow)
      current = ''
      overflow = false
      start = newline + 1
    }
    if (!overflow) {
      current += text.slice(start)
      if (current.length > MAX_LINE_CHARS) {
        // keep a short prefix so the oversize-line heuristic still works
        current = current.slice(0, 256)
        overflow = true
      }
    }
  }

  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) feed(decoder.write(chunk as Buffer))
  feed(decoder.end())
  if (current) handleLine(current, overflow)
  return scan
}

async function summarize(path: string, stats: { size: number; mtimeMs: number; mtime: Date }, canonicalCwd: string): Promise<NativeSessionSummary | null> {
  const header = await readHeader(path)
  if (!header || typeof header.cwd !== 'string' || header.cwd === '') return null
  if ((await canonical(header.cwd)) !== canonicalCwd) return null
  const scan: Scan = stats.size <= MAX_SCAN_BYTES ? await scanFile(path) : { messageCount: 0, firstMessage: '', name: null, lastActivity: null }
  const headerTime = typeof header.timestamp === 'string' ? Date.parse(header.timestamp) : NaN
  const created = new Date(Number.isFinite(headerTime) ? headerTime : stats.mtimeMs)
  const modifiedMs = scan.lastActivity !== null && scan.lastActivity > 0 ? scan.lastActivity : Number.isFinite(headerTime) ? headerTime : stats.mtimeMs
  const modified = new Date(modifiedMs)
  if (Number.isNaN(created.getTime()) || Number.isNaN(modified.getTime())) return null
  return {
    sessionId: header.id as string,
    file: path,
    name: scan.name,
    created: created.toISOString(),
    modified: modified.toISOString(),
    firstMessage: scan.firstMessage,
    messageCount: scan.messageCount,
    branched: typeof header.parentSession === 'string' && header.parentSession.length > 0,
  }
}

export async function listWorkspaceSessions(cwd: string): Promise<NativeSessionsResult> {
  try {
    const resolution = await resolveWorkspaceSessionDir(cwd)
    if (resolution.error !== null) return { sessions: [], error: resolution.error }
    let names: string[]
    try {
      names = (await readdir(resolution.dir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { sessions: [], error: null }
      return { sessions: [], error: `Could not read the session directory: ${error instanceof Error ? error.message : String(error)}` }
    }
    const files = (await Promise.all(names.map(async (name) => {
      const path = join(resolution.dir, name)
      try { const info = await stat(path); return info.isFile() ? { path, info } : null } catch { return null }
    }))).filter((file): file is NonNullable<typeof file> => file !== null)
      .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, MAX_SESSIONS)

    const canonicalCwd = await canonical(cwd)
    const results: Array<NativeSessionSummary | null> = new Array(files.length).fill(null)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < files.length) {
        const index = next++
        try { results[index] = await summarize(files[index].path, files[index].info, canonicalCwd) } catch { results[index] = null }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker))
    const sessions = results.filter((session): session is NativeSessionSummary => session !== null)
      .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
    return { sessions, error: null }
  } catch (error) {
    return { sessions: [], error: error instanceof Error && error.message ? error.message : 'Could not list saved sessions.' }
  }
}
