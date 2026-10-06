import type { AgentSession, ResolvedCommand } from '@earendil-works/pi-coding-agent'
import { BUILTIN_SLASH_COMMANDS } from '../../../vendor/pi/packages/coding-agent/src/core/slash-commands.ts'
import type {
  CommandCatalogDiagnostic,
  CommandCatalogEntry,
  CommandCatalogResponse,
  CommandSource,
} from '../../shared/commands.ts'

const MAX_COMMANDS = 512
const MAX_DIAGNOSTICS = 128
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function boundedText(value: string | undefined, maxLength: number): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function isCommandName(value: unknown): value is string {
  return typeof value === 'string' && COMMAND_NAME_PATTERN.test(value)
}

function getAliases(command: ResolvedCommand): string[] {
  const aliases = (command as ResolvedCommand & { readonly aliases?: readonly unknown[] }).aliases
  if (!Array.isArray(aliases)) return []
  return [...new Set(aliases.filter(isCommandName))].slice(0, 32)
}

export class CommandCatalog {
  private readonly getSession: () => AgentSession | undefined
  private cachedSession: AgentSession | undefined
  private cachedSnapshot: CommandCatalogResponse | undefined
  private lookup = new Map<string, CommandCatalogEntry>()
  private revision = 0

  constructor(getSession: () => AgentSession | undefined) {
    this.getSession = getSession
  }

  /** Invalidate after resource or extension registrations change in the active session. */
  invalidate(): void {
    this.revision += 1
    this.cachedSnapshot = undefined
    this.cachedSession = undefined
    this.lookup.clear()
  }

  getSnapshot(refresh = false): CommandCatalogResponse {
    const session = this.getSession()
    if (!refresh && this.cachedSnapshot && this.cachedSession === session) return this.cachedSnapshot
    const snapshot = this.build(session)
    this.cachedSession = session
    this.cachedSnapshot = snapshot
    return snapshot
  }

  find(name: string, refresh = false): CommandCatalogEntry | undefined {
    this.getSnapshot(refresh)
    return this.lookup.get(name)
  }

  private build(session: AgentSession | undefined): CommandCatalogResponse {
    const commands: CommandCatalogEntry[] = []
    const diagnostics: CommandCatalogDiagnostic[] = []
    const lookup = new Map<string, CommandCatalogEntry>()
    const aliasesByName = new Map<string, readonly string[]>()
    const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map(({ name }) => name))

    const add = (
      name: string,
      source: CommandSource,
      description: string | undefined,
      argumentHint?: string,
      aliases: readonly string[] = [],
    ): void => {
      if (commands.length >= MAX_COMMANDS || !isCommandName(name) || lookup.has(name)) return
      const entry: CommandCatalogEntry = Object.freeze({
        name,
        source,
        description: boundedText(description, 512),
        argumentHint: argumentHint ? boundedText(argumentHint, 256) || null : null,
        aliases: Object.freeze([]),
      })
      commands.push(entry)
      lookup.set(name, entry)
      aliasesByName.set(name, aliases)
    }

    for (const builtin of BUILTIN_SLASH_COMMANDS) {
      add(builtin.name, 'builtin', builtin.description, builtin.argumentHint)
    }

    if (session) {
      for (const command of session.extensionRunner.getRegisteredCommands()) {
        const name = command.invocationName
        if (builtinNames.has(command.name) || builtinNames.has(name)) {
          if (diagnostics.length < MAX_DIAGNOSTICS) {
            diagnostics.push(Object.freeze({
              type: 'extension-shadowed-builtin',
              name: boundedText(command.name, 128),
              invocationName: boundedText(name, 128),
              message: name === command.name
                ? `Extension command '/${boundedText(name, 128)}' is shadowed by a built-in command.`
                : `Built-in '/${boundedText(command.name, 128)}' takes precedence; extension command is available as '/${boundedText(name, 128)}'.`,
            }))
          }
        }
        add(name, 'extension', command.description, undefined, getAliases(command))
      }

      for (const template of session.promptTemplates) {
        add(template.name, 'template', template.description, template.argumentHint)
      }

      if (session.settingsManager.getEnableSkillCommands()) {
        for (const skill of session.resourceLoader.getSkills().skills) {
          add(`skill:${skill.name}`, 'skill', skill.description)
        }
      }
    }

    // Resolve aliases only after all canonical names are known so an alias cannot
    // shadow a later extension, template, or skill command.
    const resolvedCommands = commands.map((entry): CommandCatalogEntry => {
      const aliases: string[] = []
      for (const alias of aliasesByName.get(entry.name) ?? []) {
        if (alias !== entry.name && isCommandName(alias) && !lookup.has(alias) && !aliases.includes(alias)) {
          aliases.push(alias)
        }
      }
      const resolved = Object.freeze({ ...entry, aliases: Object.freeze(aliases) })
      lookup.set(entry.name, resolved)
      for (const alias of aliases) lookup.set(alias, resolved)
      return resolved
    })

    this.lookup = lookup
    return Object.freeze({
      revision: this.revision,
      commands: Object.freeze(resolvedCommands),
      diagnostics: Object.freeze(diagnostics),
    })
  }
}
