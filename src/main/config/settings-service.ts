import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isPlainRecord } from '../../shared/ipc-contracts.ts'

export type ScopedSettingsScope = 'user' | 'project'

export interface ScopedSettingsRoots {
  readonly user: string
  readonly project?: string
}

export interface ScopedJsonSnapshot {
  readonly scope: ScopedSettingsScope
  readonly path: string
  readonly revision: number
  readonly exists: boolean
  readonly document: Record<string, unknown>
}

export interface ScopedTextSnapshot {
  readonly scope: ScopedSettingsScope
  readonly path: string
  readonly revision: number
  readonly exists: boolean
  readonly hasFrontmatter: boolean
  readonly frontmatter: Record<string, string>
}

export interface ScopedFileMutation<T> {
  readonly outcome: 'saved' | 'conflict'
  readonly snapshot: T
}

export const SETTINGS_FILE_MAX_BYTES = 1024 * 1024

const SENSITIVE_FIELD = /(?:secret|token|credential|password|api.?key|authorization|private.?key|access.?key)/i
const UNSAFE_PATH_PART = /^(?:\.|\.\.|constructor|prototype|__proto__)$/

function revisionFor(contents: string | undefined): number {
  if (contents === undefined) return 0
  // A compact content revision permits optimistic concurrency without inserting
  // application-owned metadata into the native Herdr file.
  return Number.parseInt(createHash('sha256').update(contents).digest('hex').slice(0, 12), 16)
}

function safeResponseValue(value: unknown, depth = 0): unknown {
  if (depth > 32) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (const child of value) {
      const safe = safeResponseValue(child, depth + 1)
      if (safe !== undefined) result.push(safe)
    }
    return result
  }
  if (!isPlainRecord(value)) return undefined
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key) || key === 'constructor' || key === 'prototype' || key === '__proto__') continue
    const safe = safeResponseValue(child, depth + 1)
    if (safe !== undefined) Object.defineProperty(result, key, { value: safe, enumerable: true, writable: true, configurable: true })
  }
  return result
}

function validateRelativePath(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path)) {
    throw new TypeError('A scoped settings path must be a non-empty relative path.')
  }
  const parts = path.split(/[\\/]+/)
  if (parts.some((part) => part.length === 0 || UNSAFE_PATH_PART.test(part))) {
    throw new TypeError('A scoped settings path contains an invalid component.')
  }
  return parts
}

function assertNoSymlinkPath(root: string, parts: readonly string[]): string {
  const absoluteRoot = resolve(root)
  let current = absoluteRoot
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    try {
      const details = lstatSync(current)
      if (details.isSymbolicLink()) throw new TypeError('Scoped settings paths may not follow symbolic links.')
      if (index < parts.length - 1 && !details.isDirectory()) {
        throw new TypeError('A scoped settings parent is not a directory.')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  const destination = resolve(absoluteRoot, ...parts)
  const rel = relative(absoluteRoot, destination)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError('Scoped settings path escapes its configured root.')
  }
  return destination
}

function readFileIfExists(path: string): string | undefined {
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    throw error
  }
  try {
    const details = fstatSync(descriptor)
    if (!details.isFile() || details.size > SETTINGS_FILE_MAX_BYTES) {
      throw new TypeError('Scoped settings file is not a regular file or exceeds the size limit.')
    }
    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

function parseJsonObject(contents: string, path: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new TypeError(`Scoped settings JSON is invalid: ${path}`)
  }
  if (!isPlainRecord(parsed)) throw new TypeError(`Scoped settings JSON must contain an object: ${path}`)
  return parsed
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function mergeRecord(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = cloneRecord(base)
  for (const [key, value] of Object.entries(patch)) {
    const previous = result[key]
    if (isPlainRecord(previous) && isPlainRecord(value)) {
      Object.defineProperty(result, key, {
        value: mergeRecord(previous, value), enumerable: true, writable: true, configurable: true,
      })
    } else {
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true })
    }
  }
  return result
}

function removePath(document: Record<string, unknown>, path: string): void {
  const parts = path.split('.')
  if (parts.length === 0 || parts.some((part) => !part || UNSAFE_PATH_PART.test(part))) {
    throw new TypeError('Scoped settings remove path is invalid.')
  }
  let parent: Record<string, unknown> = document
  for (const part of parts.slice(0, -1)) {
    const child = parent[part]
    if (!isPlainRecord(child)) return
    parent = child
  }
  delete parent[parts[parts.length - 1]]
}

function parseFrontmatter(text: string): { hasFrontmatter: boolean; lines: string[]; body: string; values: Record<string, string> } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return { hasFrontmatter: false, lines: [], body: text, values: Object.create(null) as Record<string, string> }
  const whole = match[0]
  const content = match[1]
  const lines = content.split(/\r?\n/)
  const values: Record<string, string> = Object.create(null) as Record<string, string>
  for (const line of lines) {
    const entry = line.match(/^([A-Za-z0-9_-]+):(?:[ \t]*)(.*)$/)
    if (entry && !Object.hasOwn(values, entry[1])) values[entry[1]] = entry[2]
  }
  return { hasFrontmatter: true, lines, body: text.slice(whole.length), values }
}

function safeFrontmatter(values: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(values)) {
    if (!SENSITIVE_FIELD.test(key) && key !== 'constructor' && key !== 'prototype' && key !== '__proto__') result[key] = value
  }
  return result
}

function atomicWrite(path: string, contents: string): void {
  if (Buffer.byteLength(contents, 'utf8') > SETTINGS_FILE_MAX_BYTES) {
    throw new TypeError('Scoped settings file exceeds the size limit.')
  }
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${randomUUID()}.settings.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, contents, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    try {
      const directoryDescriptor = openSync(directory, 'r')
      try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
    } catch {
      // Directory fsync is not supported on every platform.
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

/** Small scoped JSON/frontmatter persistence primitive used by native settings adapters. */
export class ScopedSettingsService {
  private readonly roots: Readonly<Record<ScopedSettingsScope, string | undefined>>

  constructor(roots: ScopedSettingsRoots) {
    if (!isAbsolute(roots.user) || roots.user.includes('\0')) throw new TypeError('User settings root must be absolute.')
    if (roots.project !== undefined && (!isAbsolute(roots.project) || roots.project.includes('\0'))) {
      throw new TypeError('Project settings root must be absolute.')
    }
    this.roots = { user: resolve(roots.user), project: roots.project ? resolve(roots.project) : undefined }
  }

  readJson(scope: ScopedSettingsScope, path: string): ScopedJsonSnapshot {
    const absolutePath = this.resolvePath(scope, path)
    const contents = readFileIfExists(absolutePath)
    const document = contents === undefined ? {} : parseJsonObject(contents, path)
    return {
      scope,
      path,
      revision: revisionFor(contents),
      exists: contents !== undefined,
      document: safeResponseValue(document) as Record<string, unknown>,
    }
  }

  updateJson(
    scope: ScopedSettingsScope,
    path: string,
    expectedRevision: number,
    patch: Record<string, unknown>,
    removePaths: readonly string[] = [],
    validate?: (document: Record<string, unknown>) => void,
  ): ScopedFileMutation<ScopedJsonSnapshot> {
    this.assertRevision(expectedRevision)
    if (!isPlainRecord(patch)) throw new TypeError('Scoped settings patch must be an object.')
    const absolutePath = this.resolvePath(scope, path)
    const contents = readFileIfExists(absolutePath)
    const current = contents === undefined ? {} : parseJsonObject(contents, path)
    if (revisionFor(contents) !== expectedRevision) {
      return { outcome: 'conflict', snapshot: this.makeJsonSnapshot(scope, path, contents, current) }
    }
    const candidate = mergeRecord(current, patch)
    for (const remove of removePaths) removePath(candidate, remove)
    validate?.(candidate)
    const serialized = `${JSON.stringify(candidate, null, 2)}\n`
    atomicWrite(absolutePath, serialized)
    return {
      outcome: 'saved',
      snapshot: this.makeJsonSnapshot(scope, path, serialized, candidate),
    }
  }

  readFrontmatter(scope: ScopedSettingsScope, path: string): ScopedTextSnapshot {
    const absolutePath = this.resolvePath(scope, path)
    const contents = readFileIfExists(absolutePath)
    const parsed = parseFrontmatter(contents ?? '')
    return {
      scope,
      path,
      revision: revisionFor(contents),
      exists: contents !== undefined,
      hasFrontmatter: parsed.hasFrontmatter,
      frontmatter: safeFrontmatter(parsed.values),
    }
  }

  updateFrontmatter(
    scope: ScopedSettingsScope,
    path: string,
    expectedRevision: number,
    fields: Readonly<Record<string, string | null>>,
    validate?: (frontmatter: Record<string, string>) => void,
  ): ScopedFileMutation<ScopedTextSnapshot> {
    this.assertRevision(expectedRevision)
    const absolutePath = this.resolvePath(scope, path)
    const contents = readFileIfExists(absolutePath)
    if (revisionFor(contents) !== expectedRevision) {
      const parsed = parseFrontmatter(contents ?? '')
      return {
        outcome: 'conflict',
        snapshot: {
          scope, path, revision: revisionFor(contents), exists: contents !== undefined,
          hasFrontmatter: parsed.hasFrontmatter, frontmatter: safeFrontmatter(parsed.values),
        },
      }
    }
    for (const [key, value] of Object.entries(fields)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || (value !== null && (typeof value !== 'string' || /[\r\n]/.test(value)))) {
        throw new TypeError('Frontmatter update contains an invalid scalar field.')
      }
    }

    const oldText = contents ?? ''
    const parsed = parseFrontmatter(oldText)
    const lines = parsed.hasFrontmatter ? [...parsed.lines] : []
    for (const [key, value] of Object.entries(fields)) {
      const first = lines.findIndex((line) => line.match(/^([A-Za-z0-9_-]+):/)?.[1] === key)
      if (value === null) {
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          if (lines[index].match(/^([A-Za-z0-9_-]+):/)?.[1] === key) lines.splice(index, 1)
        }
      } else if (first >= 0) {
        lines[first] = `${key}: ${value}`
        for (let index = lines.length - 1; index > first; index -= 1) {
          if (lines[index].match(/^([A-Za-z0-9_-]+):/)?.[1] === key) lines.splice(index, 1)
        }
      } else {
        lines.push(`${key}: ${value}`)
      }
    }
    const candidateFrontmatter: Record<string, string> = Object.create(null) as Record<string, string>
    for (const line of lines) {
      const entry = line.match(/^([A-Za-z0-9_-]+):(?:[ \t]*)(.*)$/)
      if (entry && !Object.hasOwn(candidateFrontmatter, entry[1])) candidateFrontmatter[entry[1]] = entry[2]
    }
    validate?.(candidateFrontmatter)
    const updated = parsed.hasFrontmatter
      ? `---\n${lines.join('\n')}\n---${parsed.body}`
      : `---\n${lines.join('\n')}\n---\n${oldText}`
    atomicWrite(absolutePath, updated)
    const saved = parseFrontmatter(updated)
    return {
      outcome: 'saved',
      snapshot: {
        scope, path, revision: revisionFor(updated), exists: true,
        hasFrontmatter: saved.hasFrontmatter, frontmatter: safeFrontmatter(saved.values),
      },
    }
  }

  listMarkdown(scope: ScopedSettingsScope, directory: string): readonly ScopedTextSnapshot[] {
    const absoluteDirectory = this.resolvePath(scope, directory)
    let files: string[]
    try {
      files = readdirSync(absoluteDirectory).filter((name) => name.endsWith('.md')).sort((a, b) => a.localeCompare(b))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const snapshots: ScopedTextSnapshot[] = []
    for (const file of files) {
      const path = `${directory.replace(/[\\/]+$/, '')}/${file}`
      const absolutePath = this.resolvePath(scope, path)
      const contents = readFileIfExists(absolutePath)
      if (contents === undefined) continue
      const parsed = parseFrontmatter(contents)
      snapshots.push({
        scope, path, revision: revisionFor(contents), exists: true,
        hasFrontmatter: parsed.hasFrontmatter, frontmatter: safeFrontmatter(parsed.values),
      })
    }
    return snapshots
  }

  private makeJsonSnapshot(
    scope: ScopedSettingsScope,
    path: string,
    contents: string | undefined,
    document: Record<string, unknown>,
  ): ScopedJsonSnapshot {
    return {
      scope, path, revision: revisionFor(contents), exists: contents !== undefined,
      document: safeResponseValue(document) as Record<string, unknown>,
    }
  }

  private resolvePath(scope: ScopedSettingsScope, path: string): string {
    const root = this.roots[scope]
    if (!root) throw new TypeError('Project settings are unavailable without an active project root.')
    return assertNoSymlinkPath(root, validateRelativePath(path))
  }

  private assertRevision(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Scoped settings revision is invalid.')
  }
}
