import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import {
  NATIVE_CONFIG_MAX_BYTES,
  type NativeConfigFile,
  type NativeConfigListResult,
  type NativeConfigReadResult,
  type NativeConfigWriteResult,
} from '../../shared/native-config.ts'

type Entry = {
  readonly id: string
  readonly scope: 'user' | 'project'
  readonly group: 'pi' | 'extension'
  readonly label: string
  readonly relative: string
  readonly sensitive: boolean
}

const entry = (scope: Entry['scope'], group: Entry['group'], relative: string, label: string, sensitive = false): Entry =>
  ({ id: `${scope}:${relative}`, scope, group, label, relative, sensitive })

// Fixed allowlist. The renderer only ever sends ids; paths are never accepted from it.
const ENTRIES: readonly Entry[] = [
  entry('user', 'pi', 'settings.json', 'Pi settings'),
  entry('user', 'pi', 'models.json', 'Pi models', true),
  entry('user', 'pi', 'mcp.json', 'MCP servers', true),
  entry('user', 'pi', 'optimizer.json', 'Optimizer'),
  entry('user', 'pi', 'pix.json', 'Pix'),
  entry('user', 'pi', 'pix-gate.json', 'Pix gate'),
  entry('user', 'pi', 'provider-failover.json', 'Provider failover'),
  entry('user', 'extension', 'pretty-tui.json', 'pi-pretty'),
  entry('user', 'extension', 'herdr-agents/config.json', 'pi-herdr-agents'),
  entry('project', 'pi', 'settings.json', 'Project Pi settings'),
  entry('project', 'extension', 'subagents.json', '@tintinweb/pi-subagents'),
]
// Defense in depth: nothing credential-like can ever be exposed, even if the allowlist is edited carelessly.
const FORBIDDEN = /auth|oauth|token|secret|trust/i

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export class NativeConfigFiles {
  /** activeWorkspacePath returns the active workspace cwd, or null when none is active. */
  constructor(
    private readonly activeWorkspacePath: () => string | null,
    private readonly userBase: string = join(homedir(), '.pi', 'agent'),
  ) {}

  private baseFor(item: Entry): string | null {
    if (item.scope === 'user') return this.userBase
    const cwd = this.activeWorkspacePath()
    return cwd ? join(cwd, '.pi') : null
  }

  // Resolves an allowlisted id to a path confined to its base directory, or null.
  private resolve(id: string): { item: Entry; base: string; path: string } | null {
    const item = ENTRIES.find((candidate) => candidate.id === id)
    if (!item || FORBIDDEN.test(item.relative)) return null
    const base = this.baseFor(item)
    if (!base) return null
    const path = join(base, item.relative)
    if (!this.confined(base, path)) return null
    return { item, base, path }
  }

  private confined(base: string, path: string): boolean {
    try {
      // Nearest existing ancestor of the file must resolve inside the (resolved) base.
      let parent = dirname(path)
      while (!existsSync(parent)) {
        const next = dirname(parent)
        if (next === parent) return false
        parent = next
      }
      const realParent = realpathSync(parent)
      let realBase: string
      try { realBase = realpathSync(base) } catch { realBase = join(realpathSync(dirname(base)), base.slice(dirname(base).length + 1)) }
      if (existsSync(base) ? !(realParent === realBase || realParent.startsWith(realBase + sep)) : realParent !== dirname(realBase) && !realParent.startsWith(dirname(realBase) + sep)) return false
      try {
        const stat = lstatSync(path)
        if (stat.isSymbolicLink()) {
          const target = realpathSync(path)
          if (!(target === realBase || target.startsWith(realBase + sep))) return false
        }
        if (!stat.isFile() && !stat.isSymbolicLink()) return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      }
      return true
    } catch { return false }
  }

  list(): NativeConfigListResult {
    const files: NativeConfigFile[] = []
    for (const item of ENTRIES) {
      const resolved = this.resolve(item.id)
      if (!resolved) continue
      files.push({
        id: item.id, scope: item.scope, group: item.group, label: item.label, path: resolved.path,
        exists: existsSync(resolved.path), sensitive: item.sensitive,
      })
    }
    return { files }
  }

  private readBytes(path: string): Buffer | null {
    let descriptor: number
    try { descriptor = openSync(path, 'r') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const stat = fstatSync(descriptor)
      if (!stat.isFile()) throw new Error('Not a regular file.')
      if (stat.size > NATIVE_CONFIG_MAX_BYTES) throw new Error('File is larger than 2 MiB.')
      const buffer = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < buffer.length) {
        const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset)
        if (count === 0) break
        offset += count
      }
      return buffer.subarray(0, offset)
    } finally { closeSync(descriptor) }
  }

  read(id: string): NativeConfigReadResult {
    const resolved = this.resolve(id)
    if (!resolved) throw new Error('That configuration file is not available.')
    const bytes = this.readBytes(resolved.path)
    if (!bytes) return { id, text: '', revision: '', exists: false }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
      throw new Error('The file is not valid UTF-8 and cannot be edited here.')
    }
    return { id, text, revision: sha256(bytes), exists: true }
  }

  write(id: string, text: string, expectedRevision: string): NativeConfigWriteResult {
    const rejected = (reason: string): NativeConfigWriteResult => ({ outcome: 'rejected', revision: null, reason })
    const resolved = this.resolve(id)
    if (!resolved) return rejected('That configuration file is not available.')
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length > NATIVE_CONFIG_MAX_BYTES) return rejected('Content is larger than 2 MiB.')
    try { JSON.parse(text) } catch (error) {
      return { outcome: 'invalid', revision: null, reason: error instanceof Error ? error.message : 'Invalid JSON.' }
    }
    let current: Buffer | null
    try { current = this.readBytes(resolved.path) } catch (error) {
      return rejected(error instanceof Error ? error.message : 'The current file could not be read.')
    }
    const currentRevision = current ? sha256(current) : ''
    if (currentRevision !== expectedRevision) {
      return { outcome: 'conflict', revision: currentRevision, reason: 'The file changed on disk since it was loaded.' }
    }
    const directory = dirname(resolved.path)
    let temporary: string | undefined
    let descriptor: number | undefined
    try {
      let mode = resolved.item.sensitive ? 0o600 : 0o644
      if (current) mode = lstatSync(resolved.path).mode & 0o777
      mkdirSync(directory, { recursive: true })
      // Re-check confinement now that the directory exists.
      if (!this.confined(resolved.base, resolved.path)) return rejected('That configuration file is not available.')
      temporary = join(directory, `.${randomUUID()}.native-config.tmp`)
      descriptor = openSync(temporary, 'wx', mode)
      let offset = 0
      while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, resolved.path)
      temporary = undefined
      try {
        const directoryDescriptor = openSync(directory, 'r')
        try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
      } catch { /* Directory fsync is not supported everywhere; the file itself was synced and renamed. */ }
      return { outcome: 'saved', revision: sha256(bytes), reason: null }
    } catch (error) {
      return rejected(error instanceof Error ? error.message : 'The file could not be written.')
    } finally {
      if (descriptor !== undefined) try { closeSync(descriptor) } catch {}
      if (temporary) try { unlinkSync(temporary) } catch {}
    }
  }
}
