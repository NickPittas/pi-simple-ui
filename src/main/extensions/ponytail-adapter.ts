/**
 * App-side description and routing metadata for @dietrichgebert/ponytail.
 * Command effects remain owned by the installed Pi extension; this module only
 * classifies its public command surface for the desktop command inventory.
 */

export interface InstalledExtensionCommandArgument {
  readonly name: string
  readonly description: string
  readonly required: boolean
  readonly type: 'text' | 'choice'
  readonly choices?: readonly InstalledExtensionCommandMenuItem[]
}

export interface InstalledExtensionCommandMenuItem {
  readonly value: string
  readonly label: string
  readonly description?: string
  readonly children?: readonly InstalledExtensionCommandMenuItem[]
}

export interface InstalledExtensionCommandMenu {
  readonly id: string
  readonly title: string
  readonly items: readonly InstalledExtensionCommandMenuItem[]
  /** True when the actual extension decides whether to show this menu. */
  readonly conditional?: boolean
}

export interface InstalledExtensionCommand {
  readonly name: string
  readonly description: string
  readonly args: readonly InstalledExtensionCommandArgument[]
  readonly menus?: readonly InstalledExtensionCommandMenu[]
}

/** Shared descriptor shape for the installed-extension inventory (T11). */
export interface InstalledExtensionCommandSurface {
  readonly packageName: string
  readonly extensionPath: string
  readonly commands: readonly InstalledExtensionCommand[]
}

const RUNTIME_MODES = ['off', 'lite', 'full', 'ultra'] as const

const modeChoices: readonly InstalledExtensionCommandMenuItem[] = Object.freeze(RUNTIME_MODES.map((mode) => Object.freeze({
  value: mode,
  label: mode,
})))

const commandChoices: readonly InstalledExtensionCommandMenuItem[] = Object.freeze([
  Object.freeze({ value: 'status', label: 'status' }),
  Object.freeze({ value: 'default', label: 'default <mode>', children: modeChoices }),
  ...modeChoices,
])

const ponytailMenu: InstalledExtensionCommandMenu = {
  id: 'ponytail-command',
  title: 'Ponytail',
  items: [
    { value: 'status', label: 'Status', description: 'Show the current and default modes.' },
    {
      value: 'default',
      label: 'Set default mode',
      description: 'Persist a runtime mode for new sessions.',
      children: modeChoices,
    },
    ...modeChoices.map((choice) => ({
      ...choice,
      description: 'Set the mode for this session.',
    })),
  ],
}

/** Exact registered command names and descriptions from pi-extension/index.js. */
export const ponytailCommandSurface: InstalledExtensionCommandSurface = Object.freeze({
  packageName: '@dietrichgebert/ponytail',
  extensionPath: 'pi-extension/index.js',
  commands: Object.freeze([
    Object.freeze({
      name: 'ponytail',
      description: 'Set mode: off|lite|full|ultra. Commands: status, default <mode>',
      args: Object.freeze([{
        name: 'command-or-mode',
        description: 'status, default <runtime mode>, or a runtime mode; omitted uses the configured default.',
        required: false,
        type: 'choice' as const,
        choices: commandChoices,
      }]),
      menus: Object.freeze([ponytailMenu]),
    }),
    ...([
      ['ponytail-review', 'Run /skill:ponytail-review'],
      ['ponytail-audit', 'Run /skill:ponytail-audit'],
      ['ponytail-gain', 'Run /skill:ponytail-gain'],
      ['ponytail-debt', 'Run /skill:ponytail-debt'],
      ['ponytail-help', 'Run /skill:ponytail-help'],
    ] as const).map(([name, description]) => Object.freeze({
      name,
      description,
      args: Object.freeze([]),
    })),
  ]),
})

export type PonytailMode = 'off' | 'lite' | 'full' | 'ultra' | 'review'
export type PonytailSkillAlias = 'ponytail-review' | 'ponytail-audit' | 'ponytail-debt' | 'ponytail-gain' | 'ponytail-help'

export type PonytailCommandAction =
  | { readonly type: 'status' }
  | { readonly type: 'set-mode'; readonly mode: 'off' | 'lite' | 'full' | 'ultra' }
  | { readonly type: 'set-default'; readonly mode: 'off' | 'lite' | 'full' | 'ultra' }
  | { readonly type: 'invalid'; readonly reason: 'invalid-mode' | 'invalid-default-mode'; readonly mode?: string }
  | { readonly type: 'skill-alias'; readonly skill: PonytailSkillAlias }

export interface PonytailWorkflow {
  /** The installed extension still performs the action through native Pi dispatch. */
  readonly kind: 'native-command'
  readonly commandName: string
  readonly action: PonytailCommandAction
}

/**
 * Ponytail's status-bar renderer reads `ctx.ui.theme`; the RPC bridge deliberately
 * does not expose theme objects, and Ponytail catches that unsupported access.
 * The command notification and mode/config effects still work natively, but the
 * persistent themed indicator needs a host-rendered equivalent to be restored.
 */
export const ponytailStatusIndicatorHostGap = Object.freeze({
  kind: 'host-action-required' as const,
  capabilityId: 'extension-ui.theme-or-host-status-renderer' as const,
  packageName: '@dietrichgebert/ponytail',
  operation: 'render persistent ponytail status indicator',
  bridgeGap: 'The extension UI bridge does not provide theme objects; Ponytail catches this and skips setStatus.',
})

function normalizeRuntimeMode(value: string | undefined): 'off' | 'lite' | 'full' | 'ultra' | undefined {
  const mode = value?.trim().toLowerCase()
  return RUNTIME_MODES.includes(mode as (typeof RUNTIME_MODES)[number])
    ? mode as 'off' | 'lite' | 'full' | 'ultra'
    : undefined
}

/**
 * Classify a Ponytail command without applying it. Native extension handlers
 * continue to own config writes, session entries, notifications, and skill sends.
 */
export function adaptPonytailCommand(
  commandName: string,
  args = '',
  state: { readonly defaultMode?: string; readonly currentMode?: PonytailMode | null } = {},
): PonytailWorkflow | undefined {
  if (commandName !== 'ponytail') {
    if (!['ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help'].includes(commandName)) {
      return undefined
    }
    const alias = commandName as PonytailSkillAlias
    return { kind: 'native-command', commandName, action: { type: 'skill-alias', skill: alias } }
  }

  const [primary, secondary] = String(args).trim().toLowerCase().split(/\s+/)
  const defaultMode = normalizeRuntimeMode(state.defaultMode) ?? 'full'
  let action: PonytailCommandAction

  if (!primary) {
    action = state.currentMode && state.currentMode !== 'off'
      ? { type: 'status' }
      : { type: 'set-mode', mode: defaultMode === 'off' ? 'full' : defaultMode }
  } else if (primary === 'status') {
    action = { type: 'status' }
  } else if (primary === 'default') {
    const mode = normalizeRuntimeMode(secondary)
    action = mode
      ? { type: 'set-default', mode }
      : { type: 'invalid', reason: 'invalid-default-mode' }
  } else {
    const mode = normalizeRuntimeMode(primary)
    action = mode
      ? { type: 'set-mode', mode }
      : { type: 'invalid', reason: 'invalid-mode', mode: primary }
  }

  return { kind: 'native-command', commandName, action }
}
