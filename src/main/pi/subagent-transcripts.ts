// Read-only, bounded reader for subagent conversation transcripts. Never writes; never touches subagent processes.
import { open, realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { SubagentTranscriptEntry, SubagentTranscriptResult } from '../../shared/native-subagents.ts'

const MAX_READ_BYTES = 8 * 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024
const MAX_ENTRIES = 1000
const MAX_STRING = 200 * 1024
const MAX_DEPTH = 64

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function expandTilde(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

function sessionsRoot(): string {
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ? expandTilde(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent'))
  return join(agentDir, 'sessions')
}

// Fail-closed trust check for @tintinweb/pi-subagents output files: base dir <tmpdir>/pi-subagents-<uid>, owned by us, not group/world-writable.
async function checkTintinwebOutput(file: string): Promise<{ ok: true; realFile: string } | { ok: false; error: string; notFound?: boolean }> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid === null) return { ok: false, error: 'Subagent output files cannot be verified on this platform.' }
  let realFile: string
  try { realFile = await realpath(file) } catch { return { ok: false, notFound: true, error: 'Transcript not written yet (the subagent may not have written it yet).' } }
  let realBase: string
  try { realBase = await realpath(join(tmpdir(), `pi-subagents-${uid}`)) } catch { return { ok: false, error: 'The subagent output directory does not exist or is not accessible.' } }
  if (!realFile.startsWith(realBase + sep)) return { ok: false, error: 'The transcript is outside the subagent output directory.' }
  const base = await stat(realBase)
  if (!base.isDirectory() || base.uid !== uid || (base.mode & 0o022) !== 0) return { ok: false, error: 'The subagent output directory is not private to the current user.' }
  const info = await stat(realFile)
  if (info.uid !== uid) return { ok: false, error: 'The transcript is not owned by the current user.' }
  return { ok: true, realFile }
}

function failure(file: string, error: string, bytes = 0, modified = new Date(0).toISOString()): SubagentTranscriptResult {
  return { file, format: 'pi-session', entries: [], truncated: false, bytes, modified, error }
}

// Plain-JSON copy: drops non-serialisable values/keys, caps strings, bounds depth.
function toJson(value: unknown, depth = 0): unknown {
  if (value === null) return null
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (depth >= MAX_DEPTH) return null
  if (Array.isArray(value)) return value.map((item) => {
    const converted = toJson(item, depth + 1)
    return converted === undefined ? null : converted
  })
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const converted = toJson(item, depth + 1)
      if (converted !== undefined) out[key] = converted
    }
    return out
  }
  return undefined
}

function entryId(raw: unknown, fallback: string): string {
  const id = typeof raw === 'string' && raw.length > 0 ? raw : fallback
  return id.length > 256 ? id.slice(0, 256) : id
}

export async function readSubagentTranscript(file: string): Promise<SubagentTranscriptResult> {
  try {
    if (typeof file !== 'string' || file.length === 0 || file.length > 4096 || file.includes('\0')) return failure(String(file).slice(0, 4096), 'The transcript path is invalid.')
    if (!isAbsolute(file)) return failure(file, 'The transcript path must be absolute.')
    const isOutput = file.endsWith('.output')
    if (!isOutput && !file.endsWith('.jsonl')) return failure(file, 'Only .jsonl and subagent .output transcripts can be viewed.')
    let realFile: string
    if (isOutput) {
      const checked = await checkTintinwebOutput(file)
      if (!checked.ok) return failure(file, checked.notFound ? `not-found: ${checked.error}` : checked.error)
      realFile = checked.realFile
    } else {
      try { realFile = await realpath(file) } catch { return failure(file, 'not-found: Transcript not written yet (the subagent may not have written it yet).') }
      let realRoot: string
      try { realRoot = await realpath(sessionsRoot()) } catch { return failure(file, 'The Pi sessions directory does not exist.') }
      if (!realFile.startsWith(realRoot + sep)) return failure(file, 'The transcript is outside the Pi sessions directory.')
    }
    const info = await stat(realFile)
    if (!info.isFile()) return failure(file, 'The transcript is not a regular file.')
    const bytes = info.size
    const modified = info.mtime.toISOString()

    const start = Math.max(0, bytes - MAX_READ_BYTES)
    let truncated = start > 0
    const handle = await open(realFile, 'r')
    let buffer: Buffer
    try {
      buffer = Buffer.alloc(bytes - start)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      buffer = buffer.subarray(0, offset)
    } finally { await handle.close() }

    let text = buffer.toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? '' : text.slice(nl + 1)
    }

    let format: SubagentTranscriptResult['format'] | null = null
    let firstParsed = true
    let entries: SubagentTranscriptEntry[] = []
    let lineIndex = start > 0 ? -1 : 0
    // When tail-reading, line indexes are not absolute; offset ids by the tail start so they stay stable across reads of the same tail.
    const idBase = start > 0 ? `t${start}` : ''
    let n = 0
    for (const line of text.split('\n')) {
      lineIndex = n++
      if (line.length === 0) continue
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) { truncated = true; continue }
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { continue }
      if (!isRecord(parsed)) continue
      if (firstParsed) {
        firstParsed = false
        if (isOutput) format = 'tintinweb-output'
        else if (parsed.type === 'session') format = 'pi-session'
      }
      if (format === null && !isOutput && parsed.recordType === 'message') format = 'herdr-transcript'
      if (format === 'pi-session') {
        if (parsed.type !== 'message' || !isRecord(parsed.message)) continue
        const message = toJson(parsed.message)
        entries.push({
          id: entryId(parsed.id, `line-${idBase}${lineIndex}`),
          timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : null,
          message,
        })
      } else if (format === 'tintinweb-output') {
        if (!isRecord(parsed.message) || (parsed.type !== 'user' && parsed.type !== 'assistant' && parsed.type !== 'toolResult')) continue
        const message = toJson(parsed.message) as Record<string, unknown>
        if (typeof message.role !== 'string') message.role = parsed.type
        const inner = parsed.message.timestamp
        const iso = (v: unknown): string | null => typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) && !Number.isNaN(new Date(v).getTime()) ? new Date(v).toISOString() : null
        const agent = typeof parsed.agentId === 'string' && parsed.agentId ? parsed.agentId.slice(0, 100) : 'agent'
        entries.push({ id: entryId(`${agent}:${idBase}${lineIndex}`, 'agent:0'), timestamp: iso(parsed.timestamp) ?? iso(inner), message })
      } else if (format === 'herdr-transcript') {
        if (parsed.recordType !== 'message' || !isRecord(parsed.message)) continue
        const message = toJson(parsed.message) as Record<string, unknown>
        if (typeof message.role !== 'string' && typeof parsed.role === 'string') message.role = parsed.role
        const inner = parsed.message.timestamp
        const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : typeof inner === 'string' ? inner : null
        const run = typeof parsed.runId === 'string' && parsed.runId ? parsed.runId : 'run'
        entries.push({ id: entryId(`${run}:${idBase}${lineIndex}`, 'run:0'), timestamp, message })
      }
    }
    if (format === null) {
      return failure(file, 'Unrecognised transcript format (expected a Pi session JSONL, a Herdr subagent transcript or a subagent output file).', bytes, modified)
    }
    if (entries.length > MAX_ENTRIES) { entries = entries.slice(-MAX_ENTRIES); truncated = true }
    return { file, format, entries, truncated, bytes, modified, error: null }
  } catch (error) {
    return failure(typeof file === 'string' ? file.slice(0, 4096) : '', error instanceof Error ? error.message : 'Could not read the transcript.')
  }
}
