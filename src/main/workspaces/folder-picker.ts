import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type {
  BrowserWindow,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from 'electron'
import type { AuthorizedIpcCaller } from '../ipc/register.ts'
import type { WorkspaceFolderPickerResult } from '../../shared/workspaces.ts'

const MAX_SELECTED_PATH_LENGTH = 4096

export interface NativeFolderPickerOptions {
  readonly showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions,
  ) => Promise<OpenDialogReturnValue>
  readonly getWindow: (caller: AuthorizedIpcCaller) => BrowserWindow | null
  readonly isCallerActive: (caller: AuthorizedIpcCaller) => boolean
}

export type WorkspaceFolderPicker = (
  caller: AuthorizedIpcCaller,
) => Promise<WorkspaceFolderPickerResult>

function canonicalExistingDirectory(path: string): string | null {
  if (path.length === 0 || path.length > MAX_SELECTED_PATH_LENGTH || path.includes('\0') || !isAbsolute(path)) {
    return null
  }

  try {
    const canonicalPath = realpathSync(path)
    if (canonicalPath.length > MAX_SELECTED_PATH_LENGTH || !statSync(canonicalPath).isDirectory()) return null
    return canonicalPath
  } catch {
    return null
  }
}

/** Creates an existing-directory picker bound to the exact authenticated Electron window. */
export function createNativeFolderPicker(options: NativeFolderPickerOptions): WorkspaceFolderPicker {
  return async (caller) => {
    let window: BrowserWindow | null
    try {
      window = options.getWindow(caller)
      if (!window
        || window.isDestroyed()
        || window.id !== caller.windowId
        || window.webContents.id !== caller.webContentsId
        || window.webContents.isDestroyed()
        || !options.isCallerActive(caller)) {
        return { path: null }
      }

      const selection = await options.showOpenDialog(window, { properties: ['openDirectory'] })
      const currentWindow = options.getWindow(caller)
      if (selection.canceled
        || selection.filePaths.length !== 1
        || currentWindow !== window
        || window.isDestroyed()
        || window.webContents.isDestroyed()
        || !options.isCallerActive(caller)) {
        return { path: null }
      }

      return { path: canonicalExistingDirectory(selection.filePaths[0] ?? '') }
    } catch {
      return { path: null }
    }
  }
}
