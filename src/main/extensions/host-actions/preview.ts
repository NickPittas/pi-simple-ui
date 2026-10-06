import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { RuntimeScope } from '../../../shared/ipc-contracts.ts'
import {
  HOST_ACTIONS,
  HOST_ACTION_LIMITS,
  isEmptyHostActionRequest,
  isPreviewBrowserOpenRequest,
  isPreviewBrowserOpenResponse,
  isPreviewCacheClearResponse,
  isPreviewMarkdownRenderRequest,
  isPreviewMarkdownRenderResponse,
  isPreviewPdfExportRequest,
  isPreviewPdfExportResponse,
  type EmptyHostActionRequest,
  type PreviewBrowserOpenRequest,
  type PreviewBrowserOpenResponse,
  type PreviewCacheClearResponse,
  type PreviewMarkdownRenderRequest,
  type PreviewMarkdownRenderResponse,
  type PreviewPdfExportRequest,
  type PreviewPdfExportResponse,
} from '../../../shared/host-actions.ts'
import type { AuthorizedIpcCaller, CapabilityDefinition } from '../../ipc/register.ts'

const MAX_ACTIVE_PREVIEWS = 32
const PREVIEW_TTL_MS = 30 * 60 * 1000

export interface PreviewPdfRuntimeBridge {
  /** Parent adapter routes this to the installed extension's local Pandoc/LaTeX PDF renderer. */
  exportPdf(caller: AuthorizedIpcCaller, scope: RuntimeScope, markdown: string): Promise<boolean> | boolean
}

/** Optional native-renderer bridge; absent means the PDF action is honestly reported as a seam. */
export interface PreviewPdfRequiresRuntimeBridgeAccessor {
  resolve(caller: AuthorizedIpcCaller, scope: RuntimeScope): PreviewPdfRuntimeBridge | null
}

export interface PreviewShellOpenRequest {
  readonly caller: AuthorizedIpcCaller
  readonly scope: RuntimeScope
  readonly filePath: string
  readonly userInitiated: true
}

/** Parent wiring should use Electron's shell.openPath; never accepts a command or arbitrary target. */
export interface PreviewShellOpenService {
  openLocalFile(request: PreviewShellOpenRequest): Promise<boolean>
}

export interface PreviewHostActionOptions {
  readonly authorizeRuntimeCaller: (caller: AuthorizedIpcCaller, scope: RuntimeScope) => boolean
  readonly shellOpen?: PreviewShellOpenService
  readonly nativePdf?: PreviewPdfRequiresRuntimeBridgeAccessor
}

interface StoredPreview {
  readonly id: string
  readonly caller: AuthorizedIpcCaller
  readonly scope: RuntimeScope
  readonly path: string
  readonly createdAt: number
}

function getPreviewCacheDir(environment: NodeJS.ProcessEnv = process.env, homeDirectory = homedir()): string {
  const configured = environment.PI_CODING_AGENT_DIR
  if (!configured) return join(homeDirectory, '.pi', 'cache', 'markdown-preview')
  const expanded = configured === '~'
    ? homeDirectory
    : configured.startsWith('~/') || configured.startsWith('~\\')
      ? join(homeDirectory, configured.slice(2))
      : configured
  return resolve(expanded, 'cache', 'markdown-preview')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!)
}

/** The renderer mirrors SafeMarkdown's inert subset: raw HTML and clickable links are never emitted. */
function renderInline(source: string, depth = 0): string {
  if (depth > 8) return escapeHtml(source)
  const pattern = /(`[^`\n]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_|!?\[[^\]]*\]\([^\s)]+(?:\s+"[^"]*")?\))/g
  let cursor = 0
  let output = ''
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    output += escapeHtml(source.slice(cursor, match.index))
    const token = match[0]
    if (token.startsWith('`')) output += `<code>${escapeHtml(token.slice(1, -1))}</code>`
    else if (token.startsWith('**') || token.startsWith('__')) output += `<strong>${renderInline(token.slice(2, -2), depth + 1)}</strong>`
    else if (token.startsWith('~~')) output += `<del>${renderInline(token.slice(2, -2), depth + 1)}</del>`
    else if (token.startsWith('*') || token.startsWith('_')) output += `<em>${renderInline(token.slice(1, -1), depth + 1)}</em>`
    else {
      const link = /^!?\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)$/.exec(token)
      // SafeMarkdown only makes links interactive when a click callback exists. This preview has none.
      output += link ? renderInline(link[1], depth + 1) : escapeHtml(token)
    }
    cursor = pattern.lastIndex
  }
  return output + escapeHtml(source.slice(cursor))
}

function renderBlocks(source: string, depth = 0): string {
  if (depth > 8) return `<pre>${escapeHtml(source)}</pre>`
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (!line.trim()) { index++; continue }
    const fence = /^\s*(```+|~~~+)\s*([\w.+-]*)\s*$/.exec(line)
    if (fence) {
      index++
      const body: string[] = []
      const closer = new RegExp(`^\\s*${fence[1]![0]}{${fence[1]!.length},}\\s*$`)
      while (index < lines.length && !closer.test(lines[index]!)) body.push(lines[index++]!)
      if (index < lines.length) index++
      blocks.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      blocks.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`)
      index++
      continue
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { blocks.push('<hr>'); index++; continue }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index]!)) quote.push(lines[index++]!.replace(/^\s*>\s?/, ''))
      blocks.push(`<blockquote>${renderBlocks(quote.join('\n'), depth + 1)}</blockquote>`)
      continue
    }
    const list = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(line)
    if (list) {
      const ordered = Boolean(list[2])
      const entries: string[] = []
      while (index < lines.length) {
        const entry = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(lines[index]!)
        if (!entry || Boolean(entry[2]) !== ordered) break
        entries.push(`<li>${renderInline(entry[3]!)}</li>`)
        index++
      }
      const tag = ordered ? 'ol' : 'ul'
      blocks.push(`<${tag}>${entries.join('')}</${tag}>`)
      continue
    }
    if (index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]!)) {
      const cells = (value: string) => value.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
      const headers = cells(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim()) rows.push(cells(lines[index++]!))
      blocks.push(`<table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, column) => `<td>${renderInline(row[column] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    const paragraph = [line]
    index++
    while (index < lines.length && lines[index]!.trim()
      && !/^(#{1,6}\s|\s*(?:```|~~~)|\s*>|\s*(?:[-+*]|\d+[.)])\s+|\s*(?:---+|\*\*\*+|___+)\s*$)/.test(lines[index]!)) {
      paragraph.push(lines[index++]!)
    }
    blocks.push(`<p>${paragraph.map((part, lineNumber) => `${lineNumber > 0 ? '<br>' : ''}${renderInline(part)}`).join('')}</p>`)
  }
  return blocks.join('\n')
}

function buildPreviewHtml(markdown: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Markdown preview</title></head><body>${renderBlocks(markdown)}</body></html>`
}

function callerMatches(left: AuthorizedIpcCaller, right: AuthorizedIpcCaller): boolean {
  return left.windowId === right.windowId
    && left.webContentsId === right.webContentsId
    && left.frameUrl === right.frameUrl
}

function scopeMatches(left: RuntimeScope, right: RuntimeScope): boolean {
  return left.ownerId === right.ownerId && left.generation === right.generation
}

function isWithinDirectory(directory: string, path: string): boolean {
  const child = relative(directory, path)
  return child !== '' && !child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child)
}

function requireScope(
  authorizeRuntimeCaller: PreviewHostActionOptions['authorizeRuntimeCaller'],
  caller: AuthorizedIpcCaller,
  scope: RuntimeScope | undefined,
): RuntimeScope {
  if (!scope || !authorizeRuntimeCaller(caller, scope)) throw new Error('A current authorized runtime scope is required for preview actions.')
  return scope
}

/** Local SafeMarkdown-style render and scoped local-file handoff to a user-initiated shell opener. */
export function registerPreviewHostActions(options: PreviewHostActionOptions): readonly CapabilityDefinition<any, any>[] {
  const cacheDirectory = getPreviewCacheDir()
  const previews = new Map<string, StoredPreview>()

  const prunePreviews = async (): Promise<void> => {
    const cutoff = Date.now() - PREVIEW_TTL_MS
    for (const [id, preview] of previews) {
      if (preview.createdAt < cutoff) {
        previews.delete(id)
        await rm(preview.path, { force: true }).catch(() => undefined)
      }
    }
    while (previews.size >= MAX_ACTIVE_PREVIEWS) {
      const oldest = previews.values().next().value as StoredPreview | undefined
      if (!oldest) break
      previews.delete(oldest.id)
      await rm(oldest.path, { force: true }).catch(() => undefined)
    }
  }

  const render: CapabilityDefinition<PreviewMarkdownRenderRequest, PreviewMarkdownRenderResponse> = {
    id: HOST_ACTIONS.preview.markdownRender,
    scope: 'runtime',
    validateRequest: isPreviewMarkdownRenderRequest,
    validateResponse: isPreviewMarkdownRenderResponse,
    handle: async ({ caller, scope }, request) => {
      const runtimeScope = requireScope(options.authorizeRuntimeCaller, caller, scope)
      const html = buildPreviewHtml(request.markdown)
      if (Buffer.byteLength(html, 'utf8') > HOST_ACTION_LIMITS.previewHtmlBytes) {
        throw new Error('The rendered preview exceeds the local size limit.')
      }
      await prunePreviews()
      await mkdir(cacheDirectory, { recursive: true, mode: 0o700 })
      const previewId = randomUUID()
      const path = join(cacheDirectory, `${previewId}.html`)
      await writeFile(path, html, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      previews.set(previewId, { id: previewId, caller, scope: runtimeScope, path, createdAt: Date.now() })
      return { previewId, rendered: true }
    },
  }

  const openBrowser: CapabilityDefinition<PreviewBrowserOpenRequest, PreviewBrowserOpenResponse> = {
    id: HOST_ACTIONS.preview.browserOpen,
    scope: 'runtime',
    validateRequest: isPreviewBrowserOpenRequest,
    validateResponse: isPreviewBrowserOpenResponse,
    handle: async ({ caller, scope }, request) => {
      const runtimeScope = requireScope(options.authorizeRuntimeCaller, caller, scope)
      const preview = previews.get(request.previewId)
      if (!preview || !callerMatches(preview.caller, caller) || !scopeMatches(preview.scope, runtimeScope)) {
        return { opened: false, status: 'failed' }
      }
      if (!options.shellOpen) return { opened: false, status: 'requires-runtime-bridge' }
      try {
        const [resolvedCache, resolvedFile, metadata] = await Promise.all([
          realpath(cacheDirectory),
          realpath(preview.path),
          stat(preview.path),
        ])
        if (!metadata.isFile() || !isWithinDirectory(resolvedCache, resolvedFile)) return { opened: false, status: 'failed' }
        const opened = await options.shellOpen.openLocalFile({
          caller,
          scope: runtimeScope,
          filePath: resolvedFile,
          userInitiated: true,
        })
        if (opened) {
          previews.delete(preview.id)
          await rm(preview.path, { force: true }).catch(() => undefined)
          return { opened: true, status: 'opened' }
        }
      } catch {
        // Shell/file exceptions are reduced to a bounded status with no path or host details.
      }
      return { opened: false, status: 'failed' }
    },
  }

  const pdfExport: CapabilityDefinition<PreviewPdfExportRequest, PreviewPdfExportResponse> = {
    id: HOST_ACTIONS.preview.pdfExport,
    scope: 'runtime',
    validateRequest: isPreviewPdfExportRequest,
    validateResponse: isPreviewPdfExportResponse,
    handle: async ({ caller, scope }, request) => {
      const runtimeScope = requireScope(options.authorizeRuntimeCaller, caller, scope)
      const bridge = options.nativePdf?.resolve(caller, runtimeScope)
      if (!bridge) return { opened: false, status: 'requires-runtime-bridge' }
      try {
        const opened = await bridge.exportPdf(caller, runtimeScope, request.markdown)
        return opened ? { opened: true, status: 'exported' } : { opened: false, status: 'failed' }
      } catch {
        return { opened: false, status: 'failed' }
      }
    },
  }

  const clearCache: CapabilityDefinition<EmptyHostActionRequest, PreviewCacheClearResponse> = {
    id: HOST_ACTIONS.preview.cacheClear,
    scope: 'runtime',
    validateRequest: isEmptyHostActionRequest,
    validateResponse: isPreviewCacheClearResponse,
    handle: async ({ caller, scope }) => {
      requireScope(options.authorizeRuntimeCaller, caller, scope)
      try {
        await rm(cacheDirectory, { recursive: true, force: true })
        previews.clear()
        return { cleared: true }
      } catch {
        return { cleared: false }
      }
    },
  }

  return [render, openBrowser, pdfExport, clearCache]
}
