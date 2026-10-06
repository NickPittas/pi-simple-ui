/**
 * Declarative command coverage for installed extension families not owned by the
 * dedicated Ponytail/Headroom adapters. These descriptors do not emulate extension
 * code: host-action entries name capabilities that must be implemented before the
 * associated command can be routed safely.
 */
import { installedExtensionInventory } from './installed-inventory.ts'
import { headroomCommandSurface } from './headroom-adapter.ts'
import {
  ponytailCommandSurface,
  type InstalledExtensionCommandSurface as SharedInstalledExtensionCommandSurface,
} from './ponytail-adapter.ts'

export type InstalledExtensionCommandSurface = SharedInstalledExtensionCommandSurface

export type InstalledCommandDisposition = 'route-natively' | 'needs-host-action'

/** Typed, deliberately unimplemented host operations required by installed commands. */
export type InstalledCommandHostAction =
  | {
      readonly id: '@jmcombs/pi-1password.onboardSecret'
      readonly request: { readonly name: 'headroom'; readonly label: 'Headroom' }
      readonly response: { readonly ok: boolean; readonly message: string }
    }
  | {
      readonly id: 'onepassword.cli.diagnose'
      readonly request: { readonly cwd: string }
      readonly response: { readonly report: string; readonly error?: string }
    }
  | {
      readonly id: 'onepassword.cli.setup'
      readonly request: {
        readonly action: 'list-vaults' | 'list-items' | 'list-fields' | 'validate-reference'
        readonly vault?: string
        readonly item?: string
        readonly opReference?: string
      }
      readonly response: { readonly options?: readonly { readonly id: string; readonly label: string }[]; readonly valid?: boolean; readonly error?: string }
    }
  | {
      readonly id: 'onepassword.auth.write'
      readonly request: { readonly entry: '!op read …'; readonly authPath: string }
      readonly response: { readonly saved: boolean; readonly error?: string }
    }
  | {
      readonly id: 'quota.usage.fetch'
      readonly request: { readonly provider: string; readonly cwd: string; readonly authResolution: 'native-provider-auth' }
      readonly response: { readonly status: 'ok' | 'partial' | 'unsupported' | 'unknown'; readonly display?: string; readonly json?: unknown }
    }
  | {
      readonly id: 'quota.har.read'
      readonly request: { readonly cwd: string; readonly path: string }
      readonly response: { readonly utf8: string; readonly error?: string }
    }
  | {
      readonly id: 'quota.auth.write'
      readonly request: { readonly provider: 'anthropic-subscription'; readonly configuration: Readonly<Record<string, unknown>> }
      readonly response: { readonly saved: boolean; readonly authPath: string; readonly error?: string }
    }
  | {
      readonly id: 'herdr.cli.execute'
      readonly request: { readonly executable: 'herdr'; readonly args: readonly string[]; readonly cwd?: string; readonly timeoutMs?: number }
      readonly response: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
    }
  | {
      readonly id: 'subagents.process.fork'
      readonly request: { readonly task: string; readonly agent?: string; readonly cwd: string; readonly mode: 'iterate' | 'subagent' | 'plan' | 'btw' }
      readonly response: { readonly sessionId?: string; readonly worktreePath?: string; readonly accepted: boolean; readonly error?: string }
    }
  | {
      readonly id: 'subagents.worktree.manage'
      readonly request: { readonly action: 'create' | 'list' | 'remove'; readonly target?: string; readonly cwd: string }
      readonly response: { readonly worktrees: readonly { readonly path: string; readonly label?: string }[]; readonly error?: string }
    }
  | {
      readonly id: 'subagents.manager.open'
      readonly request: { readonly section: 'agents' | 'workflows' | 'settings'; readonly selectedAgent?: string }
      readonly response: { readonly section: string; readonly selectedAgent?: string; readonly cancelled: boolean }
    }
  | {
      readonly id: 'subagents.settings.read-write'
      readonly request: { readonly action: 'read' | 'write'; readonly value?: Readonly<Record<string, unknown>> }
      readonly response: { readonly value?: Readonly<Record<string, unknown>>; readonly saved?: boolean; readonly error?: string }
    }
  | {
      readonly id: 'tasks.manager.open'
      readonly request: { readonly cwd: string; readonly scope: 'session' | 'project' | 'global' }
      readonly response: { readonly action?: 'create' | 'update' | 'clear-completed' | 'close'; readonly payload?: unknown }
    }
  | {
      readonly id: 'tasks.store.read-write'
      readonly request: { readonly action: 'read' | 'create' | 'update' | 'clear-completed'; readonly scope: 'session' | 'project' | 'global'; readonly payload?: unknown }
      readonly response: { readonly tasks: readonly unknown[]; readonly saved?: boolean; readonly error?: string }
    }
  | {
      readonly id: 'intercom.sessions.list'
      readonly request: { readonly cwd: string; readonly includeRemote: boolean }
      readonly response: { readonly sessions: readonly { readonly id: string; readonly label?: string; readonly cwd?: string; readonly state?: string }[] }
    }
  | {
      readonly id: 'intercom.overlay.open'
      readonly request: { readonly sessionId: string; readonly view: 'inbox' | 'session' }
      readonly response: { readonly selectedSessionId?: string; readonly dismissed: boolean }
    }
  | {
      readonly id: 'intercom.message.send'
      readonly request: { readonly targetSessionId: string; readonly text: string; readonly kind: 'reply' | 'handover'; readonly expectsReply: boolean }
      readonly response: { readonly messageId: string; readonly sent: boolean; readonly error?: string }
    }
  | {
      readonly id: 'intercom.editor.insert'
      readonly request: { readonly text: string; readonly insertion: 'append' | 'replace' }
      readonly response: { readonly inserted: boolean }
    }
  | {
      readonly id: 'intercom.alias.persist'
      readonly request: { readonly sessionId: string; readonly alias: string }
      readonly response: { readonly saved: boolean; readonly error?: string }
    }
  | {
      readonly id: 'preview.render.open'
      readonly request: { readonly source: 'selection' | 'file'; readonly path?: string; readonly format: 'markdown' | 'html' | 'terminal' }
      readonly response: { readonly opened: boolean; readonly windowId?: string; readonly error?: string }
    }
  | {
      readonly id: 'preview.browser.open'
      readonly request: { readonly urlOrPath: string; readonly watch: boolean }
      readonly response: { readonly windowId: string; readonly opened: boolean; readonly error?: string }
    }
  | {
      readonly id: 'preview.pdf.export-open'
      readonly request: { readonly source: string; readonly cwd: string }
      readonly response: { readonly pdfPath?: string; readonly opened: boolean; readonly error?: string }
    }
  | {
      readonly id: 'preview.cache.clear'
      readonly request: { readonly cacheDirectory: string }
      readonly response: { readonly cleared: boolean; readonly error?: string }
    }
  | {
      readonly id: 'multi-account.accounts.read'
      readonly request: { readonly provider?: string; readonly refresh: boolean }
      readonly response: { readonly accounts: readonly { readonly provider: string; readonly accountId: string; readonly state: string }[] }
    }
  | {
      readonly id: 'multi-account.provider.switch'
      readonly request: { readonly provider: string; readonly accountId?: string; readonly strategy: 'best' | 'next' | 'explicit' }
      readonly response: { readonly switched: boolean; readonly provider?: string; readonly accountId?: string; readonly error?: string }
    }
  | {
      readonly id: 'multi-account.oauth.authenticate'
      readonly request: { readonly provider: 'anthropic' | 'openai-codex' | 'kimi' | 'cursor' | 'ollama' | 'qwen' | string; readonly action: 'add' | 'refresh' | 'remove' }
      readonly response: { readonly authenticated: boolean; readonly accountId?: string; readonly error?: string }
    }
  | {
      readonly id: 'multi-account.config.read-write'
      readonly request: { readonly action: 'read' | 'write'; readonly patch?: Readonly<Record<string, unknown>> }
      readonly response: { readonly configuration: Readonly<Record<string, unknown>>; readonly saved?: boolean; readonly error?: string }
    }
  | {
      readonly id: 'powerline.queue.read-write-send'
      readonly request: { readonly action: 'read' | 'send' | 'retry' | 'clear' | 'target' | 'alias'; readonly itemId?: string; readonly value?: string }
      readonly response: { readonly items: readonly unknown[]; readonly changed?: boolean; readonly sent?: boolean; readonly error?: string }
    }
  | {
      readonly id: 'powerline.editor.quote-insert'
      readonly request: { readonly messageSelector: string; readonly insertion: 'append' | 'replace' }
      readonly response: { readonly inserted: boolean; readonly error?: string }
    }
  | {
      readonly id: 'powerline.session.switch-directory'
      readonly request: { readonly cwd: string; readonly targetPath: string }
      readonly response: { readonly switched: boolean; readonly cancelled?: boolean; readonly error?: string }
    }
  | {
      readonly id: 'powerline.shell.manage'
      readonly request: { readonly action: 'activate' | 'deactivate' | 'reset'; readonly command?: string }
      readonly response: { readonly active: boolean; readonly error?: string }
    }
  | {
      readonly id: 'powerline.history.read'
      readonly request: { readonly cwd: string; readonly query?: string }
      readonly response: { readonly entries: readonly { readonly text: string; readonly timestamp?: number }[] }
    }
  | {
      readonly id: 'powerline.settings.read-write'
      readonly request: { readonly scope: 'global' | 'project'; readonly patch: Readonly<Record<string, unknown>> }
      readonly response: { readonly saved: boolean; readonly path?: string; readonly error?: string }
    }
  | {
      readonly id: 'web-access.search.open-curator'
      readonly request: { readonly query: string; readonly workflow: string }
      readonly response: { readonly opened: boolean; readonly curatorId?: string; readonly error?: string }
    }
  | {
      readonly id: 'web-access.search.execute'
      readonly request: { readonly query: string; readonly provider?: string; readonly limit?: number }
      readonly response: { readonly results: readonly { readonly title: string; readonly url: string; readonly snippet?: string }[]; readonly error?: string }
    }
  | {
      readonly id: 'web-access.search.stored-results'
      readonly request: { readonly query?: string }
      readonly response: { readonly results: readonly { readonly id: string; readonly title: string; readonly url: string }[] }
    }
  | {
      readonly id: 'web-access.google-account.read'
      readonly request: { readonly browserCookieAccessAllowed: boolean }
      readonly response: { readonly available: boolean; readonly account?: string; readonly error?: string }
    }

export type InstalledCommandHostActionId = InstalledCommandHostAction['id']
export type InstalledCommandHostActionRequest<Id extends InstalledCommandHostActionId> =
  Extract<InstalledCommandHostAction, { readonly id: Id }>['request']
export type InstalledCommandHostActionResponse<Id extends InstalledCommandHostActionId> =
  Extract<InstalledCommandHostAction, { readonly id: Id }>['response']

export interface InstalledExtensionCommandRouteDescriptor {
  readonly packageName: string
  readonly family: string
  readonly commands: readonly {
    /** Every name is an exact source-registered slash-command spelling. */
    readonly name: string
    readonly disposition: InstalledCommandDisposition
    readonly hostActions: readonly InstalledCommandHostActionId[]
  }[]
}

const native = (name: string) => ({ name, disposition: 'route-natively' as const, hostActions: [] as const })
const host = (name: string, hostActions: readonly InstalledCommandHostActionId[]) => ({
  name,
  disposition: 'needs-host-action' as const,
  hostActions,
})

function toInventorySurface(extension: (typeof installedExtensionInventory)[number]): InstalledExtensionCommandSurface {
  const commands = extension.commands.flatMap((command) => [command.name, ...command.aliases].map((name) => ({
    name,
    description: command.description,
    args: command.argHint === null && /^No arguments\b/i.test(command.menuOrArgs)
      ? []
      : [{
          name: 'args',
          description: command.argHint ?? command.menuOrArgs,
          required: false,
          type: 'text' as const,
        }],
  })))
  return {
    packageName: extension.packageName,
    extensionPath: extension.sourceRef.split(' (')[0].split(';')[0],
    commands,
  }
}

/** Shared descriptor shape from ponytail-adapter.ts, populated from the source snapshot. */
export const installedExtensionCommandSurfaces: readonly InstalledExtensionCommandSurface[] = [
  ponytailCommandSurface,
  headroomCommandSurface,
  ...installedExtensionInventory
    .filter((extension) => extension.packageName !== '@dietrichgebert/ponytail' && extension.packageName !== '@jmcombs/pi-headroom')
    .map(toInventorySurface),
]

/** Command route ledger; command spellings are cross-checked against inventory source refs. */
export const installedExtensionCommandRoutes: readonly InstalledExtensionCommandRouteDescriptor[] = [
  {
    packageName: '@dietrichgebert/ponytail',
    family: 'ponytail',
    commands: [
      native('ponytail'),
      native('ponytail-review'),
      native('ponytail-audit'),
      native('ponytail-gain'),
      native('ponytail-debt'),
      native('ponytail-help'),
    ],
  },
  {
    packageName: '@jmcombs/pi-headroom',
    family: 'headroom',
    commands: [
      native('headroom-status'),
      host('headroom_setup', ['@jmcombs/pi-1password.onboardSecret']),
      native('headroom-stats'),
      native('headroom-simulate'),
    ],
  },
  {
    packageName: '@ff-labs/pi-fff',
    family: 'fff',
    commands: [
      native('fff-health'),
      native('fff-mode'),
      native('fff-rescan'),
    ],
  },
  {
    packageName: '@heyhuynhgiabuu/pi-pretty',
    family: 'fff-shared-registrations',
    commands: [
      native('fff-health'),
      native('fff-rescan'),
    ],
  },
  {
    packageName: '@jmcombs/pi-1password',
    family: 'onepassword',
    commands: [
      host('1password_diagnose', ['onepassword.cli.diagnose']),
      host('1password_setup', ['onepassword.cli.setup', 'onepassword.auth.write']),
    ],
  },
  {
    packageName: '@mjfuertesf/pi-quota-status',
    family: 'quota-status',
    commands: [
      host('quota-status-usage', ['quota.usage.fetch']),
      host('quota-status-extract', ['quota.har.read', 'quota.auth.write']),
    ],
  },
  {
    packageName: '@tintinweb/pi-subagents',
    family: 'subagents-manager',
    commands: [host('agents', ['subagents.manager.open', 'subagents.settings.read-write'])],
  },
  {
    packageName: '@tintinweb/pi-tasks',
    family: 'tasks',
    commands: [host('tasks', ['tasks.manager.open', 'tasks.store.read-write'])],
  },
  {
    packageName: 'pi-herdr-agents',
    family: 'herdr-agents',
    commands: [
      host('subagents-init', ['subagents.settings.read-write']),
      host('btw', ['herdr.cli.execute', 'subagents.process.fork']),
      host('btw-close', ['herdr.cli.execute']),
      host('worktree', ['herdr.cli.execute', 'subagents.worktree.manage']),
      host('iterate', ['herdr.cli.execute', 'subagents.process.fork']),
      host('subagent', ['herdr.cli.execute', 'subagents.process.fork']),
      host('plan', ['herdr.cli.execute', 'subagents.process.fork']),
    ],
  },
  {
    packageName: 'pi-intercom',
    family: 'intercom',
    commands: [
      host('intercom', ['intercom.sessions.list', 'intercom.overlay.open']),
      host('intercom-id', ['intercom.editor.insert']),
      host('alias', ['intercom.alias.persist', 'intercom.sessions.list']),
      host('handover', ['intercom.sessions.list', 'intercom.message.send']),
    ],
  },
  {
    packageName: 'pi-markdown-preview',
    family: 'markdown-preview',
    commands: [
      host('preview', ['preview.render.open', 'preview.browser.open', 'preview.pdf.export-open']),
      host('preview-browser', ['preview.browser.open']),
      host('preview-pdf', ['preview.pdf.export-open']),
      host('preview-clear-cache', ['preview.cache.clear']),
    ],
  },
  {
    packageName: 'pi-multi-account',
    family: 'multi-account',
    commands: [
      host('multi-account', ['multi-account.accounts.read', 'multi-account.provider.switch', 'multi-account.oauth.authenticate', 'multi-account.config.read-write']),
      host('provider-failover', ['multi-account.accounts.read', 'multi-account.provider.switch', 'multi-account.oauth.authenticate', 'multi-account.config.read-write']),
      host('failover', ['multi-account.accounts.read', 'multi-account.provider.switch', 'multi-account.oauth.authenticate', 'multi-account.config.read-write']),
    ],
  },
  {
    packageName: 'pi-powerline-footer',
    family: 'powerline-footer',
    commands: [
      host('reply', ['powerline.editor.quote-insert']),
      host('queue', ['powerline.queue.read-write-send']),
      host('powerline', ['powerline.settings.read-write']),
      host('stash-history', ['powerline.history.read']),
      host('bash-mode', ['powerline.shell.manage', 'powerline.settings.read-write']),
      native('powerline-perf'),
      host('bash-reset', ['powerline.shell.manage']),
      host('vibe', ['powerline.settings.read-write']),
      host('cd', ['powerline.session.switch-directory']),
    ],
  },
  {
    packageName: 'pi-web-access',
    family: 'web-access',
    commands: [
      host('websearch', ['web-access.search.open-curator', 'web-access.search.execute']),
      host('curator', ['web-access.search.open-curator']),
      host('google-account', ['web-access.google-account.read']),
      host('search', ['web-access.search.stored-results']),
    ],
  },
]

/**
 * Event hooks remain owned by Pi's native extension runtime. These are not command
 * adapters; this records whether the extension UI bridge covers UI calls made by hooks.
 * `coveredOperations` are bridged by extension-ui-bridge.ts; unsupported operations are
 * intentionally surfaced rather than pretending arbitrary terminal UI is available.
 */
export interface NativeHookUIBridgeCoverage {
  readonly packageName: string
  readonly hooks: readonly string[]
  readonly coveredOperations: readonly string[]
  readonly uncoveredOperations: readonly string[]
  readonly adapterNeeded: false
  readonly note: string
}

export const nativeHookUIBridgeCoverage: readonly NativeHookUIBridgeCoverage[] = [
  {
    packageName: '@juicesharp/rpiv-ask-user-question',
    hooks: ['before_agent_start'],
    coveredOperations: ['notify', 'select', 'confirm', 'input', 'editor'],
    uncoveredOperations: ['custom', 'onTerminalInput'],
    adapterNeeded: false,
    note: 'The hook itself is native and has no slash commands. Questionnaire fallback dialogs map to bridged select/input/confirm/editor, but the canonical custom tabbed overlay and raw terminal-input listener are explicitly unsupported by the current bridge.',
  },
  {
    packageName: '@heyhuynhgiabuu/pi-pretty',
    hooks: ['session_start', 'session_info_changed', 'agent_start', 'agent_end', 'agent_settled', 'message_update', 'message_end', 'session_shutdown'],
    coveredOperations: ['notify', 'setWorkingVisible', 'setWorkingIndicator'],
    uncoveredOperations: ['theme', 'setToolsExpanded'],
    adapterNeeded: false,
    note: 'Hooks stay native. Its UI notifications/working indicator calls are bridged; theme and tools-expanded customization are not. The conditional FFF command registrations are listed separately in its command surface.',
  },
  {
    packageName: 'pi-memory',
    hooks: ['session_start', 'session_shutdown', 'input', 'before_agent_start', 'session_before_compact'],
    coveredOperations: ['notify'],
    uncoveredOperations: ['onTerminalInput', 'getEditorText'],
    adapterNeeded: false,
    note: 'Hooks stay native and notification is bridged. The optional terminal-input/editor-empty shortcut uses methods explicitly unsupported by the current bridge.',
  },
]

/** Command adapters implemented in parallel; intentionally no duplicate descriptors here. */
export const separatelyAdaptedInstalledCommandPackages = [
  '@dietrichgebert/ponytail',
  '@jmcombs/pi-headroom',
] as const

/** Return installed command spellings that have neither a local descriptor nor a lane adapter. */
export function getUnadaptedInstalledCommandNames(): readonly { packageName: string; name: string; sourceRef: string }[] {
  return installedExtensionInventory.flatMap((extension) => {
    const routes = installedExtensionCommandRoutes.find((candidate) => candidate.packageName === extension.packageName)
    return extension.commands.flatMap((command) => {
      const names = [command.name, ...command.aliases]
      return names
        .filter((name) => !routes?.commands.some((candidate) => candidate.name === name))
        .map((name) => ({ packageName: extension.packageName, name, sourceRef: command.sourceRef }))
    })
  })
}

/** Installed packages in the snapshot with no registerCommand call in their entrypoint. */
export const installedPackagesWithoutSlashCommands = [
  '@ogulcancelik/pi-herdr',
  '@juicesharp/rpiv-ask-user-question',
  'pi-memory',
] as const
