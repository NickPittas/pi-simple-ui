// Read-only usage aggregation from Pi's own session JSONL files. Never writes; never touches Pi or the SDK.
// Totals follow Pi's getSessionStats (agent-session.js getSessionStats / usage-totals.js): total = input + output + cacheRead + cacheWrite,
// cost = sum of usage.cost.total, counting assistant messages, `usage` entries, tool-result usage and compaction/branch_summary usage.
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { CapabilityDefinition } from '../ipc/register.ts'
import { resolveWorkspaceSessionDir } from '../pi/session-catalog.ts'
import {
  isNativeUsageSummaryRequest,
  isNativeUsageSummaryResult,
  type NativeUsageDayRow,
  type NativeUsageModelRow,
  type NativeUsageRange,
  type NativeUsageScope,
  type NativeUsageSessionRow,
  type NativeUsageSummaryResult,
  type NativeUsageTotals,
} from '../../shared/native-usage.ts'

const MAX_LINE_CHARS = 1024 * 1024
const MAX_FILES = 2000
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_CACHE = 4000
const CONCURRENCY = 4
const TOP_SESSIONS = 20
const TITLE_MAX = 80
const OTHER_PROVIDER = 'other'
const OTHER_MODEL = 'tools/summaries'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

type Bucket = { day: string; provider: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; hasCost: boolean; messages: number }
type FileData = { title: string; lastTs: number | null; buckets: Bucket[] }
type FileRef = { path: string; size: number; mtimeMs: number }

const cache = new Map<string, { size: number; mtimeMs: number; data: FileData }>()

function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function expandTilde(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

function sessionsRoot(): string {
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ? expandTilde(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent'))
  return join(agentDir, 'sessions')
}

async function readLines(path: string, onLine: (line: string) => void): Promise<void> {
  const decoder = new StringDecoder('utf8')
  let current = ''
  let overflow = false
  const feed = (text: string): void => {
    let start = 0
    for (;;) {
      const newline = text.indexOf('\n', start)
      if (newline < 0) break
      if (!overflow) {
        current += text.slice(start, newline)
        if (current.length > MAX_LINE_CHARS) overflow = true
      }
      if (!overflow && current) onLine(current)
      current = ''
      overflow = false
      start = newline + 1
    }
    if (!overflow) {
      current += text.slice(start)
      if (current.length > MAX_LINE_CHARS) { current = ''; overflow = true }
    }
  }
  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) feed(decoder.write(chunk as Buffer))
  feed(decoder.end())
  if (current && !overflow) onLine(current)
}

function userText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string).join(' ')
}

// Strip leading <file name="...">...</file> attachment markup (and an unterminated leading <file ...> tag), then collapse whitespace.
function cleanTitle(text: string): string {
  let out = text
  for (;;) {
    const trimmed = out.trimStart()
    const closed = /^<file\b[^>]*>[\s\S]*?<\/file>/.exec(trimmed)
    if (closed) { out = trimmed.slice(closed[0].length); continue }
    const open = /^<file\b[^>]*>/.exec(trimmed)
    if (open) { out = trimmed.slice(open[0].length); continue }
    out = trimmed
    break
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
}

function timestampOf(message: Record<string, unknown> | null, entry: Record<string, unknown>): number | null {
  if (message && typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) return message.timestamp
  for (const candidate of [entry.timestamp, entry.ts]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
    if (typeof candidate === 'string') { const parsed = Date.parse(candidate); if (Number.isFinite(parsed)) return parsed }
  }
  return null
}

async function scanFile(file: FileRef, kind: 'session' | 'subagent'): Promise<FileData> {
  const buckets = new Map<string, Bucket>()
  const data: FileData = { title: '', lastTs: null, buckets: [] }
  let name = ''
  let firstUser = ''
  const record = (usage: unknown, provider: string, model: string, ts: number | null): void => {
    if (!isRecord(usage)) return
    const input = num(usage.input), output = num(usage.output), cacheRead = num(usage.cacheRead), cacheWrite = num(usage.cacheWrite)
    const cost = isRecord(usage.cost) && typeof usage.cost.total === 'number' && Number.isFinite(usage.cost.total) ? usage.cost.total : null
    const day = ts === null ? 'unknown' : localDay(ts)
    if (ts !== null) data.lastTs = Math.max(data.lastTs ?? 0, ts)
    const key = `${day}\0${provider}\0${model}`
    let bucket = buckets.get(key)
    if (!bucket) { bucket = { day, provider, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, hasCost: false, messages: 0 }; buckets.set(key, bucket) }
    bucket.input += input; bucket.output += output; bucket.cacheRead += cacheRead; bucket.cacheWrite += cacheWrite
    if (cost !== null) { bucket.cost += cost; bucket.hasCost = true }
    bucket.messages++
  }
  await readLines(file.path, (line) => {
    const wantTitle = kind === 'session' && !firstUser
    if (!line.includes('"usage"') && !(kind === 'session' && line.includes('"session_info"')) && !(wantTitle && line.includes('"role":"user"'))) return
    let entry: unknown
    try { entry = JSON.parse(line) } catch { return }
    if (!isRecord(entry)) return
    if (entry.type === 'session_info') {
      if (typeof entry.name === 'string' && entry.name.trim()) name = cleanTitle(entry.name)
      return
    }
    if (entry.type === 'usage' && kind === 'session') {
      record(entry.usage, typeof entry.provider === 'string' ? entry.provider : OTHER_PROVIDER, typeof entry.model === 'string' ? entry.model : OTHER_MODEL, timestampOf(null, entry))
      return
    }
    if ((entry.type === 'compaction' || entry.type === 'branch_summary') && kind === 'session') {
      if (entry.usage) record(entry.usage, OTHER_PROVIDER, OTHER_MODEL, timestampOf(null, entry))
      return
    }
    const message = isRecord(entry.message) ? entry.message : null
    if (!message) return
    if (message.role === 'user') {
      if (wantTitle && (entry.type === 'message' || kind === 'session')) firstUser = cleanTitle(userText(message))
      return
    }
    if (message.role === 'assistant') {
      const usage = message.usage ?? entry.usage
      const provider = typeof message.provider === 'string' && message.provider ? message.provider : OTHER_PROVIDER
      const modelValue = message.responseModel ?? message.model ?? entry.model
      record(usage, provider, typeof modelValue === 'string' && modelValue ? modelValue : '(unknown)', timestampOf(message, entry))
    } else if (message.role === 'toolResult' && message.usage) {
      record(message.usage, OTHER_PROVIDER, OTHER_MODEL, timestampOf(message, entry))
    }
  })
  data.title = name || firstUser || '(untitled)'
  data.buckets = [...buckets.values()]
  return data
}

async function cachedScan(file: FileRef, kind: 'session' | 'subagent'): Promise<FileData | null> {
  if (file.size > MAX_FILE_BYTES) return null
  const hit = cache.get(file.path)
  if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) return hit.data
  try {
    const data = await scanFile(file, kind)
    cache.delete(file.path)
    cache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, data })
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string)
    return data
  } catch { return null }
}

async function pool<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => { while (next < items.length) { const i = next++; results[i] = await work(items[i]) } }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  return results
}

async function listJsonl(dir: string, suffix: string): Promise<FileRef[]> {
  let names: string[]
  try { names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(suffix)).map((e) => e.name) } catch { return [] }
  const refs = await pool(names, async (name) => {
    const path = join(dir, name)
    try { const info = await stat(path); return info.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs } : null } catch { return null }
  })
  return refs.filter((ref): ref is FileRef => ref !== null)
}

// ---- aggregation ----
type Acc = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; hasCost: boolean; messages: number }
const acc = (): Acc => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, hasCost: false, messages: 0 })
function addBucket(a: Acc, b: Bucket): void {
  a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite; a.messages += b.messages
  if (b.hasCost) { a.cost += b.cost; a.hasCost = true }
}
function totals(a: Acc): NativeUsageTotals {
  return { inputTokens: a.input, outputTokens: a.output, cacheReadTokens: a.cacheRead, cacheWriteTokens: a.cacheWrite, totalTokens: a.input + a.output + a.cacheRead + a.cacheWrite, cost: a.hasCost ? a.cost : null, messages: a.messages }
}

function rangeStartDay(range: NativeUsageRange): string | null {
  if (range === 'all') return null
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (range === 'today' ? 0 : range === '7d' ? 6 : 29))
  return localDay(d.getTime())
}

const inRange = (bucket: Bucket, start: string | null): boolean => start === null || (bucket.day !== 'unknown' && bucket.day >= start)

function blank(scope: NativeUsageScope, range: NativeUsageRange, error: string | null, notes: string[] = []): NativeUsageSummaryResult {
  return { scope, range, generatedAt: new Date().toISOString(), totals: totals(acc()), byModel: [], byDay: [], bySession: [], subagents: null, subagentFiles: 0, filesScanned: 0, capped: false, notes, error }
}

export type NativeUsageDeps = {
  /** Current Pi session file via get_state, or null when there is no active host / no persisted session. */
  currentSessionFile: () => Promise<string | null>
  activeWorkspacePath: () => string | null
}

export async function summarizeNativeUsage(deps: NativeUsageDeps, scope: NativeUsageScope, range: NativeUsageRange): Promise<NativeUsageSummaryResult> {
  const notes: string[] = []
  let capped = false
  let sessionFiles: FileRef[] = []
  let subagentDirs: string[] = []
  try {
    if (scope === 'current-session') {
      let file: string | null
      try { file = await deps.currentSessionFile() } catch (error) { return blank(scope, range, error instanceof Error ? error.message : 'Pi is not active.') }
      if (!file) return blank(scope, range, 'The active Pi session has no session file yet.')
      if (!isAbsolute(file) || !file.endsWith('.jsonl')) return blank(scope, range, 'The active session file is not a .jsonl file.')
      try { const info = await stat(file); sessionFiles = [{ path: file, size: info.size, mtimeMs: info.mtimeMs }] } catch { return blank(scope, range, 'The active session file has not been written yet.') }
      notes.push('Subagent transcripts are stored per workspace, not per session, so they are not attributed to the current session.')
    } else if (scope === 'workspace') {
      const cwd = deps.activeWorkspacePath()
      if (!cwd) return blank(scope, range, 'Open a workspace to see its usage.')
      const resolution = await resolveWorkspaceSessionDir(cwd)
      if (resolution.error !== null) return blank(scope, range, resolution.error)
      sessionFiles = await listJsonl(resolution.dir, '.jsonl')
      subagentDirs = [join(resolution.dir, 'subagent-artifacts')]
    } else {
      const root = sessionsRoot()
      let dirs: string[]
      try { dirs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => join(root, e.name)) } catch { return blank(scope, range, null, ['No Pi sessions directory was found.']) }
      sessionFiles = (await pool(dirs, (dir) => listJsonl(dir, '.jsonl'))).flat()
      subagentDirs = dirs.map((dir) => join(dir, 'subagent-artifacts'))
    }

    const cap = (files: FileRef[], label: string): FileRef[] => {
      const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)
      const kept: FileRef[] = []
      let bytes = 0
      for (const file of sorted) {
        if (kept.length >= MAX_FILES || bytes + file.size > MAX_TOTAL_BYTES) { capped = true; continue }
        bytes += file.size
        kept.push(file)
      }
      if (kept.length < sorted.length) notes.push(`Only the ${kept.length} newest of ${sorted.length} ${label} files were read (caps: ${MAX_FILES} files, ${Math.round(MAX_TOTAL_BYTES / 1024 ** 3)} GiB).`)
      return kept
    }
    sessionFiles = cap(sessionFiles, 'session')
    const start = rangeStartDay(range)

    const scanned = await pool(sessionFiles, async (file) => ({ file, data: await cachedScan(file, 'session') }))
    const all = acc()
    const models = new Map<string, Acc & { provider: string; model: string }>()
    const days = new Map<string, Acc>()
    const sessions: NativeUsageSessionRow[] = []
    let filesScanned = 0
    let skipped = 0
    for (const { file, data } of scanned) {
      if (!data) { skipped++; continue }
      filesScanned++
      const own = acc()
      for (const bucket of data.buckets) {
        if (!inRange(bucket, start)) continue
        addBucket(own, bucket); addBucket(all, bucket)
        const modelKey = `${bucket.provider}\0${bucket.model}`
        let model = models.get(modelKey)
        if (!model) { model = { ...acc(), provider: bucket.provider, model: bucket.model }; models.set(modelKey, model) }
        addBucket(model, bucket)
        if (bucket.day !== 'unknown') { let day = days.get(bucket.day); if (!day) { day = acc(); days.set(bucket.day, day) }; addBucket(day, bucket) }
      }
      if (own.messages > 0) sessions.push({ file: file.path, title: data.title || basename(file.path), modified: new Date(data.lastTs ?? file.mtimeMs).toISOString(), ...totals(own) })
    }
    if (skipped > 0) notes.push(`${skipped} session file(s) were skipped (unreadable or over ${MAX_FILE_BYTES / 1024 ** 2} MiB).`)

    let subagents: NativeUsageTotals | null = null
    let subagentFiles = 0
    if (subagentDirs.length > 0) {
      const refs = cap((await pool(subagentDirs, (dir) => listJsonl(dir, '_transcript.jsonl'))).flat(), 'subagent transcript')
      const sub = acc()
      const results = await pool(refs, (ref) => cachedScan(ref, 'subagent'))
      for (const data of results) {
        if (!data) continue
        let any = false
        for (const bucket of data.buckets) if (inRange(bucket, start)) { addBucket(sub, bucket); any = true }
        if (any) subagentFiles++
      }
      if (sub.messages > 0) { subagents = totals(sub); notes.push('Subagent totals are approximate: transcripts are separate from session files and may overlap with parent-session tool usage.') }
    }

    const byModel: NativeUsageModelRow[] = [...models.values()].map((m) => ({ provider: m.provider, model: m.model, ...totals(m) })).sort((a, b) => b.totalTokens - a.totalTokens)
    const byDay: NativeUsageDayRow[] = [...days.entries()].map(([date, a]) => ({ date, ...totals(a) })).sort((a, b) => a.date.localeCompare(b.date))
    sessions.sort((a, b) => b.totalTokens - a.totalTokens)
    const result: NativeUsageSummaryResult = {
      scope, range, generatedAt: new Date().toISOString(), totals: totals(all), byModel, byDay, bySession: sessions.slice(0, TOP_SESSIONS),
      subagents, subagentFiles, filesScanned, capped, notes: notes.slice(0, 20), error: null,
    }
    return result
  } catch (error) {
    return blank(scope, range, error instanceof Error && error.message ? error.message : 'Could not compute usage.', notes)
  }
}

export function registerNativeUsageCapabilities(deps: NativeUsageDeps): CapabilityDefinition<any, any>[] {
  return [{
    id: 'native.usage.summary', scope: 'runtime', validateRequest: isNativeUsageSummaryRequest, validateResponse: isNativeUsageSummaryResult,
    handle: async (_context, request) => summarizeNativeUsage(deps, request.scope, request.range),
  }]
}
