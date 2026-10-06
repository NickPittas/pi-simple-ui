import { hasExactKeys, isPlainRecord, isRuntimeScope, type RuntimeScope } from './ipc-contracts.ts'

export type CommandSource = 'builtin' | 'extension' | 'template' | 'skill'

export interface CommandCatalogEntry {
  readonly name: string
  readonly source: CommandSource
  readonly description: string
  readonly argumentHint: string | null
  readonly aliases: readonly string[]
}

export interface CommandCatalogDiagnostic {
  readonly type: 'extension-shadowed-builtin'
  readonly name: string
  readonly invocationName: string
  readonly message: string
}

export interface CommandCatalogResponse {
  readonly revision: number
  readonly commands: readonly CommandCatalogEntry[]
  readonly diagnostics: readonly CommandCatalogDiagnostic[]
}

export interface CommandCatalogRequest {
  readonly [key: string]: never
}

export interface CommandAutocompleteRequest {
  readonly partial: string
}

export interface CommandAutocompleteResponse {
  readonly commands: readonly CommandCatalogEntry[]
}

export type CommandDispatchRequest =
  | { readonly input: string }
  | {
      readonly menuSelection: {
        readonly menuId: string
        readonly selection: NativeCommandMenuSelection
      }
    }

export const COMMAND_EFFECT_DATA_MAX_BYTES = 64 * 1024
export const COMMAND_MENU_MAX_BYTES = 64 * 1024

export type CommandDispatchRejection =
  | 'invalid-input'
  | 'unknown-command'
  | 'runtime-unavailable'
  | 'turn-in-progress'
  | 'dispatch-failed'

export type CommandDispatchResponse =
  | { readonly outcome: 'dispatched'; readonly commandName: string }
  | { readonly outcome: 'builtin-adapter-pending'; readonly commandName: string }
  | { readonly outcome: 'cancelled'; readonly commandName: string }
  | CommandMenuDispatchResponse
  | {
      readonly outcome: 'effect-data'
      readonly commandName: string
      readonly effect: string
      readonly data: NativeCommandJsonObject
      readonly truncated?: boolean
    }
  | { readonly outcome: 'rejected'; readonly reason: CommandDispatchRejection }

export type CommandEffectDataResponse = Extract<CommandDispatchResponse, { readonly outcome: 'effect-data' }>

export interface CommandMenuArgumentSelectionSchema {
  readonly kind: 'argument'
  readonly argument: 'model' | 'thinking-level' | 'provider-id' | 'tree-entry-id' | 'user-message-entry-id' | 'session-id'
  readonly values: readonly string[]
}

export interface CommandMenuScopedModelsSelectionSchema {
  readonly kind: 'scoped-models'
  readonly availableModelReferences: readonly string[]
  readonly canPersist: boolean
}

export type NativeCommandMenuSelectionSchema =
  | CommandMenuArgumentSelectionSchema
  | CommandMenuScopedModelsSelectionSchema

export type NativeCommandMenuSelection =
  | { readonly kind: 'argument'; readonly value: string }
  | {
      readonly kind: 'scoped-models'
      readonly enabledModelReferences: readonly string[]
      readonly persist: boolean
    }
  | { readonly kind: 'cancel' }

export interface CommandMenuBinding {
  readonly scope: RuntimeScope
  readonly sessionId: string
}

export interface CommandMenuDispatchResponse {
  readonly outcome: 'menu-request'
  readonly commandName: string
  readonly menu: NativeCommandMenuKind
  readonly initialState: NativeCommandJsonObject
  readonly binding: CommandMenuBinding
  readonly menuId: string
  readonly selection?: NativeCommandMenuSelectionSchema
}

/** Unbound menu result returned by native handlers before the dispatcher issues a scoped continuation. */
export type CoreCommandMenuRequestResponse = Omit<CommandMenuDispatchResponse, 'binding' | 'menuId'>

export type NativeCommandJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly NativeCommandJsonValue[]
  | NativeCommandJsonObject

export interface NativeCommandJsonObject {
  readonly [key: string]: NativeCommandJsonValue
}

export type NativeCommandMenuKind =
  | 'settings'
  | 'model'
  | 'thinking'
  | 'scoped-models'
  | 'login'
  | 'logout'
  | 'tree'
  | 'fork'
  | 'resume'
  | 'import'
  | 'export'

export interface WorkspaceTrustCommandRequest {
  readonly cwd: string
  readonly projectTrusted: boolean
}

export interface ApplicationQuitCommandRequest {
  readonly requested: true
}

/** Native effect result passed to the host's UI/event integration, not sent as a model prompt. */
export type NativeCoreCommandOutcome =
  | { readonly type: 'applied'; readonly commandName: string; readonly data?: NativeCommandJsonObject }
  | {
      readonly type: 'menu-request'
      readonly commandName: string
      readonly menu: NativeCommandMenuKind
      readonly initialState: NativeCommandJsonObject
      readonly selection?: NativeCommandMenuSelectionSchema
    }
  | {
      readonly type: 'effect-data'
      readonly commandName: string
      readonly effect: string
      readonly data: NativeCommandJsonObject
      readonly truncated?: boolean
    }
  | {
      readonly type: 'delegated'
      readonly commandName: string
      readonly target: 'session-switch'
      readonly request: NativeCommandJsonObject
    }
  | {
      readonly type: 'delegated'
      readonly commandName: 'trust'
      readonly target: 'workspace-trust'
      readonly request: WorkspaceTrustCommandRequest
    }
  | {
      readonly type: 'delegated'
      readonly commandName: 'quit'
      readonly target: 'application-quit'
      readonly request: ApplicationQuitCommandRequest
    }
  | { readonly type: 'cancelled'; readonly commandName: string }
  | { readonly type: 'rejected'; readonly commandName: string; readonly reason: string }

export interface CommandCapabilityContracts {
  'commands.catalog': {
    readonly request: CommandCatalogRequest
    readonly response: CommandCatalogResponse
  }
  'commands.autocomplete': {
    readonly request: CommandAutocompleteRequest
    readonly response: CommandAutocompleteResponse
  }
  'commands.dispatch': {
    readonly request: CommandDispatchRequest
    readonly response: CommandDispatchResponse
  }
}

declare module './ipc-contracts.ts' {
  interface IpcCapabilityContracts extends CommandCapabilityContracts {}
}

const COMMAND_SOURCES: readonly CommandSource[] = ['builtin', 'extension', 'template', 'skill']
const REJECTIONS: readonly CommandDispatchRejection[] = [
  'invalid-input',
  'unknown-command',
  'runtime-unavailable',
  'turn-in-progress',
  'dispatch-failed',
]
const MENU_KINDS: readonly NativeCommandMenuKind[] = [
  'settings', 'model', 'thinking', 'scoped-models', 'login', 'logout', 'tree', 'fork', 'resume', 'import', 'export',
]
const MENU_ARGUMENT_KINDS: readonly CommandMenuArgumentSelectionSchema['argument'][] = [
  'model', 'thinking-level', 'provider-id', 'tree-entry-id', 'user-message-entry-id', 'session-id',
]

function isBoundedStringList(value: unknown, maxItems = 300): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 4096)
    && new Set(value).size === value.length
}

function isMenuSelectionSchema(value: unknown): value is NativeCommandMenuSelectionSchema {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'argument') {
    return hasExactKeys(value, ['kind', 'argument', 'values'])
      && MENU_ARGUMENT_KINDS.includes(value.argument as CommandMenuArgumentSelectionSchema['argument'])
      && Array.isArray(value.values)
      && value.values.length <= 128
      && value.values.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256)
      && new Set(value.values).size === value.values.length
  }
  if (value.kind !== 'scoped-models'
    || !hasExactKeys(value, ['kind', 'availableModelReferences', 'canPersist'])
    || !isBoundedStringList(value.availableModelReferences, 128)) return false
  const availableModelReferences = value.availableModelReferences
  return availableModelReferences.every((reference) => reference.length <= 256)
    && typeof value.canPersist === 'boolean'
}

export function isCommandDispatchRequest(value: unknown): value is CommandDispatchRequest {
  if (!isPlainRecord(value)) return false
  if (Object.hasOwn(value, 'input')) {
    return hasExactKeys(value, ['input'])
      && typeof value.input === 'string'
      && value.input.length > 0
      && value.input.length <= 4096
      && !value.input.includes('\0')
  }
  if (!hasExactKeys(value, ['menuSelection']) || !isPlainRecord(value.menuSelection)
    || !hasExactKeys(value.menuSelection, ['menuId', 'selection'])) return false
  return typeof value.menuSelection.menuId === 'string'
    && /^[0-9a-f-]{36}$/i.test(value.menuSelection.menuId)
    && isMenuSelection(value.menuSelection.selection)
}

function isMenuSelection(value: unknown): value is NativeCommandMenuSelection {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'cancel') return hasExactKeys(value, ['kind'])
  if (value.kind === 'argument') {
    return hasExactKeys(value, ['kind', 'value'])
      && typeof value.value === 'string'
      && value.value.length > 0
      && value.value.length <= 4096
  }
  return value.kind === 'scoped-models'
    && hasExactKeys(value, ['kind', 'enabledModelReferences', 'persist'])
    && isBoundedStringList(value.enabledModelReferences, 256)
    && typeof value.persist === 'boolean'
}

function isMenuBinding(value: unknown): value is CommandMenuBinding {
  return isPlainRecord(value)
    && hasExactKeys(value, ['scope', 'sessionId'])
    && isRuntimeScope(value.scope)
    && typeof value.sessionId === 'string'
    && value.sessionId.length > 0
    && value.sessionId.length <= 256
}

function isNativeCommandJsonValue(value: unknown, state: { nodes: number }, depth = 0): value is NativeCommandJsonValue {
  state.nodes -= 1
  if (state.nodes < 0 || depth > 8) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 8192
  if (Array.isArray(value)) {
    return value.length <= 128 && value.every((entry) => isNativeCommandJsonValue(entry, state, depth + 1))
  }
  if (!isPlainRecord(value) || Object.keys(value).length > 128) return false
  return Object.entries(value).every(([key, entry]) => key.length <= 128
    && isNativeCommandJsonValue(entry, state, depth + 1))
}

function jsonByteLength(value: unknown): number | undefined {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return undefined
  }
  if (serialized === undefined) return undefined
  let bytes = 0
  for (const character of serialized) {
    const codePoint = character.codePointAt(0) ?? 0
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

function isCommandCatalogEntry(value: unknown): value is CommandCatalogEntry {
  return isPlainRecord(value)
    && hasExactKeys(value, ['name', 'source', 'description', 'argumentHint', 'aliases'])
    && typeof value.name === 'string'
    && value.name.length > 0
    && value.name.length <= 128
    && COMMAND_SOURCES.includes(value.source as CommandSource)
    && typeof value.description === 'string'
    && value.description.length <= 512
    && (value.argumentHint === null || (typeof value.argumentHint === 'string' && value.argumentHint.length <= 256))
    && Array.isArray(value.aliases)
    && value.aliases.length <= 32
    && value.aliases.every((alias) => typeof alias === 'string' && alias.length > 0 && alias.length <= 128)
}

function isCommandCatalogDiagnostic(value: unknown): value is CommandCatalogDiagnostic {
  return isPlainRecord(value)
    && hasExactKeys(value, ['type', 'name', 'invocationName', 'message'])
    && value.type === 'extension-shadowed-builtin'
    && typeof value.name === 'string'
    && value.name.length > 0
    && value.name.length <= 128
    && typeof value.invocationName === 'string'
    && value.invocationName.length > 0
    && value.invocationName.length <= 128
    && typeof value.message === 'string'
    && value.message.length <= 256
}

export function isCommandCatalogResponse(value: unknown): value is CommandCatalogResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['revision', 'commands', 'diagnostics'])
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) >= 0
    && Array.isArray(value.commands)
    && value.commands.length <= 512
    && value.commands.every(isCommandCatalogEntry)
    && Array.isArray(value.diagnostics)
    && value.diagnostics.length <= 128
    && value.diagnostics.every(isCommandCatalogDiagnostic)
}

export function isCommandAutocompleteResponse(value: unknown): value is CommandAutocompleteResponse {
  return isPlainRecord(value)
    && hasExactKeys(value, ['commands'])
    && Array.isArray(value.commands)
    && value.commands.length <= 512
    && value.commands.every(isCommandCatalogEntry)
}

export function isCommandDispatchResponse(value: unknown): value is CommandDispatchResponse {
  if (!isPlainRecord(value) || typeof value.outcome !== 'string') return false
  if (value.outcome === 'rejected') {
    return hasExactKeys(value, ['outcome', 'reason'])
      && REJECTIONS.includes(value.reason as CommandDispatchRejection)
  }
  if (value.outcome === 'effect-data') {
    const keys = Object.hasOwn(value, 'truncated')
      ? ['outcome', 'commandName', 'effect', 'data', 'truncated']
      : ['outcome', 'commandName', 'effect', 'data']
    const state = { nodes: 2048 }
    return hasExactKeys(value, keys)
      && typeof value.commandName === 'string'
      && value.commandName.length > 0
      && value.commandName.length <= 128
      && typeof value.effect === 'string'
      && value.effect.length > 0
      && value.effect.length <= 128
      && isPlainRecord(value.data)
      && isNativeCommandJsonValue(value.data, state)
      && (!Object.hasOwn(value, 'truncated') || typeof value.truncated === 'boolean')
      && (jsonByteLength(value) ?? Number.POSITIVE_INFINITY) <= COMMAND_EFFECT_DATA_MAX_BYTES
  }
  if (value.outcome === 'menu-request') {
    const keys = Object.hasOwn(value, 'selection')
      ? ['outcome', 'commandName', 'menu', 'initialState', 'binding', 'menuId', 'selection']
      : ['outcome', 'commandName', 'menu', 'initialState', 'binding', 'menuId']
    const state = { nodes: 2048 }
    return hasExactKeys(value, keys)
      && typeof value.commandName === 'string'
      && value.commandName.length > 0
      && value.commandName.length <= 128
      && MENU_KINDS.includes(value.menu as NativeCommandMenuKind)
      && isPlainRecord(value.initialState)
      && isNativeCommandJsonValue(value.initialState, state)
      && isMenuBinding(value.binding)
      && typeof value.menuId === 'string'
      && /^[0-9a-f-]{36}$/i.test(value.menuId)
      && (!Object.hasOwn(value, 'selection') || isMenuSelectionSchema(value.selection))
      && (jsonByteLength(value) ?? Number.POSITIVE_INFINITY) <= COMMAND_MENU_MAX_BYTES
  }
  if (value.outcome === 'cancelled') {
    return hasExactKeys(value, ['outcome', 'commandName'])
      && typeof value.commandName === 'string'
      && value.commandName.length > 0
      && value.commandName.length <= 128
  }
  return (value.outcome === 'dispatched' || value.outcome === 'builtin-adapter-pending')
    && hasExactKeys(value, ['outcome', 'commandName'])
    && typeof value.commandName === 'string'
    && value.commandName.length > 0
    && value.commandName.length <= 128
}
