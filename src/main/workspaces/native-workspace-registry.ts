import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { hasExactKeys, isPlainRecord } from '../../shared/ipc-contracts.ts'

interface StoredWorkspace {
  readonly id: string
  readonly path: string
  readonly identity: { readonly device: string; readonly inode: string }
  readonly firstOpenedAt: number
  readonly lastOpenedAt: number
  readonly previousPaths: readonly string[]
  readonly nativeTrustInvalidated: boolean
  readonly [key: string]: unknown
}
type RegistryData = { schemaVersion: 1; workspaces: StoredWorkspace[]; [key: string]: unknown }

export type WorkspaceIdentityResult =
  | { readonly ok: true; readonly canonicalPath: string; readonly identity: StoredWorkspace['identity'] }
  | { readonly ok: false; readonly status: 'invalid' | 'missing' | 'unreadable' | 'not-directory' }

export interface NativeWorkspaceInfo {
  readonly id: string | null
  readonly canonicalPath: string | null
  readonly matchesStoredIdentity: boolean
  readonly moved: boolean
  readonly missing: boolean
  readonly status: 'available' | 'moved' | 'missing' | 'unreadable' | 'invalid' | 'not-directory'
}

/** This reports folder identity only; trust and approval belong to native Pi. */
export function readWorkspaceIdentity(folderPath: string): WorkspaceIdentityResult {
  if (typeof folderPath !== 'string' || !isAbsolute(folderPath) || folderPath.length > 4096 || folderPath.includes('\0')) {
    return { ok: false, status: 'invalid' }
  }
  try {
    const canonicalPath = realpathSync(folderPath)
    const stats = statSync(canonicalPath, { bigint: true })
    if (!stats.isDirectory()) return { ok: false, status: 'not-directory' }
    return { ok: true, canonicalPath, identity: { device: stats.dev.toString(), inode: stats.ino.toString() } }
  } catch (error) {
    return { ok: false, status: (error as NodeJS.ErrnoException).code === 'ENOENT'
      || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'missing' : 'unreadable' }
  }
}

const sameIdentity = (left: StoredWorkspace['identity'], right: StoredWorkspace['identity']) =>
  left.device === right.device && left.inode === right.inode

type FailureKind = 'read-failure' | 'parse-failure' | 'validation-failure' | 'write-unsafe'
export class NativeWorkspaceRegistryError extends Error {
  constructor(readonly kind: FailureKind, path: string) { super(`Native workspace registry ${kind}: ${path}`) }
}
const knownRoot = ['schemaVersion', 'workspaces']
const knownRecord = ['id', 'path', 'identity', 'firstOpenedAt', 'lastOpenedAt', 'previousPaths', 'nativeTrustInvalidated']
const anchored = (value: Record<string, unknown>, keys: string[]) =>
  hasExactKeys(Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]])), keys)
function validRecord(value: unknown): value is StoredWorkspace {
  if (!isPlainRecord(value) || !anchored(value, knownRecord) || !isPlainRecord(value.identity)
    || !hasExactKeys(value.identity, ['device', 'inode'])) return false
  return typeof value.id === 'string' && /^[a-f0-9-]{36}$/i.test(value.id)
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096
    && typeof value.identity.device === 'string' && value.identity.device.length <= 128
    && typeof value.identity.inode === 'string' && value.identity.inode.length <= 128
    && Number.isSafeInteger(value.firstOpenedAt) && (value.firstOpenedAt as number) >= 0
    && Number.isSafeInteger(value.lastOpenedAt) && (value.lastOpenedAt as number) >= 0
    && Array.isArray(value.previousPaths) && value.previousPaths.length <= 5
    && value.previousPaths.every((path) => typeof path === 'string' && path.length <= 4096)
    && typeof value.nativeTrustInvalidated === 'boolean'
}
function validData(value: unknown): value is RegistryData {
  return isPlainRecord(value) && anchored(value, knownRoot) && value.schemaVersion === 1
    && Array.isArray(value.workspaces) && value.workspaces.length <= 50 && value.workspaces.every(validRecord)
}
function jsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  const safe = Array.isArray(value) ? value.every((item) => jsonSafe(item, seen))
    : isPlainRecord(value) && Object.values(value).every((item) => jsonSafe(item, seen))
  seen.delete(value)
  return safe
}

export class NativeWorkspaceRegistry {
  readonly filePath: string
  private data: RegistryData = { schemaVersion: 1, workspaces: [] }
  private failed?: NativeWorkspaceRegistryError
  private loaded = false
  constructor(filePath: string) { this.filePath = resolve(filePath) }
  all(): StoredWorkspace[] { return [...this.read().workspaces] }
  find(pathOrId: string): StoredWorkspace | undefined {
    return this.read().workspaces.find((record) => record.id === pathOrId || record.path === pathOrId)
  }
  record(folderPath: string): StoredWorkspace | undefined {
    const current = readWorkspaceIdentity(folderPath)
    if (!current.ok) return undefined
    const records = this.read().workspaces
    const atPath = records.find((record) => record.path === current.canonicalPath)
    if (atPath) return sameIdentity(atPath.identity, current.identity) ? atPath : undefined
    // A moved folder keeps its ID only when device and inode match; prepareRecord is only called on a miss.
    return records.find((record) => sameIdentity(record.identity, current.identity))
  }
  prepareRecord(canonicalPath: string, identity: StoredWorkspace['identity']): StoredWorkspace {
    const now = Date.now()
    const record: StoredWorkspace = { id: randomUUID(), path: canonicalPath, identity,
      firstOpenedAt: now, lastOpenedAt: now, previousPaths: [], nativeTrustInvalidated: false }
    this.write([record])
    return record
  }
  info(folderPath: string): NativeWorkspaceInfo {
    const current = readWorkspaceIdentity(folderPath)
    const record = current.ok
      ? this.record(folderPath)
      : this.read().workspaces.find((item) => item.path === folderPath || item.previousPaths.includes(folderPath))
    if (!current.ok) {
      const storedPath = record && current.status === 'missing' && record.path !== folderPath
        ? readWorkspaceIdentity(record.path) : undefined
      const moved = !!record && storedPath?.ok === true
        && sameIdentity(record.identity, storedPath.identity)
      return {
        id: record?.id ?? null, canonicalPath: null, matchesStoredIdentity: false,
        moved, missing: current.status === 'missing', status: current.status,
      }
    }
    const matchesStoredIdentity = !!record && record.path === current.canonicalPath
      && sameIdentity(record.identity, current.identity)
    const moved = !!record && !matchesStoredIdentity
    return {
      id: record?.id ?? null, canonicalPath: current.canonicalPath, matchesStoredIdentity, moved,
      missing: false, status: moved ? 'moved' : 'available',
    }
  }
  read(): RegistryData {
    if (this.failed) throw this.failed
    if (this.loaded) return this.data
    let text: string
    try {
      try { if (lstatSync(this.filePath).isSymbolicLink()) throw new Error() }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.loaded = true; return this.data }
        throw error
      }
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      this.failed = new NativeWorkspaceRegistryError('read-failure', this.filePath)
      throw this.failed
    }
    this.loaded = true
    try {
      let parsed: unknown
      try { parsed = JSON.parse(text) }
      catch { throw new NativeWorkspaceRegistryError('parse-failure', this.filePath) }
      if (!validData(parsed)) throw new NativeWorkspaceRegistryError('validation-failure', this.filePath)
      this.data = parsed
      return this.data
    } catch (error) {
      this.failed = error instanceof NativeWorkspaceRegistryError ? error
        : new NativeWorkspaceRegistryError('validation-failure', this.filePath)
      throw this.failed
    }
  }
  write(records: readonly StoredWorkspace[], targetPath = this.filePath): void {
    const target = resolve(targetPath), directory = dirname(this.filePath)
    if (target !== this.filePath || dirname(target) !== directory || !target.startsWith(`${directory}${sep}`)) {
      throw new NativeWorkspaceRegistryError('write-unsafe', target)
    }
    const current = this.read()
    if (!Array.isArray(records) || records.some((record) => !validRecord(record))) {
      throw new NativeWorkspaceRegistryError('validation-failure', target)
    }
    const merged = current.workspaces.map((record) => {
      const update = records.find((candidate) => candidate.id === record.id)
      return update ? { ...record, ...update, nativeTrustInvalidated: record.nativeTrustInvalidated } : record
    })
    for (const record of records) if (!merged.some((item) => item.id === record.id)) merged.push(record)
    if (merged.length > 50) throw new NativeWorkspaceRegistryError('write-unsafe', target)
    const next = { ...current, schemaVersion: 1 as const, workspaces: merged }
    if (!jsonSafe(next)) throw new NativeWorkspaceRegistryError('write-unsafe', target)
    let text: string | undefined
    try { text = JSON.stringify(next, null, 2) } catch { throw new NativeWorkspaceRegistryError('write-unsafe', target) }
    if (typeof text !== 'string') throw new NativeWorkspaceRegistryError('write-unsafe', target)
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      try { if (lstatSync(target).isSymbolicLink()) throw new Error() }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      writeFileSync(temporary, `${text}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      renameSync(temporary, target)
      this.data = next
    } catch { throw new NativeWorkspaceRegistryError('write-unsafe', target) }
    finally { rmSync(temporary, { force: true }) }
  }
}
