import { clipboard } from 'electron'
import { isAbsolute, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { SessionManager, type AgentSession, type SessionEntry } from '@earendil-works/pi-coding-agent'
import type {
  NativeCommandJsonObject,
  NativeCommandJsonValue,
  NativeCommandMenuSelectionSchema,
  NativeCoreCommandOutcome,
} from '../../shared/commands.ts'
import type { ParsedCommandInput } from '../commands/dispatch.ts'

export type SessionTransitionRequest =
  | {
      readonly kind: 'new'
      readonly cwd: string
      readonly sourceSessionId: string
      readonly parentSessionFile: string | null
    }
  | {
      readonly kind: 'resume'
      readonly cwd: string
      readonly sessionFile: string
    }
  | {
      readonly kind: 'fork' | 'clone'
      readonly cwd: string
      readonly sourceSessionId: string
      readonly entryId: string
      readonly position: 'before' | 'at'
    }
  | {
      readonly kind: 'import'
      readonly cwd: string
      readonly sourceSessionId: string
      readonly sessionFile: string
    }

export type SessionTransitionResult =
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'applied'
      readonly sessionId: string
      readonly sessionFile?: string
      readonly selectedText?: string
    }

/** Host-owned session replacement seam; replacement must create/bind a new runtime. */
export interface SessionSwitchPort {
  transition(request: SessionTransitionRequest): Promise<SessionTransitionResult>
}

const MAX_TEXT = 4096
const MAX_SESSION_CHOICES = 100
const MAX_TREE_ENTRIES = 300

function nativeObject(value: unknown): NativeCommandJsonObject {
  const bounded = (candidate: unknown, depth: number): NativeCommandJsonValue => {
    if (candidate === null || typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'string') return candidate.slice(0, MAX_TEXT)
    if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : null
    if (depth >= 8) return '[truncated]'
    if (Array.isArray(candidate)) return candidate.slice(0, 100).map((item) => bounded(item, depth + 1))
    if (typeof candidate === 'object') {
      const result: Record<string, NativeCommandJsonValue> = {}
      for (const [key, item] of Object.entries(candidate).slice(0, 100)) {
        result[key.slice(0, 128)] = bounded(item, depth + 1)
      }
      return result
    }
    return null
  }
  const result = bounded(value, 0)
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? result as NativeCommandJsonObject
    : Object.freeze({})
}

function textFromEntry(entry: SessionEntry): string {
  if (entry.type === 'message') {
    const message = entry.message
    if (message.role !== 'user' && message.role !== 'assistant') return ''
    const content = message.content
    if (typeof content === 'string') return content.slice(0, MAX_TEXT)
    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(' ')
      .slice(0, MAX_TEXT)
  }
  if (entry.type === 'custom_message') {
    const content = entry.content
    if (typeof content === 'string') return content.slice(0, MAX_TEXT)
    return content.filter((part) => part.type === 'text').map((part) => part.text).join(' ').slice(0, MAX_TEXT)
  }
  if (entry.type === 'branch_summary' || entry.type === 'compaction') return entry.summary.slice(0, MAX_TEXT)
  return ''
}

function flattenTree(session: AgentSession): NativeCommandJsonObject[] {
  const tree = session.sessionManager.getTree()
  const result: NativeCommandJsonObject[] = []
  const stack = tree.slice().reverse().map((node) => ({ node, depth: 0 }))
  while (stack.length > 0 && result.length < MAX_TREE_ENTRIES) {
    const current = stack.pop()!
    const { node, depth } = current
    result.push({
      id: node.entry.id,
      parentId: node.entry.parentId,
      type: node.entry.type,
      timestamp: node.entry.timestamp,
      depth,
      label: node.label ?? null,
      text: textFromEntry(node.entry).slice(0, 512),
    })
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: node.children[index]!, depth: depth + 1 })
    }
  }
  return result
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function resolveCommandPath(cwd: string, value: string): string | undefined {
  if (!value || value.length > 4096 || value.includes('\0')) return undefined
  return resolve(cwd, value)
}

function isSessionFilePath(path: string): boolean {
  return isAbsolute(path) && path.toLowerCase().endsWith('.jsonl') && isExistingFile(path)
}

function applied(commandName: string, data?: NativeCommandJsonObject): NativeCoreCommandOutcome {
  return { type: 'applied', commandName, ...(data ? { data } : {}) }
}

function menuRequest(
  commandName: string,
  menu: 'tree' | 'fork' | 'resume' | 'import' | 'export',
  initialState: NativeCommandJsonObject,
  selection?: NativeCommandMenuSelectionSchema,
): NativeCoreCommandOutcome {
  return { type: 'menu-request', commandName, menu, initialState, ...(selection ? { selection } : {}) }
}

function rejected(commandName: string, reason: string): NativeCoreCommandOutcome {
  return { type: 'rejected', commandName, reason: reason.slice(0, 160) }
}

export class SessionService {
  readonly session: AgentSession
  private readonly sessionSwitch?: SessionSwitchPort

  constructor(session: AgentSession, sessionSwitch?: SessionSwitchPort) {
    this.session = session
    this.sessionSwitch = sessionSwitch
  }

  async execute(commandName: string, input: ParsedCommandInput): Promise<NativeCoreCommandOutcome | undefined> {
    switch (commandName) {
      case 'new': return this.newSession(input)
      case 'resume': return this.resume(input)
      case 'name': return this.name(input)
      case 'tree': return this.tree(input)
      case 'fork': return this.fork(input)
      case 'clone': return this.clone(input)
      case 'compact': return this.compact(input)
      case 'import': return this.importSession(input)
      case 'export': return this.exportSession(input)
      case 'copy': return this.copy()
      case 'session': return this.sessionInfo(input)
      default: return undefined
    }
  }

  private async transition(
    commandName: string,
    request: SessionTransitionRequest,
  ): Promise<NativeCoreCommandOutcome> {
    if (!this.sessionSwitch) {
      return {
        type: 'delegated',
        commandName,
        target: 'session-switch',
        request: nativeObject(request),
      }
    }
    try {
      const result = await this.sessionSwitch.transition(request)
      if (result.status === 'cancelled') return { type: 'cancelled', commandName }
      if (!result.sessionId || result.sessionId.length > 128) return rejected(commandName, 'session-transition-unconfirmed')
      return applied(commandName, nativeObject({
        sessionId: result.sessionId,
        sessionFile: result.sessionFile ?? null,
        selectedText: result.selectedText ?? null,
      }))
    } catch {
      return rejected(commandName, 'session-transition-failed')
    }
  }

  private async newSession(input: ParsedCommandInput): Promise<NativeCoreCommandOutcome> {
    if (input.args.length > 0) return rejected('new', 'unexpected-arguments')
    return this.transition('new', {
      kind: 'new',
      cwd: this.session.sessionManager.getCwd(),
      sourceSessionId: this.session.sessionId,
      parentSessionFile: this.session.sessionFile ?? null,
    })
  }

  private async resume(input: ParsedCommandInput): Promise<NativeCoreCommandOutcome> {
    const manager = this.session.sessionManager
    const cwd = manager.getCwd()
    if (input.args.length === 0) {
      const sessions = await SessionManager.list(cwd, manager.getSessionDir())
      const choices = sessions.slice(0, MAX_SESSION_CHOICES)
      return menuRequest('resume', 'resume', nativeObject({
        currentSessionId: this.session.sessionId,
        sessions: choices.map((item) => ({
          sessionFile: item.path,
          sessionId: item.id,
          name: item.name ?? null,
          modifiedAt: item.modified.getTime(),
          messageCount: item.messageCount,
          firstMessage: item.firstMessage.slice(0, 256),
        })),
        truncated: sessions.length > MAX_SESSION_CHOICES,
      }), {
        kind: 'argument',
        argument: 'session-id',
        values: choices.map((item) => item.id),
      })
    }
    if (input.args.length !== 1) return rejected('resume', 'expected-one-session-path-or-id')
    const sessionIdPath = SessionManager.findById(cwd, input.args[0]!, manager.getSessionDir())
    const path = sessionIdPath ?? resolveCommandPath(cwd, input.args[0]!)
    if (!path || !isSessionFilePath(path)) return rejected('resume', 'session-not-found')
    return this.transition('resume', { kind: 'resume', cwd, sessionFile: path })
  }

  private name(input: ParsedCommandInput): NativeCoreCommandOutcome {
    if (input.args.length === 0) {
      return {
        type: 'effect-data',
        commandName: 'name',
        effect: 'session-name',
        data: nativeObject({ name: this.session.sessionName ?? null }),
      }
    }
    const name = input.args.join(' ').trim()
    if (!name || name.length > 256) return rejected('name', 'name-must-be-1-to-256-characters')
    this.session.setSessionName(name)
    return applied('name', nativeObject({ name: this.session.sessionName ?? null }))
  }

  private async tree(input: ParsedCommandInput): Promise<NativeCoreCommandOutcome> {
    if (input.args.length === 0) {
      const allEntries = flattenTree(this.session)
      const entries = allEntries.slice(0, 128)
      return menuRequest('tree', 'tree', nativeObject({
        leafId: this.session.sessionManager.getLeafId(),
        entries,
        truncated: allEntries.length > entries.length,
      }), {
        kind: 'argument',
        argument: 'tree-entry-id',
        values: entries.map((entry) => entry.id as string),
      })
    }
    if (input.args.length !== 1) return rejected('tree', 'expected-one-entry-id')
    const entryId = input.args[0]!
    if (!this.session.sessionManager.getEntry(entryId)) return rejected('tree', 'entry-not-found')
    try {
      const result = await this.session.navigateTree(entryId)
      if (result.cancelled || result.aborted) return { type: 'cancelled', commandName: 'tree' }
      return applied('tree', nativeObject({ editorText: result.editorText ?? null, leafId: this.session.sessionManager.getLeafId() }))
    } catch {
      return rejected('tree', 'tree-navigation-failed')
    }
  }

  private async fork(input: ParsedCommandInput): Promise<NativeCoreCommandOutcome> {
    const messages = this.session.getUserMessagesForForking()
    if (input.args.length === 0) {
      const choices = messages.slice(-MAX_SESSION_CHOICES)
      return menuRequest('fork', 'fork', nativeObject({
        initialSelectedId: messages.at(-1)?.entryId ?? null,
        messages: choices.map((message) => ({
          entryId: message.entryId,
          text: message.text.slice(0, 512),
        })),
      }), {
        kind: 'argument',
        argument: 'user-message-entry-id',
        values: choices.map((message) => message.entryId),
      })
    }
    if (input.args.length !== 1) return rejected('fork', 'expected-one-user-message-entry-id')
    const entryId = input.args[0]!
    const entry = this.session.sessionManager.getEntry(entryId)
    if (!entry || entry.type !== 'message' || entry.message.role !== 'user') {
      return rejected('fork', 'user-message-not-found')
    }
    return this.transition('fork', {
      kind: 'fork',
      cwd: this.session.sessionManager.getCwd(),
      sourceSessionId: this.session.sessionId,
      entryId,
      position: 'before',
    })
  }

  private async clone(input: ParsedCommandInput): Promise<NativeCoreCommandOutcome> {
    if (input.args.length > 0) return rejected('clone', 'unexpected-arguments')
    const entryId = this.session.sessionManager.getLeafId()
    if (!entryId) return { type: 'effect-data', commandName: 'clone', effect: 'clone-unavailable', data: nativeObject({ reason: 'empty-session' }) }
    return this.transition('clone', {
      kind: 'clone',
      cwd: this.session.sessionManager.getCwd(),
      sourceSessionId: this.session.sessionId,
      entryId,
      position: 'at',
    })
  }

  private async compact(input: ParsedCommandInput): Promise<NativeCoreCommandOutcome> {
    const instructions = input.argumentText.trim() || undefined
    let aborted = false
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === 'compaction_end' && event.reason === 'manual' && event.aborted) aborted = true
    })
    try {
      const result = await this.session.compact(instructions)
      return applied('compact', nativeObject({
        tokensBefore: result.tokensBefore,
        estimatedTokensAfter: result.estimatedTokensAfter ?? null,
      }))
    } catch {
      return aborted
        ? { type: 'cancelled', commandName: 'compact' }
        : rejected('compact', 'compaction-failed')
    } finally {
      unsubscribe()
    }
  }

  private async importSession(input: ParsedCommandInput): Promise<NativeCoreCommandOutcome> {
    if (input.args.length === 0) {
      return menuRequest('import', 'import', nativeObject({ fileType: '.jsonl', sessionFile: null }))
    }
    if (input.args.length !== 1) return rejected('import', 'expected-one-session-file-path')
    const path = resolveCommandPath(this.session.sessionManager.getCwd(), input.args[0]!)
    if (!path || !path.toLowerCase().endsWith('.jsonl') || !isExistingFile(path)) {
      return rejected('import', 'session-file-not-found')
    }
    return this.transition('import', {
      kind: 'import',
      cwd: this.session.sessionManager.getCwd(),
      sourceSessionId: this.session.sessionId,
      sessionFile: path,
    })
  }

  private async exportSession(input: ParsedCommandInput): Promise<NativeCoreCommandOutcome> {
    if (input.args.length === 0) {
      return menuRequest('export', 'export', nativeObject({ defaultFormat: 'html', formats: ['html', 'jsonl'], path: null }))
    }
    if (input.args.length !== 1) return rejected('export', 'expected-one-output-path')
    const path = resolveCommandPath(this.session.sessionManager.getCwd(), input.args[0]!)
    if (!path) return rejected('export', 'invalid-output-path')
    try {
      const filePath = path.toLowerCase().endsWith('.jsonl')
        ? this.session.exportToJsonl(path)
        : await this.session.exportToHtml(path)
      return applied('export', nativeObject({ filePath }))
    } catch {
      return rejected('export', 'export-failed')
    }
  }

  private copy(): NativeCoreCommandOutcome {
    const text = this.session.getLastAssistantText()
    if (!text) return { type: 'effect-data', commandName: 'copy', effect: 'clipboard-empty', data: nativeObject({ copied: false }) }
    clipboard.writeText(text)
    return applied('copy', nativeObject({ copied: true, characters: text.length }))
  }

  private sessionInfo(input: ParsedCommandInput): NativeCoreCommandOutcome {
    if (input.args.length > 0) return rejected('session', 'unexpected-arguments')
    const stats = this.session.getSessionStats()
    return {
      type: 'effect-data',
      commandName: 'session',
      effect: 'session-info',
      data: nativeObject({
        name: this.session.sessionName ?? null,
        sessionId: stats.sessionId,
        sessionFile: stats.sessionFile ?? null,
        cwd: this.session.sessionManager.getCwd(),
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        toolResults: stats.toolResults,
        totalMessages: stats.totalMessages,
        tokens: stats.tokens,
        contextUsage: stats.contextUsage ?? null,
        cost: stats.cost,
      }),
    }
  }
}
