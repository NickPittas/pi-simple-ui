import { homedir } from 'node:os'

export const REDACTED_VALUE = '[redacted]' as const

export interface RedactionOptions {
  readonly homeDirectory?: string
  readonly maxStringLength?: number
  readonly maxDepth?: number
  readonly maxCollectionEntries?: number
}

export type DiagnosticJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly DiagnosticJsonValue[]
  | { readonly [key: string]: DiagnosticJsonValue }

const DEFAULT_MAX_STRING_LENGTH = 8_192
const DEFAULT_MAX_DEPTH = 8
const DEFAULT_MAX_COLLECTION_ENTRIES = 100
const SENSITIVE_FIELD = /(?:key|token|secret|password|authorization|credential)/i
const SENSITIVE_ASSIGNMENT = /(\b(?:[A-Z0-9_]*(?:API[\s_-]*KEY|ACCESS[\s_-]*KEY|AUTHORIZATION|AUTH[\s_-]*TOKEN|ACCESS[\s_-]*TOKEN|REFRESH[\s_-]*TOKEN|CLIENT[\s_-]*SECRET|PASSWORD|CREDENTIAL|TOKEN|SECRET)[A-Z0-9_]*)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi
const AUTHORIZATION_VALUE = /(\b(?:proxy-)?authorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;]+/gi
const BEARER_VALUE = /\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi
const OAUTH_CODE_VALUE = /(\b(?:authorization[_-]?code|device[_-]?code|oauth[_-]?code)\s*[=:]\s*|[?&]code=)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&#,;]+)/gi
const API_TOKEN = /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ya29\.[A-Za-z0-9_-]{16,})\b/g
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceHomeDirectory(value: string, homeDirectory: string): string {
  if (!homeDirectory || homeDirectory === '/') return value
  const normalized = homeDirectory.replace(/\\/g, '/')
  const pathPattern = new RegExp(`${escapeRegExp(normalized).replace(/\//g, '[\\\\/]')}(?=$|[\\\\/\\s:'"])`, 'g')
  return value.replace(pathPattern, '~')
}

function redactPatterns(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE, `$1${REDACTED_VALUE}`)
    .replace(SENSITIVE_ASSIGNMENT, `$1${REDACTED_VALUE}`)
    .replace(BEARER_VALUE, `$1${REDACTED_VALUE}`)
    .replace(OAUTH_CODE_VALUE, `$1${REDACTED_VALUE}`)
    .replace(API_TOKEN, REDACTED_VALUE)
    .replace(JWT_VALUE, REDACTED_VALUE)
}

/** Redacts common secret-bearing strings and caps all free-form diagnostic text. */
export function redactDiagnosticString(value: string, options: RedactionOptions = {}): string {
  const maximum = Number.isSafeInteger(options.maxStringLength) && (options.maxStringLength as number) >= 0
    ? options.maxStringLength as number
    : DEFAULT_MAX_STRING_LENGTH
  const shortened = value.length > maximum ? `${value.slice(0, maximum)}…[truncated]` : value
  return replaceHomeDirectory(redactPatterns(shortened), options.homeDirectory ?? homedir())
}

/**
 * Recursively produces bounded JSON-safe diagnostics. Sensitive property values are
 * replaced at every depth while retaining their field names for actionable context.
 */
export function redactDiagnosticValue(value: unknown, options: RedactionOptions = {}): DiagnosticJsonValue {
  const maxDepth = Number.isSafeInteger(options.maxDepth) && (options.maxDepth as number) >= 0
    ? options.maxDepth as number
    : DEFAULT_MAX_DEPTH
  const maxEntries = Number.isSafeInteger(options.maxCollectionEntries) && (options.maxCollectionEntries as number) >= 0
    ? options.maxCollectionEntries as number
    : DEFAULT_MAX_COLLECTION_ENTRIES
  const seen = new WeakSet<object>()

  const visit = (item: unknown, depth: number): DiagnosticJsonValue => {
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'string') return redactDiagnosticString(item, options)
    if (typeof item === 'number') return Number.isFinite(item) ? item : '[non-finite number]'
    if (typeof item === 'bigint') return redactDiagnosticString(item.toString(), options)
    if (typeof item === 'undefined') return '[undefined]'
    if (typeof item === 'symbol') return '[symbol]'
    if (typeof item === 'function') return '[function]'
    if (depth >= maxDepth) return '[maximum depth reached]'
    if (typeof item !== 'object') return '[unavailable]'
    if (seen.has(item)) return '[circular reference]'
    seen.add(item)

    if (item instanceof Error) {
      const error = item as Error & { readonly cause?: unknown; readonly code?: unknown }
      const output: Record<string, DiagnosticJsonValue> = {
        name: redactDiagnosticString(error.name || 'Error', options),
        message: redactDiagnosticString(error.message || '', options),
      }
      if (typeof error.code === 'string' || typeof error.code === 'number') {
        output.code = redactDiagnosticString(String(error.code), options)
      }
      if (typeof error.stack === 'string') output.stack = redactDiagnosticString(error.stack, options)
      if (error.cause !== undefined) output.cause = visit(error.cause, depth + 1)
      return output
    }
    if (Array.isArray(item)) {
      const output = item.slice(0, maxEntries).map((child) => visit(child, depth + 1))
      if (item.length > maxEntries) output.push(`[${item.length - maxEntries} entries omitted]`)
      return output
    }

    const output: Record<string, DiagnosticJsonValue> = Object.create(null) as Record<string, DiagnosticJsonValue>
    let count = 0
    for (const [key, child] of Object.entries(item)) {
      if (count >= maxEntries) {
        output['[entries]'] = '[additional entries omitted]'
        break
      }
      const safeKey = redactDiagnosticString(key, { ...options, maxStringLength: 256 })
      output[safeKey] = SENSITIVE_FIELD.test(key) || /^(?:env|environment)$/i.test(key)
        ? REDACTED_VALUE
        : visit(child, depth + 1)
      count += 1
    }
    return output
  }

  try {
    return visit(value, 0)
  } catch {
    return '[unavailable]'
  }
}
