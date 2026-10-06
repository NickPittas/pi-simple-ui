import type { PackageScope, PromptTemplateResourceView, SkillDocumentView, SkillResourceView, TemplateDocumentView } from '../../shared/packages.ts'

export type ResourceKind = 'skill' | 'template'
export type ResourceItem = SkillResourceView | PromptTemplateResourceView
export type ResourceDoc = SkillDocumentView | TemplateDocumentView
export type SourceFilter = 'all' | 'user' | 'project' | 'package'
export type GroupKey = 'user' | 'project' | 'package'

export type Draft = {
  name: string
  description: string
  body: string
  /** Skills: inverse of disable-model-invocation. */
  autoInvoke: boolean
  tools: string[]
  license: string
  compatibility: string
  /** Templates: argument-hint. */
  argumentHint: string
}
export type Editor = { mode: 'create' | 'edit'; scope: PackageScope; doc?: ResourceDoc; copyOf?: boolean; draft: Draft }

export const blankDraft: Draft = { name: '', description: '', body: '', autoInvoke: true, tools: [], license: '', compatibility: '', argumentHint: '' }

export type FmEntry = { raw: string; value: unknown | undefined }

/** Light, read-only decoder for top-level frontmatter keys. `value: undefined` means "shape not understood" (shown raw, never edited). */
export function parseFrontmatter(raw: string | undefined): Map<string, FmEntry> {
  const out = new Map<string, FmEntry>()
  if (!raw) return out
  const blocks: { key: string; lines: string[] }[] = []
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line)
    if (match) blocks.push({ key: match[1]!, lines: [match[2]!] })
    else if (blocks.length) blocks[blocks.length - 1]!.lines.push(line)
  }
  for (const block of blocks) {
    if (out.has(block.key)) continue
    const inline = block.lines[0]!.trim()
    const rest = block.lines.slice(1).filter((line) => line.trim() !== '' && !/^\s*#/.test(line))
    const rawText = [block.lines[0]!, ...block.lines.slice(1)].join('\n').replace(/\s+$/, '')
    out.set(block.key, { raw: rawText, value: decode(inline, rest) })
  }
  return out
}

function decode(inline: string, rest: string[]): unknown | undefined {
  if (inline === '' || inline.startsWith('#')) {
    if (rest.length === 0) return null
    if (rest.every((line) => /^\s*-\s+/.test(line))) return rest.map((line) => unquote(line.replace(/^\s*-\s+/, '').trim()))
    return undefined
  }
  if (rest.length > 0) return undefined
  if (/^[|>]/.test(inline) || /^[&*!]/.test(inline)) return undefined
  if (inline.startsWith('[') || inline.startsWith('{') || inline.startsWith('"')) { try { return JSON.parse(inline) as unknown } catch { return undefined } }
  if (inline.startsWith("'")) { const m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(inline); return m ? m[1]!.replace(/''/g, "'") : undefined }
  const plain = inline.replace(/\s+#.*$/, '').trim()
  if (/^(true|True|TRUE)$/.test(plain)) return true
  if (/^(false|False|FALSE)$/.test(plain)) return false
  return plain
}
function unquote(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"') && text.length > 1)) { try { return String(JSON.parse(text)) } catch { return text } }
  if (text.startsWith("'") && text.endsWith("'") && text.length > 1) return text.slice(1, -1).replace(/''/g, "'")
  return text
}

export const SKILL_KNOWN_KEYS: ReadonlySet<string> = new Set(['name', 'description', 'disable-model-invocation', 'allowed-tools', 'license', 'compatibility'])
export const TEMPLATE_KNOWN_KEYS: ReadonlySet<string> = new Set(['description', 'argument-hint'])

export function scalar(entry: FmEntry | undefined): string { return entry && typeof entry.value === 'string' ? entry.value : entry && (typeof entry.value === 'number' || typeof entry.value === 'boolean') ? String(entry.value) : '' }
/** True when the key exists but its value cannot be edited safely as a plain string (so the field is left alone). */
export function isOpaque(entry: FmEntry | undefined): boolean { return !!entry && entry.value === undefined }

export function draftFromDoc(doc: ResourceDoc): Draft {
  const fm = parseFrontmatter(doc.frontmatterRaw)
  const tools = fm.get('allowed-tools')?.value
  return {
    name: doc.name,
    description: doc.description,
    body: doc.body,
    autoInvoke: doc.kind === 'skill' ? !doc.disableModelInvocation : true,
    tools: Array.isArray(tools) ? tools.map(String) : typeof tools === 'string' ? tools.split(/[,\s]+/).filter(Boolean) : [],
    license: scalar(fm.get('license')),
    compatibility: scalar(fm.get('compatibility')),
    argumentHint: doc.kind === 'template' ? (doc.argumentHint ?? scalar(fm.get('argument-hint'))) : '',
  }
}

export function sameDraft(a: Draft, b: Draft): boolean { return JSON.stringify(a) === JSON.stringify(b) }

/** Pi's skill-name rules (agentskills.io): <=64 chars, lowercase a-z 0-9 hyphen, no leading/trailing/double hyphen. */
export function skillNameIssues(name: string): string[] {
  const out: string[] = []
  if (!name) return ['Name is required.']
  if (name.length > 64) out.push(`Name is ${name.length} characters; the limit is 64.`)
  if (/[^a-z0-9-]/.test(name)) out.push('Use only lowercase letters, digits and hyphens.')
  if (name.startsWith('-') || name.endsWith('-')) out.push('Name must not start or end with a hyphen.')
  if (name.includes('--')) out.push('Name must not contain consecutive hyphens.')
  return out
}
export function templateNameIssues(name: string): string[] {
  if (!name) return ['Name is required.']
  if (name.length > 128) return ['Name must be at most 128 characters.']
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return ['Start with a letter or digit; then use letters, digits, "-" or "_".']
  return []
}

export function groupOf(item: ResourceItem): GroupKey {
  if (item.source === 'user') return 'user'
  if (item.source === 'project') return 'project'
  return 'package'
}
export const groupLabels: Record<GroupKey, string> = { user: 'User', project: 'Project', package: 'Packages & other' }

export function sourceBadge(item: { source: string; sourceDetail?: string }): string {
  if (item.source === 'user') return 'user'
  if (item.source === 'project') return 'project'
  const detail = (item.sourceDetail ?? '').replace(/^(npm|git|github):/, '').replace(/\.git$/, '').replace(/@[\w.^~-]+$/, '')
  const short = detail.split(/[\\/]/).filter(Boolean).pop() ?? ''
  if (!short || short === 'auto') return item.source === 'package' ? 'package' : item.source
  return short.length > 22 ? `${short.slice(0, 21)}…` : short
}

export type Status = 'loaded' | 'off' | 'shadowed'
export function statusOf(item: { loaded?: boolean; shadowedBy?: string }): { status: Status; tip: string } {
  if (item.shadowedBy) return { status: 'shadowed', tip: `Shadowed by ${item.shadowedBy}` }
  if (item.loaded) return { status: 'loaded', tip: 'Loaded by Pi' }
  return { status: 'off', tip: 'Not loaded (restart Pi or check filters)' }
}

export const itemKey = (item: { path: string }) => item.path
export function scopeOf(value: string): PackageScope | null { return value === 'user' || value === 'project' ? value : null }
export function docAsTemplate(doc: ResourceDoc): TemplateDocumentView | null { return doc.kind === 'template' ? doc : null }
