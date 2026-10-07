import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { join } from 'node:path'
import type { AuthorizedIpcCaller } from './ipc/register.ts'
import { AppPreferencesStore } from './config/app-preferences.ts'
import { pruneStagedAttachments } from './ipc/staged-attachments.ts'
import { createNativeMainComposition } from './native-compose.ts'
import { installSessionSecurityPolicy, installWindowSecurityPolicy, isTrustedMainFrame, type RendererPolicy } from './security/window-policy.ts'

declare const __APP_NAME__: string

app.setName(__APP_NAME__)

const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
const productionRenderer = join(app.getAppPath(), 'out', 'renderer', 'index.html')
const rendererPolicy: RendererPolicy = !app.isPackaged && rendererDevUrl
  ? { mode: 'development', rendererUrl: rendererDevUrl }
  : { mode: 'production', rendererPath: productionRenderer }
const bundledPreload = join(app.getAppPath(), 'out', 'preload', 'index.cjs')
const activeWindows = new Map<number, BrowserWindow>()
let composition: ReturnType<typeof createNativeMainComposition> | undefined
let piShutdownStarted = false

function authorizeCaller(event: Electron.IpcMainInvokeEvent): AuthorizedIpcCaller | null {
  try {
    const frame = event.senderFrame
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!frame || !window || window.isDestroyed() || frame !== event.sender.mainFrame) return null
    if (!isTrustedMainFrame(frame.url, frame === event.sender.mainFrame, rendererPolicy)) return null
    if (activeWindows.get(event.sender.id) !== window || event.sender.isDestroyed()) return null
    return { windowId: window.id, webContentsId: event.sender.id, frameUrl: frame.url }
  } catch {
    return null
  }
}

function isCallerActive(caller: AuthorizedIpcCaller): boolean {
  const window = activeWindows.get(caller.webContentsId)
  return !!window && !window.isDestroyed()
    && !window.webContents.isDestroyed()
    && window.id === caller.windowId
    && isTrustedMainFrame(window.webContents.mainFrame.url, true, rendererPolicy)
}

app.on('before-quit', (event) => {
  if (piShutdownStarted) return
  if (!composition) return
  event.preventDefault()
  piShutdownStarted = true
  void composition.dispose()
    .catch((error: unknown) => console.error('Failed to dispose the native Pi host cleanly', error))
    .finally(() => app.quit())
})

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    show: false,
    webPreferences: {
      preload: bundledPreload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  })

  const webContentsId = window.webContents.id
  activeWindows.set(webContentsId, window)
  window.once('closed', () => {
    composition?.disposeCaller(webContentsId)
    activeWindows.delete(webContentsId)
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      composition?.disposeCaller(webContentsId)
      void composition?.workspaces.cancel().catch((error: unknown) => console.error('Failed to cancel the workspace after navigation', error))
    }
  })
  window.webContents.on('render-process-gone', () => {
    composition?.disposeCaller(webContentsId)
    void composition?.workspaces.cancel().catch((error: unknown) => console.error('Failed to cancel the workspace after renderer exit', error))
  })
  installWindowSecurityPolicy(window, rendererPolicy)

  if (!app.isPackaged && rendererDevUrl) {
    await window.loadURL(rendererDevUrl)
  } else {
    await window.loadFile(productionRenderer)
  }

  return window
}

app.whenReady().then(async () => {
  void pruneStagedAttachments()
  installSessionSecurityPolicy(session.defaultSession, rendererPolicy)
  const appPreferencesStore = new AppPreferencesStore(join(app.getPath('userData'), 'app-preferences.json'))
  composition = createNativeMainComposition({
    appPreferences: appPreferencesStore,
    ipcMain,
    authorizeCaller,
    isCallerActive,
    getWindow: (caller) => {
      const window = activeWindows.get(caller.webContentsId)
      return window?.id === caller.windowId ? window : null
    },
    showOpenDialog: (window, options) => dialog.showOpenDialog(window, options),
  })
  void createMainWindow().catch((error: unknown) => {
    console.error('Failed to open the renderer window', error)
    app.exit(1)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow().catch((error: unknown) => {
        console.error('Failed to reopen the renderer window', error)
      })
    }
  })
}).catch((error: unknown) => {
  console.error('Failed to start the desktop application', error)
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
