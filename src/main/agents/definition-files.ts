import { isPlainRecord } from '../../shared/ipc-contracts.ts'
import type { AgentDefinitionFields, AgentDefinitionValidationIssue } from '../../shared/agent-definitions.ts'

export const AGENT_DEFINITION_FIELDS = Object.freeze([
  'name', 'display_name', 'color', 'description', 'tools', 'disallowed_tools', 'extensions',
  'inherit_extensions', 'exclude_extensions', 'skills', 'inherit_skills', 'model', 'thinking',
  'max_turns', 'persist_session', 'output_transcript', 'session_dir', 'allowed_subagents',
  'prompt_mode', 'inherit_context', 'run_in_background', 'isolated', 'memory', 'isolation', 'enabled',
] as const)

export const AGENT_DEFINITION_MAX_BYTES = 1024 * 1024

export interface ParsedAgentDefinitionFile {
  readonly name: string
  readonly fields: AgentDefinitionFields
  readonly prompt: string
  readonly enabled: boolean
  /** Complete parsed frontmatter, including native fields unknown to this app. */
  readonly rawFrontmatter: Readonly<Record<string, unknown>>
  readonly hasFrontmatter: boolean
  readonly validationIssues: readonly AgentDefinitionValidationIssue[]
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const SENSITIVE_KEY = /(?:secret|token|credential|password|api.?key|authorization|private.?key|access.?key)/i
const TEXTUAL_FIELDS = new Set(['name', 'display_name', 'color', 'description', 'model', 'thinking', 'session_dir', 'prompt_mode', 'memory'])
const LIST_FIELDS = new Set(['tools', 'disallowed_tools', 'exclude_extensions'])
const INHERIT_FIELDS = new Set(['extensions', 'inherit_extensions', 'skills', 'inherit_skills', 'allowed_subagents'])
const BOOLEAN_FIELDS = new Set(['persist_session', 'output_transcript', 'inherit_context', 'run_in_background', 'isolated', 'enabled'])

function nativeJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 1024 && value.every((child) => nativeJsonValue(child, depth + 1))
  if (!isPlainRecord(value)) return false
  return Object.entries(value).length <= 1024
    && Object.entries(value).every(([key, child]) => !UNSAFE_KEYS.has(key) && nativeJsonValue(child, depth + 1))
}

function copyNativeFields(rawFrontmatter: Readonly<Record<string, unknown>>): AgentDefinitionFields {
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of AGENT_DEFINITION_FIELDS) {
    const value = rawFrontmatter[key]
    if (!Object.hasOwn(rawFrontmatter, key) || SENSITIVE_KEY.test(key) || !nativeJsonValue(value)) continue
    const boundedString = (maximum: number): boolean => typeof value === 'string' && value.length <= maximum && !value.includes('\0')
    const boundedList = (): boolean => Array.isArray(value)
      && value.length <= 256
      && value.every((item) => typeof item === 'string' && item.length <= 1024 && !item.includes('\0'))
    if (key === 'memory' && (boundedString(8192) || isPlainRecord(value))) fields[key] = value
    else if (TEXTUAL_FIELDS.has(key) && boundedString(key === 'description' ? 4096 : 8192)) fields[key] = value
    else if (LIST_FIELDS.has(key) && (boundedString(8192) || boundedList())) fields[key] = value
    else if (INHERIT_FIELDS.has(key) && (typeof value === 'boolean' || boundedString(8192) || boundedList())) fields[key] = value
    else if (key === 'max_turns' && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) fields[key] = value
    else if (BOOLEAN_FIELDS.has(key) && typeof value === 'boolean') fields[key] = value
    else if (key === 'isolation' && (typeof value === 'boolean' || boundedString(8192))) fields[key] = value
  }
  return fields as AgentDefinitionFields
}


/** Same frontmatter fence rule as Pi's parseFrontmatter: `---` at byte zero, closed by the first later line starting with `---`. */
function splitNativeFrontmatter(content: string): { yaml: string; body: string } | null {
  const normalized = (content.startsWith('﻿') ? content.slice(1) : content).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.startsWith('---')) return null
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return null
  return { yaml: normalized.slice(4, end), body: normalized.slice(end + 4).trim() }
}

function stripYamlComment(text: string): string {
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      if (index === 0 || /[\s,[{:]/.test(text[index - 1])) quote = char
    } else if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).trimEnd()
    }
  }
  return text.trimEnd()
}

function yamlScalar(raw: string): unknown {
  const text = raw.trim()
  if (text === '' || text === '~' || /^(?:null|Null|NULL)$/.test(text)) return null
  if (/^(?:true|True|TRUE)$/.test(text)) return true
  if (/^(?:false|False|FALSE)$/.test(text)) return false
  if (/^[-+]?(?:0|[1-9][0-9]*)$/.test(text)) return Number(text)
  if (/^[-+]?(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/.test(text)) return Number(text)
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try { return JSON.parse(text) as string } catch { return text.slice(1, -1) }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'")
  return text
}

function splitFlow(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (quote) {
      current += char
      if (char === '\\' && quote === '"') { current += inner[index + 1] ?? ''; index += 1 } else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") { quote = char; current += char }
    else if (char === '[' || char === '{') { depth += 1; current += char }
    else if (char === ']' || char === '}') { depth -= 1; current += char }
    else if (char === ',' && depth === 0) { parts.push(current); current = '' }
    else current += char
  }
  if (current.trim()) parts.push(current)
  return parts
}

function yamlFlow(text: string): unknown {
  const value = text.trim()
  if (value.startsWith('[') && value.endsWith(']')) return splitFlow(value.slice(1, -1)).map(yamlFlow)
  if (value.startsWith('{') && value.endsWith('}')) {
    const record: Record<string, unknown> = {}
    for (const part of splitFlow(value.slice(1, -1))) {
      const colon = part.search(/:(?:\s|$)/)
      if (colon < 0) continue
      const key = String(yamlScalar(part.slice(0, colon)))
      if (!UNSAFE_KEYS.has(key)) record[key] = yamlFlow(part.slice(colon + 1))
    }
    return record
  }
  return yamlScalar(value)
}

const KEY_LINE = /^(?:"((?:[^"\\]|\\.)+)"|'([^']+)'|([^\s#'"\-[\]{},&*!|>%@`:][^:]*?|-[^\s:][^:]*?))[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/

/**
 * Parses the YAML subset agent definitions use: a top-level mapping of scalars, flow collections, block
 * sequences, one level of nested mapping and `|`/`>` block scalars. It throws on syntax this subset
 * cannot read (including duplicate keys, as YAML 1.2 loaders do), so malformed files stay "invalid".
 * It is only used to display values; edits are line-wise and never re-serialize untouched keys.
 */
function parseYamlMapping(text: string): Record<string, unknown> {
  const lines = text.split('\n')
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  let index = 0
  const isBlankOrComment = (line: string): boolean => /^\s*(?:#.*)?$/.test(line)
  while (index < lines.length) {
    const line = lines[index]
    if (isBlankOrComment(line)) { index += 1; continue }
    if (/^[ \t]/.test(line)) throw new SyntaxError(`Unexpected indentation on frontmatter line ${index + 1}.`)
    const match = KEY_LINE.exec(line)
    if (!match) throw new SyntaxError(`Unsupported frontmatter syntax on line ${index + 1}.`)
    const key = match[1] !== undefined ? (JSON.parse(`"${match[1]}"`) as string) : (match[2] ?? match[3] ?? '').trim()
    if (UNSAFE_KEYS.has(key)) throw new SyntaxError('Unsafe frontmatter key.')
    if (Object.hasOwn(result, key)) throw new SyntaxError(`Duplicate frontmatter key "${key}".`)
    const rest = stripYamlComment(match[4] ?? '')
    index += 1
    const block: string[] = []
    while (index < lines.length && (isBlankOrComment(lines[index]) || /^[ \t]/.test(lines[index]) || /^-(?:[ \t]|$)/.test(lines[index]))) {
      block.push(lines[index])
      index += 1
    }
    while (block.length && isBlankOrComment(block[block.length - 1])) block.pop()
    if (/^[|>][-+0-9]*$/.test(rest)) {
      const indent = Math.min(...block.filter((entry) => entry.trim()).map((entry) => entry.length - entry.trimStart().length), Infinity)
      const body = block.map((entry) => entry.slice(Number.isFinite(indent) ? indent : 0))
      result[key] = rest.startsWith('|') ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ')
    } else if (rest === '') {
      const content = block.filter((entry) => !isBlankOrComment(entry))
      if (content.length === 0) result[key] = null
      else if (content.every((entry) => /^[ \t]*-(?:[ \t]|$)/.test(entry))) {
        result[key] = content.map((entry) => yamlFlow(stripYamlComment(entry.replace(/^[ \t]*-[ \t]*/, ''))))
      } else {
        const indent = Math.min(...content.map((entry) => entry.length - entry.trimStart().length))
        result[key] = parseYamlMapping(block.map((entry) => entry.slice(indent)).join('\n'))
      }
    } else if (block.some((entry) => !isBlankOrComment(entry))) {
      // Multi-line plain or quoted scalar: folded by single spaces.
      if (/^[[{]/.test(rest)) result[key] = yamlFlow([rest, ...block.map((entry) => stripYamlComment(entry.trim()))].join(' '))
      else result[key] = yamlScalar([rest, ...block.filter((entry) => !isBlankOrComment(entry)).map((entry) => entry.trim())].join(' '))
    } else {
      result[key] = /^[[{]/.test(rest) ? yamlFlow(rest) : yamlScalar(rest)
    }
  }
  return result
}

function parseNativeFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const split = splitNativeFrontmatter(content)
  if (!split) return { frontmatter: {}, body: (content.startsWith('﻿') ? content.slice(1) : content).replace(/\r\n/g, '\n').replace(/\r/g, '\n') }
  return { frontmatter: split.yaml.trim() ? parseYamlMapping(split.yaml) : {}, body: split.body }
}

/** Pure-file parse mirroring Pi's frontmatter fence and body trimming; no Pi SDK dependency. */
export function parseAgentDefinitionFile(content: string, fileName: string): ParsedAgentDefinitionFile {
  const fallbackName = fileName.replace(/\.md$/i, '')
  const normalized = (content.startsWith('\uFEFF') ? content.slice(1) : content).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const hasFrontmatter = normalized.startsWith('---') && normalized.indexOf('\n---', 3) !== -1
  try {
    const parsed = parseNativeFrontmatter(content)
    const candidate = isPlainRecord(parsed.frontmatter) ? parsed.frontmatter : {}
    const declaredName = typeof candidate.name === 'string' ? candidate.name.trim() : ''
    const name = declaredName || fallbackName
    const issues: AgentDefinitionValidationIssue[] = []
    if (declaredName.includes(':')) {
      issues.push({
        code: 'reserved-name',
        field: 'name',
        message: 'Native pi-subagents skips definitions whose declared name contains a colon.',
      })
    }
    return {
      name: name.replace(/\0/g, '').slice(0, 256),
      fields: copyNativeFields(candidate),
      prompt: parsed.body.replace(/\0/g, '').slice(0, 512_000),
      enabled: candidate.enabled !== false,
      rawFrontmatter: candidate,
      hasFrontmatter,
      validationIssues: issues,
    }
  } catch {
    return {
      name: fallbackName,
      fields: {},
      prompt: '',
      enabled: true,
      rawFrontmatter: {},
      hasFrontmatter,
      validationIssues: [{
        code: 'invalid-frontmatter',
        message: 'The frontmatter could not be parsed as YAML; native pi-subagents skips this definition.',
      }],
    }
  }
}

function yamlLine(key: string, value: unknown): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || UNSAFE_KEYS.has(key) || !nativeJsonValue(value)) {
    throw new TypeError('Agent frontmatter contains an unsupported field or value.')
  }
  // Plain scalars for booleans, numbers and simple strings; JSON (a YAML 1.2 subset) for everything else,
  // always on one line so native line-wise tools (e.g. the `enabled:` toggle) keep recognizing keys.
  if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _./@+=-]*$/.test(value) && !/^(?:true|false|null|yes|no|on|off|~)$/i.test(value) && !/^[-+.0-9]/.test(value) && !/\s$/.test(value)) {
    return `${key}: ${value}`
  }
  return `${key}: ${JSON.stringify(value)}`
}

/** Builds a new definition file as one `key: value` line per field (block YAML), then the prompt. */
export function serializeAgentDefinitionFile(
  frontmatter: Readonly<Record<string, unknown>>,
  prompt: string,
): string {
  const lines = Object.entries(frontmatter).map(([key, value]) => yamlLine(key, value))
  return `---\n${lines.join('\n')}\n---\n\n${prompt}\n`
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Line-wise edit of an existing definition. Only keys in `fields`/`clearFields` whose value actually changes
 * are rewritten (as a single line replacing that key's block); every other byte of the frontmatter, the
 * line endings, a BOM and, unless `prompt` changes, the body are preserved exactly. Throws on unparseable files.
 */
export function patchAgentDefinitionFile(
  content: string,
  fields: Readonly<Record<string, unknown>>,
  clearFields: readonly string[] = [],
  prompt?: string,
): string {
  const current = parseNativeFrontmatter(content)
  const lines = content.split(/(?<=\n)/)
  const opener = (content.startsWith('﻿') ? (lines[0] ?? '').slice(1) : (lines[0] ?? '')).replace(/\r?\n$/, '')
  const closeIndex = (): number => lines.findIndex((line, i) => i > 0 && line.startsWith('---'))
  if (!opener.startsWith('---') || closeIndex() < 0) throw new TypeError('Definition has no frontmatter block to edit.')
  const eol = lines[0].endsWith('\r\n') ? '\r\n' : '\n'
  const keyOf = (line: string): string | undefined => {
    const match = KEY_LINE.exec(line.replace(/\r?\n$/, ''))
    if (!match) return undefined
    return match[1] !== undefined ? (JSON.parse(`"${match[1]}"`) as string) : (match[2] ?? match[3] ?? '').trim()
  }
  const isBlankOrComment = (line: string): boolean => /^\s*(?:#.*)?$/.test(line)
  const block = (key: string): { start: number; end: number } | undefined => {
    const close = closeIndex()
    let start = -1
    for (let i = 1; i < close; i += 1) { if (keyOf(lines[i]) === key) { start = i; break } }
    if (start < 0) return undefined
    let end = start + 1
    while (end < close && keyOf(lines[end]) === undefined) end += 1
    while (end > start + 1 && isBlankOrComment(lines[end - 1])) end -= 1
    return { start, end }
  }
  for (const key of clearFields) {
    if (Object.hasOwn(fields, key)) continue
    const found = block(key)
    if (found) lines.splice(found.start, found.end - found.start)
  }
  for (const [key, value] of Object.entries(fields)) {
    if (Object.hasOwn(current.frontmatter, key) && sameValue(current.frontmatter[key], value)) continue
    const replacement = `${yamlLine(key, value)}${eol}`
    const found = block(key)
    if (found) lines.splice(found.start, found.end - found.start, replacement)
    else lines.splice(closeIndex(), 0, replacement)
  }
  if (prompt !== undefined && prompt !== current.body) {
    if (prompt.includes('\0')) throw new TypeError('Agent prompt is invalid.')
    const head = lines.slice(0, closeIndex() + 1)
    const closeLine = head[head.length - 1]
    head[head.length - 1] = /\r?\n$/.test(closeLine) ? closeLine : `${closeLine}${eol}`
    return `${head.join('')}${eol}${prompt}${eol}`
  }
  return lines.join('')
}

export function validateAgentDefinitionName(name: string): readonly AgentDefinitionValidationIssue[] {
  const issues: AgentDefinitionValidationIssue[] = []
  if (name.trim().includes(':')) {
    issues.push({ code: 'reserved-name', field: 'name', message: 'Native pi-subagents reserves colons in declared names.' })
  }
  return issues
}
