import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserWindow, Session } from 'electron'

export type RendererPolicy =
  | { readonly mode: 'production'; readonly rendererPath: string }
  | { readonly mode: 'development'; readonly rendererUrl: string }

export function isAllowedRendererUrl(candidate: string, policy: RendererPolicy): boolean {
  try {
    const target = new URL(candidate)
    if (target.username || target.password || target.search || target.hash) return false

    if (policy.mode === 'development') {
      const expected = new URL(policy.rendererUrl)
      const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
      return (expected.protocol === 'http:' || expected.protocol === 'https:')
        && loopbackHosts.has(expected.hostname)
        && target.origin === expected.origin
        && (target.protocol === 'http:' || target.protocol === 'https:')
    }

    if (target.protocol !== 'file:' || target.search || target.hash) return false
    const candidatePath = fileURLToPath(target)
    const canonicalCandidate = realpathSync(candidatePath)
    const canonicalExpected = realpathSync(policy.rendererPath)
    // Only the canonical path itself is trusted; aliases and symlinks are not renderer entrypoints.
    return resolve(candidatePath) === resolve(policy.rendererPath)
      && canonicalCandidate === canonicalExpected
  } catch {
    return false
  }
}

export function isTrustedMainFrame(
  candidate: string,
  isMainFrame: boolean,
  policy: RendererPolicy,
): boolean {
  return isMainFrame && isAllowedRendererUrl(candidate, policy)
}

/**
 * Resolve an existing file to its canonical path under an allowed root.
 * Callers must use the returned canonical path for the eventual operation.
 */
export function canonicalFileWithinRoot(candidate: string, allowedRoot: string): string | null {
  if (!isAbsolute(candidate) || candidate.includes('\0')) return null
  if (candidate.split(/[\\/]/).some((part) => part === '..')) return null

  try {
    const lexicalRoot = resolve(allowedRoot)
    const lexicalCandidate = resolve(candidate)
    const lexicalRelative = relative(lexicalRoot, lexicalCandidate)
    if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
      return null
    }

    const canonicalRoot = realpathSync(allowedRoot)
    const canonicalCandidate = realpathSync(candidate)
    const canonicalRelative = relative(canonicalRoot, canonicalCandidate)
    if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) {
      return null
    }
    return canonicalCandidate
  } catch {
    return null
  }
}

export function buildContentSecurityPolicy(policy: RendererPolicy): string {
  const connectSources = ["'self'"]
  if (policy.mode === 'development') {
    try {
      const renderer = new URL(policy.rendererUrl)
      const websocketProtocol = renderer.protocol === 'https:' ? 'wss:' : 'ws:'
      connectSources.push(`${websocketProtocol}//${renderer.host}`)
    } catch {
      // Invalid dev URLs are rejected by the navigation policy; CSP remains restrictive.
    }
  }

  // Vite's dev server injects an inline module preamble for @vitejs/plugin-react (HMR); production bundles carry no inline scripts.
  const scriptSources = policy.mode === 'development' ? ["'self'", "'unsafe-inline'"] : ["'self'"]
  const styleSources = policy.mode === 'development' ? ["'self'", "'unsafe-inline'"] : ["'self'"]
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    `style-src ${styleSources.join(' ')}`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export function installSessionSecurityPolicy(session: Session, policy: RendererPolicy): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)

  const csp = buildContentSecurityPolicy(policy)
  session.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame' || !isAllowedRendererUrl(details.url, policy)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }

    const headers = Object.fromEntries(
      Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== 'content-security-policy'),
    )
    callback({ responseHeaders: { ...headers, 'Content-Security-Policy': [csp] } })
  })
}

export function installWindowSecurityPolicy(window: BrowserWindow, policy: RendererPolicy): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererUrl(url, policy)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedRendererUrl(url, policy)) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
}
