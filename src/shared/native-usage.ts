// Read-only usage summary computed from Pi's own session JSONL files (Pi-authoritative data).
import { hasExactKeys, isPlainRecord } from './ipc-contracts.ts'

export const NATIVE_USAGE_SCOPES = ['current-session', 'workspace', 'all'] as const
export const NATIVE_USAGE_RANGES = ['today', '7d', '30d', 'all'] as const
export type NativeUsageScope = (typeof NATIVE_USAGE_SCOPES)[number]
export type NativeUsageRange = (typeof NATIVE_USAGE_RANGES)[number]

export type NativeUsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  /** Sum of Pi-recorded cost.total; null when no record carried a cost. */
  cost: number | null
  /** Number of usage-bearing records (assistant messages, usage entries, tool/summary usage). */
  messages: number
}
export type NativeUsageModelRow = NativeUsageTotals & { provider: string; model: string }
export type NativeUsageDayRow = NativeUsageTotals & { date: string }
export type NativeUsageSessionRow = NativeUsageTotals & { file: string; title: string; modified: string }

export type NativeUsageSummaryRequest = { scope: NativeUsageScope; range: NativeUsageRange }
export type NativeUsageSummaryResult = {
  scope: NativeUsageScope
  range: NativeUsageRange
  generatedAt: string
  totals: NativeUsageTotals
  byModel: NativeUsageModelRow[]
  byDay: NativeUsageDayRow[]
  /** Top 20 sessions by total tokens. */
  bySession: NativeUsageSessionRow[]
  /** Approximate usage from subagent transcripts of the same session directories; null when none found. */
  subagents: NativeUsageTotals | null
  subagentFiles: number
  filesScanned: number
  capped: boolean
  notes: string[]
  error: string | null
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts {
    'native.usage.summary': { readonly request: NativeUsageSummaryRequest; readonly response: NativeUsageSummaryResult }
  }
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const str = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max

const TOTAL_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'cost', 'messages'] as const

function totalsOk(value: Record<string, unknown>): boolean {
  return count(value.inputTokens) && count(value.outputTokens) && count(value.cacheReadTokens) && count(value.cacheWriteTokens)
    && count(value.totalTokens) && count(value.messages) && (value.cost === null || (typeof value.cost === 'number' && Number.isFinite(value.cost) && value.cost >= 0))
}

export function isNativeUsageTotals(value: unknown): value is NativeUsageTotals {
  return isPlainRecord(value) && hasExactKeys(value, TOTAL_KEYS) && totalsOk(value)
}

const rowOk = (extra: readonly string[], check: (value: Record<string, unknown>) => boolean) => (value: unknown): boolean =>
  isPlainRecord(value) && hasExactKeys(value, [...TOTAL_KEYS, ...extra]) && totalsOk(value) && check(value)
const isModelRow = rowOk(['provider', 'model'], (v) => str(v.provider, 512) && str(v.model, 512))
const isDayRow = rowOk(['date'], (v) => typeof v.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.date))
const isSessionRow = rowOk(['file', 'title', 'modified'], (v) => str(v.file, 4096) && str(v.title, 200) && typeof v.modified === 'string' && v.modified.length <= 40)

export function isNativeUsageSummaryRequest(value: unknown): value is NativeUsageSummaryRequest {
  return isPlainRecord(value) && hasExactKeys(value, ['scope', 'range'])
    && (NATIVE_USAGE_SCOPES as readonly unknown[]).includes(value.scope) && (NATIVE_USAGE_RANGES as readonly unknown[]).includes(value.range)
}

export function isNativeUsageSummaryResult(value: unknown): value is NativeUsageSummaryResult {
  return isPlainRecord(value)
    && hasExactKeys(value, ['scope', 'range', 'generatedAt', 'totals', 'byModel', 'byDay', 'bySession', 'subagents', 'subagentFiles', 'filesScanned', 'capped', 'notes', 'error'])
    && (NATIVE_USAGE_SCOPES as readonly unknown[]).includes(value.scope) && (NATIVE_USAGE_RANGES as readonly unknown[]).includes(value.range)
    && typeof value.generatedAt === 'string' && isNativeUsageTotals(value.totals)
    && Array.isArray(value.byModel) && value.byModel.length <= 500 && value.byModel.every(isModelRow)
    && Array.isArray(value.byDay) && value.byDay.length <= 4000 && value.byDay.every(isDayRow)
    && Array.isArray(value.bySession) && value.bySession.length <= 20 && value.bySession.every(isSessionRow)
    && (value.subagents === null || isNativeUsageTotals(value.subagents))
    && count(value.subagentFiles) && count(value.filesScanned) && typeof value.capped === 'boolean'
    && Array.isArray(value.notes) && value.notes.length <= 20 && value.notes.every((note) => str(note, 500))
    && (value.error === null || str(value.error, 1000))
}
