import { Buffer } from 'node:buffer'
import { constants, lstatSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, SaveDialogOptions, SaveDialogReturnValue } from 'electron'
import type { Stats } from 'node:fs'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'
import { canonicalFileWithinRoot } from './window-policy.ts'
import {
  attachmentTypeForName,
  CONTENT_LIMITS,
  getBase64ByteLength,
  isSafeExportName,
  type AttachmentReadResponse,
  type ExportWriteResponse,
} from '../../shared/content.ts'
import {
  isSafeTextAttachmentBytes,
  sniffAttachmentMime,
} from './content-policy.ts'

export interface PrivilegedFileServiceOptions {
  readonly showSaveDialog: (
    window: BrowserWindow,
    options: SaveDialogOptions,
  ) => Promise<SaveDialogReturnValue>
  readonly getWindow: (caller: AuthorizedIpcCaller) => BrowserWindow | null
  readonly isCallerActive: (caller: AuthorizedIpcCaller) => boolean
  /** Must be an app-owned temporary directory, not a renderer-provided path. */
  readonly tempRoot: string
  /** Registers app-shutdown cleanup for every managed temporary file. */
  readonly registerTempCleanup: (cleanup: () => void) => void
}

const MAX_PATH_LENGTH = CONTENT_LIMITS.pathCharacters

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.isFile()
    && right.isFile()
}

function isActiveWindow(window: BrowserWindow | null, caller: AuthorizedIpcCaller): window is BrowserWindow {
  try {
    return !!window
      && !window.isDestroyed()
      && window.id === caller.windowId
      && window.webContents.id === caller.webContentsId
      && !window.webContents.isDestroyed()
  } catch {
    return false
  }
}

function validateSelectedPath(path: string): string | null {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes('\0') || !isAbsolute(path)) return null
  try {
    const selected = resolve(path)
    const selectedName = basename(selected)
    if (!selectedName || selectedName === '.' || selectedName === '..') return null
    const canonicalParent = realpathSync(dirname(selected))
    if (!statSync(canonicalParent).isDirectory()) return null
    const target = join(canonicalParent, selectedName)
    if (target.length > MAX_PATH_LENGTH) return null

    // Canonicalize any existing target. Symlinks are never followed for an export.
    try {
      const targetStat = lstatSync(target)
      if (targetStat.isSymbolicLink() || (!targetStat.isFile() && !targetStat.isDirectory())) return null
      if (targetStat.isDirectory()) return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    return target
  } catch {
    return null
  }
}

/**
 * Main-process-only file operations. Renderer paths can only select files canonically
 * contained by the supplied workspace; export paths are obtained from a native dialog.
 */
export class PrivilegedFileService {
  constructor(private readonly options: PrivilegedFileServiceOptions) {}

  async readAttachment(workspacePath: string, relativeOrAbsPath: string): Promise<AttachmentReadResponse> {
    if (workspacePath.length === 0 || workspacePath.length > MAX_PATH_LENGTH || workspacePath.includes('\0')
      || relativeOrAbsPath.length === 0 || relativeOrAbsPath.length > MAX_PATH_LENGTH
      || relativeOrAbsPath.includes('\0')) {
      throw new Error('Attachment is unavailable.')
    }

    let canonicalRoot: string
    let candidate: string
    try {
      canonicalRoot = realpathSync(workspacePath)
      if (!statSync(canonicalRoot).isDirectory()) throw new Error('invalid workspace')
      if (relativeOrAbsPath.split(/[\\/]/).some((part) => part === '..')) throw new Error('invalid path')
      candidate = isAbsolute(relativeOrAbsPath)
        ? relativeOrAbsPath
        : resolve(canonicalRoot, relativeOrAbsPath)
    } catch {
      throw new Error('Attachment is unavailable.')
    }

    const canonicalPath = canonicalFileWithinRoot(candidate, canonicalRoot)
    if (!canonicalPath || canonicalPath.length > MAX_PATH_LENGTH) throw new Error('Attachment is unavailable.')

    let initialStat: Stats
    try {
      initialStat = statSync(canonicalPath)
      if (!initialStat.isFile()
        || !Number.isSafeInteger(initialStat.size)
        || initialStat.size < 0
        || initialStat.size > CONTENT_LIMITS.attachmentBytes) {
        throw new Error('invalid file')
      }
    } catch {
      throw new Error('Attachment is unavailable.')
    }

    const extensionInfo = attachmentTypeForName(basename(canonicalPath))
    if (!extensionInfo) throw new Error('Attachment is unavailable.')

    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const noFollow = constants.O_NOFOLLOW ?? 0
      handle = await open(canonicalPath, constants.O_RDONLY | noFollow)
      const openedStat = await handle.stat()
      const pathStat = statSync(canonicalPath)
      if (!sameFile(initialStat, openedStat) || !sameFile(openedStat, pathStat)
        || realpathSync(canonicalPath) !== canonicalPath
        || openedStat.size > CONTENT_LIMITS.attachmentBytes) {
        throw new Error('changed file')
      }

      const bytes = Buffer.alloc(openedStat.size)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (bytesRead <= 0) throw new Error('short read')
        offset += bytesRead
      }

      const finalStat = await handle.stat()
      const finalPathStat = statSync(canonicalPath)
      if (!sameFile(openedStat, finalStat) || !sameFile(finalStat, finalPathStat)) {
        throw new Error('changed file')
      }

      let mime: string
      const sniffedMime = sniffAttachmentMime(bytes)
      if (extensionInfo.category === 'image') {
        if (!sniffedMime?.startsWith('image/')) throw new Error('invalid image')
        mime = sniffedMime
      } else if (extensionInfo.category === 'pdf') {
        if (sniffedMime !== 'application/pdf') throw new Error('invalid pdf')
        mime = 'application/pdf'
      } else {
        if (sniffedMime !== null || !isSafeTextAttachmentBytes(bytes)) throw new Error('invalid text')
        // Keep source and markup inert when handed to renderer preview components.
        mime = extensionInfo.mime
      }

      const bytesBase64 = bytes.toString('base64')
      if (bytesBase64.length > CONTENT_LIMITS.attachmentBase64Characters) throw new Error('oversized data')
      return {
        name: basename(canonicalPath),
        mime,
        bytesBase64,
        byteLength: bytes.byteLength,
      }
    } catch {
      throw new Error('Attachment is unavailable.')
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async writeExport(
    caller: AuthorizedIpcCaller,
    suggestedName: string,
    bytesBase64: string,
  ): Promise<ExportWriteResponse> {
    const byteLength = getBase64ByteLength(bytesBase64)
    if (!isSafeExportName(suggestedName)
      || byteLength === null
      || byteLength > CONTENT_LIMITS.attachmentBytes) {
      throw new Error('Export request is invalid.')
    }
    const bytes = Buffer.from(bytesBase64, 'base64')
    if (bytes.byteLength !== byteLength) throw new Error('Export request is invalid.')

    let window: BrowserWindow | null
    try {
      window = this.options.getWindow(caller)
      if (!isActiveWindow(window, caller) || !this.options.isCallerActive(caller)) return { path: null }
      const selection = await this.options.showSaveDialog(window, {
        title: 'Save export',
        buttonLabel: 'Save',
        defaultPath: suggestedName,
      })
      const currentWindow = this.options.getWindow(caller)
      if (selection.canceled
        || !selection.filePath
        || currentWindow !== window
        || !isActiveWindow(window, caller)
        || !this.options.isCallerActive(caller)) return { path: null }

      const target = validateSelectedPath(selection.filePath)
      if (!target) return { path: null }
      await this.writeAtomically(target, bytes)
      return { path: target }
    } catch {
      throw new Error('Export could not be saved.')
    }
  }

  /** Creates a short-lived file only inside the preconfigured, app-owned temp root. */
  async createManagedTempFile(
    bytes: Uint8Array,
    extension = '.tmp',
  ): Promise<{ readonly path: string; readonly cleanup: () => void }> {
    if (bytes.byteLength > CONTENT_LIMITS.attachmentBytes
      || !/^\.[a-z0-9]{1,12}$/i.test(extension)) {
      throw new Error('Temporary file request is invalid.')
    }

    let root: string
    try {
      if (!isAbsolute(this.options.tempRoot) || this.options.tempRoot.length > MAX_PATH_LENGTH) throw new Error('invalid root')
      root = realpathSync(this.options.tempRoot)
      if (!statSync(root).isDirectory()) throw new Error('invalid root')
    } catch {
      throw new Error('Temporary storage is unavailable.')
    }

    const target = join(root, `pi-managed-${randomUUID()}${extension.toLowerCase()}`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      await handle.writeFile(bytes)
      await handle.sync()
      const createdStat = await handle.stat()
      if (!createdStat.isFile() || createdStat.size !== bytes.byteLength) throw new Error('incomplete temp file')
      await handle.close()
      handle = undefined

      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) return
        cleaned = true
        try {
          unlinkSync(target)
        } catch {
          // Shutdown cleanup is best-effort and intentionally hides filesystem details.
        }
      }
      try {
        this.options.registerTempCleanup(cleanup)
      } catch {
        cleanup()
        throw new Error('cleanup registration failed')
      }
      return { path: target, cleanup }
    } catch {
      await handle?.close().catch(() => undefined)
      try {
        await unlink(target)
      } catch {
        // Remove partial output on failure where possible.
      }
      throw new Error('Temporary file could not be created.')
    }
  }

  private async writeAtomically(target: string, bytes: Buffer): Promise<void> {
    const directory = dirname(target)
    const temporary = join(directory, `.pi-export-${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, target)
    } catch {
      await handle?.close().catch(() => undefined)
      try {
        await unlink(temporary)
      } catch {
        // The atomic-save temporary may already have been renamed or removed.
      }
      throw new Error('Export could not be saved.')
    }
  }
}
