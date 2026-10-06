import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type {
  CommandCatalogEntry,
  CommandDispatchRejection,
  CommandEffectDataResponse,
  CommandDispatchResponse,
  CommandMenuDispatchResponse,
  NativeCommandMenuSelectionSchema,
  CoreCommandMenuRequestResponse,
  NativeCommandMenuSelection,
} from '../../shared/commands.ts'
import type { WorkspaceSessionHost, WorkspaceService } from '../workspaces/workspace-service.ts'
import { CommandCatalog } from './command-catalog.ts'

const MAX_INPUT_LENGTH = 4096
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export interface ParsedCommandInput {
  readonly commandName: string
  /** Argument text is retained exactly so Pi's native parser sees the original spelling. */
  readonly argumentText: string
  /** Parsed tokens are provided to core adapters without discarding the original argument text. */
  readonly args: readonly string[]
}

export interface CoreCommandContext {
  readonly host: WorkspaceSessionHost
  readonly session: AgentSession
  readonly scope: RuntimeScope
  readonly command: CommandCatalogEntry
  readonly input: ParsedCommandInput
  readonly menuSelection?: Exclude<NativeCommandMenuSelection, { readonly kind: 'cancel' }>
}

export type CoreCommandHandler = (context: CoreCommandContext) =>
  void | CommandEffectDataResponse | CoreCommandMenuRequestResponse
  | Promise<void | CommandEffectDataResponse | CoreCommandMenuRequestResponse>

interface PendingMenu {
  readonly menuId: string
  readonly commandName: string
  readonly scope: RuntimeScope
  readonly sessionId: string
  readonly selection?: NativeCommandMenuSelectionSchema
  readonly expiresAt: number
}

const MAX_PENDING_MENUS = 128
const MENU_LIFETIME_MS = 5 * 60 * 1000

export function parseCommandInput(input: string): ParsedCommandInput | undefined {
  if (input.length === 0 || input.length > MAX_INPUT_LENGTH || input[0] !== '/') return undefined
  let commandEnd = 1
  while (commandEnd < input.length && !/\s/.test(input[commandEnd]!)) commandEnd += 1
  const commandName = input.slice(1, commandEnd)
  if (!COMMAND_NAME_PATTERN.test(commandName)) return undefined

  const argumentText = input.slice(commandEnd)
  const args: string[] = []
  let token = ''
  let quote: '"' | "'" | undefined
  let tokenStarted = false
  for (const character of argumentText) {
    if (quote) {
      if (character === quote) quote = undefined
      else token += character
      tokenStarted = true
    } else if (character === '"' || character === "'") {
      quote = character
      tokenStarted = true
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        args.push(token)
        token = ''
        tokenStarted = false
        if (args.length > 128) return undefined
      }
    } else {
      token += character
      tokenStarted = true
    }
  }
  if (quote) return undefined
  if (tokenStarted) args.push(token)
  if (args.length > 128) return undefined

  return Object.freeze({ commandName, argumentText, args: Object.freeze(args) })
}

function rejected(reason: CommandDispatchRejection): CommandDispatchResponse {
  return { outcome: 'rejected', reason }
}

export class CommandDispatcher {
  readonly catalog: CommandCatalog
  private readonly workspaceService: Pick<WorkspaceService,
    'activeHost' | 'authorizeRuntimeScope' | 'getRuntimeScope'>
  private readonly coreHandlers = new Map<string, CoreCommandHandler>()
  private readonly pendingMenus = new Map<string, PendingMenu>()

  constructor(workspaceService: Pick<WorkspaceService,
    'activeHost' | 'authorizeRuntimeScope' | 'getRuntimeScope'>) {
    this.workspaceService = workspaceService
    this.catalog = new CommandCatalog(() => this.workspaceService.activeHost?.session)
  }

  registerCoreHandler(commandName: string, handler: CoreCommandHandler): () => void {
    if (!COMMAND_NAME_PATTERN.test(commandName) || typeof handler !== 'function') {
      throw new TypeError('A valid command name and handler are required.')
    }
    if (this.coreHandlers.has(commandName)) throw new TypeError('A core command handler is already registered.')
    this.coreHandlers.set(commandName, handler)
    return () => {
      if (this.coreHandlers.get(commandName) === handler) this.coreHandlers.delete(commandName)
    }
  }

  async dispatch(input: string, scope: RuntimeScope | undefined): Promise<CommandDispatchResponse> {
    const parsed = parseCommandInput(input)
    if (!parsed) return rejected('invalid-input')

    if (!scope || !this.workspaceService.authorizeRuntimeScope(scope)) return rejected('runtime-unavailable')
    const host = this.workspaceService.activeHost
    const currentScope = this.workspaceService.getRuntimeScope()
    if (!host
      || !this.workspaceService.authorizeRuntimeScope(scope)
      || scope.ownerId !== currentScope.ownerId
      || scope.generation !== currentScope.generation) return rejected('runtime-unavailable')

    // Refresh before dispatch so catalog invalidation is not required to safely classify new resources.
    const command = this.catalog.find(parsed.commandName, true)
    if (!command) return rejected('unknown-command')

    if (command.source === 'builtin') {
      const handler = this.coreHandlers.get(command.name)
      if (!handler) return { outcome: 'builtin-adapter-pending', commandName: command.name }
      try {
        const result = await handler({ host, session: host.session, command, input: parsed, scope })
        if (result && result.outcome === 'menu-request') return this.issueMenu(result, host.session.sessionId, scope)
        if (result && result.outcome === 'effect-data') return result
        return { outcome: 'dispatched', commandName: command.name }
      } catch {
        return rejected('dispatch-failed')
      }
    }

    // Do not invoke prompt() during a turn: it can throw or route a queued item into the model.
    if (host.session.isStreaming) return rejected('turn-in-progress')

    const dispatchedInput = parsed.commandName === command.name
      ? input
      : `/${command.name}${parsed.argumentText}`
    try {
      // Pi dispatches extension commands, skills, and prompt templates natively in prompt().
      await host.prompt(dispatchedInput)
      return { outcome: 'dispatched', commandName: command.name }
    } catch {
      return rejected('dispatch-failed')
    }
  }

  async dispatchMenuSelection(
    menuId: string,
    selection: NativeCommandMenuSelection,
    scope: RuntimeScope | undefined,
  ): Promise<CommandDispatchResponse> {
    this.pruneMenus()
    const pending = this.pendingMenus.get(menuId)
    if (!pending) return rejected('runtime-unavailable')
    this.pendingMenus.delete(menuId)
    if (selection.kind === 'cancel') {
      return this.isMenuCurrent(pending, scope)
        ? { outcome: 'cancelled', commandName: pending.commandName }
        : rejected('runtime-unavailable')
    }
    if (!this.isMenuCurrent(pending, scope)) return rejected('runtime-unavailable')
    if (!pending.selection || !this.isAllowedSelection(pending.selection, selection)) return rejected('invalid-input')

    const host = this.workspaceService.activeHost
    if (!host || host.session.isStreaming) return rejected(host ? 'turn-in-progress' : 'runtime-unavailable')
    const command = this.catalog.find(pending.commandName, true)
    const handler = this.coreHandlers.get(pending.commandName)
    if (!command || command.source !== 'builtin' || !handler) return rejected('unknown-command')
    const input: ParsedCommandInput = {
      commandName: pending.commandName,
      argumentText: selection.kind === 'argument' ? ` ${selection.value}` : '',
      args: selection.kind === 'argument' ? [selection.value] : [],
    }
    try {
      const result = await handler({
        host,
        session: host.session,
        scope: pending.scope,
        command,
        input,
        ...(selection.kind === 'scoped-models' ? { menuSelection: selection } : {}),
      })
      if (result && result.outcome === 'menu-request') return this.issueMenu(result, host.session.sessionId, pending.scope)
      if (result && result.outcome === 'effect-data') return result
      return { outcome: 'dispatched', commandName: command.name }
    } catch {
      return rejected('dispatch-failed')
    }
  }

  private issueMenu(
    request: CoreCommandMenuRequestResponse,
    sessionId: string,
    scope: RuntimeScope,
  ): CommandMenuDispatchResponse | CommandDispatchResponse {
    this.pruneMenus()
    const currentScope = this.workspaceService.getRuntimeScope()
    const host = this.workspaceService.activeHost
    if (!host || host.session.sessionId !== sessionId
      || currentScope.ownerId !== scope.ownerId || currentScope.generation !== scope.generation
      || !this.workspaceService.authorizeRuntimeScope(scope)) return rejected('runtime-unavailable')
    while (this.pendingMenus.size >= MAX_PENDING_MENUS) {
      const oldest = this.pendingMenus.keys().next().value as string | undefined
      if (!oldest) break
      this.pendingMenus.delete(oldest)
    }
    const menuId = randomUUID()
    const pending: PendingMenu = {
      menuId,
      commandName: request.commandName,
      scope: { ownerId: scope.ownerId, generation: scope.generation },
      sessionId,
      ...(request.selection ? { selection: request.selection } : {}),
      expiresAt: Date.now() + MENU_LIFETIME_MS,
    }
    this.pendingMenus.set(menuId, pending)
    return {
      ...request,
      menuId,
      binding: { scope: pending.scope, sessionId },
    }
  }

  private pruneMenus(): void {
    const now = Date.now()
    for (const [menuId, menu] of this.pendingMenus) {
      if (menu.expiresAt <= now) this.pendingMenus.delete(menuId)
    }
  }

  private isMenuCurrent(menu: PendingMenu, scope: RuntimeScope | undefined): boolean {
    if (!scope || scope.ownerId !== menu.scope.ownerId || scope.generation !== menu.scope.generation
      || !this.workspaceService.authorizeRuntimeScope(scope)) return false
    const currentScope = this.workspaceService.getRuntimeScope()
    const host = this.workspaceService.activeHost
    return currentScope.ownerId === menu.scope.ownerId
      && currentScope.generation === menu.scope.generation
      && host?.session.sessionId === menu.sessionId
  }

  private isAllowedSelection(
    schema: NativeCommandMenuSelectionSchema,
    selection: Exclude<NativeCommandMenuSelection, { readonly kind: 'cancel' }>,
  ): boolean {
    if (schema.kind === 'argument') {
      return selection.kind === 'argument' && schema.values.includes(selection.value)
    }
    return selection.kind === 'scoped-models'
      && (!selection.persist || schema.canPersist)
      && selection.enabledModelReferences.every((reference) => schema.availableModelReferences.includes(reference))
  }
}
