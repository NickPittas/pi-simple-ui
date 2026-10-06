/**
 * Snapshot of the Pi extension packages installed in the agent npm catalog when this
 * inventory was read. T31's dynamic reload refreshes the live catalog at runtime; this
 * source-derived snapshot is for adapter-coverage tracking and command/settings UIs.
 */

export interface InstalledCommandInventoryEntry {
  readonly name: string
  /** Alias spellings registered to the same handler; separately registered synonyms count. */
  readonly aliases: readonly string[]
  readonly description: string
  /** `null` means the source registration does not supply an argHint. */
  readonly argHint: string | null
  /** Source-derived prompt/menu or argument behavior, not an inferred command schema. */
  readonly menuOrArgs: string
  /** Shared command name group, including collision with a Pi-native command where applicable. */
  readonly collisionGroup: string | null
  readonly sourceRef: string
  /** Source condition that makes this registration conditional, if any. */
  readonly registrationCondition?: string
  /** Effective ownership must follow Pi's native command precedence for this name. */
  readonly precedenceNote?: string
}

export interface InstalledExtensionInventoryEntry {
  readonly packageName: string
  readonly version: string
  /** Entrypoint selected by the package.json `pi.extensions` declaration. */
  readonly sourceRef: string
  readonly commands: readonly InstalledCommandInventoryEntry[]
  /** Unique native Pi event names registered by the package's loaded extension source. */
  readonly hooks: readonly string[]
  /** Settings, flags, environment and other persistent configuration surfaces from source. */
  readonly settingsSurface: string
}

const entry = (
  name: string,
  description: string,
  menuOrArgs: string,
  sourceRef: string,
  options: {
    aliases?: readonly string[]
    argHint?: string | null
    collisionGroup?: string | null
    registrationCondition?: string
    precedenceNote?: string
  } = {},
): InstalledCommandInventoryEntry => ({
  name,
  aliases: options.aliases ?? [],
  description,
  argHint: options.argHint ?? null,
  menuOrArgs,
  collisionGroup: options.collisionGroup ?? null,
  sourceRef,
  ...(options.registrationCondition ? { registrationCondition: options.registrationCondition } : {}),
  ...(options.precedenceNote ? { precedenceNote: options.precedenceNote } : {}),
})

/** Source refs are package-relative and point at the actual registration call. */
export const installedExtensionInventory: readonly InstalledExtensionInventoryEntry[] = [
  {
    packageName: '@dietrichgebert/ponytail',
    version: '4.10.3',
    sourceRef: 'pi-extension/index.js (package.json pi.extensions[0])',
    commands: [
      entry('ponytail', 'Set mode: off|lite|full|ultra. Commands: status, default <mode>', '[off|lite|full|ultra|status|default <mode>]; empty turns on the default mode or reports current mode', 'pi-extension/index.js:116'),
      entry('ponytail-review', 'Run /skill:ponytail-review', 'No arguments; sends the review skill alias', 'pi-extension/index.js:151'),
      entry('ponytail-audit', 'Run /skill:ponytail-audit', 'No arguments; sends the audit skill alias', 'pi-extension/index.js:156'),
      entry('ponytail-gain', 'Run /skill:ponytail-gain', 'No arguments; sends the gain skill alias', 'pi-extension/index.js:161'),
      entry('ponytail-debt', 'Run /skill:ponytail-debt', 'No arguments; sends the debt skill alias', 'pi-extension/index.js:166'),
      entry('ponytail-help', 'Run /skill:ponytail-help', 'No arguments; sends the help skill alias', 'pi-extension/index.js:171'),
    ],
    hooks: ['input', 'session_start', 'agent_start', 'agent_end', 'before_agent_start'],
    settingsSurface: 'Ponytail mode/default configuration and environment override, read through hooks/ponytail-config.js; no Pi settings schema is registered.',
  },
  {
    packageName: '@ff-labs/pi-fff',
    version: '0.11.0',
    sourceRef: 'src/index.ts (package.json pi.extensions[0])',
    commands: [
      entry('fff-mode', 'Show or set FFF mode: /fff-mode [tools-and-ui | tools-only | override]', '[tools-and-ui|tools-only|override]; no argument reports current mode', 'src/index.ts:1405'),
      entry('fff-health', 'Show FFF file finder health and status', 'No arguments; reports current indexer health', 'src/index.ts:1450', {
        collisionGroup: 'fff-health',
        precedenceNote: 'pi-pretty also conditionally registers /fff-health; the live Pi command catalog owns effective collision precedence.',
      }),
      entry('fff-rescan', 'Trigger FFF to rescan files', 'No arguments; triggers a full scan', 'src/index.ts:1484', {
        collisionGroup: 'fff-rescan',
        precedenceNote: 'pi-pretty also conditionally registers /fff-rescan; the live Pi command catalog owns effective collision precedence.',
      }),
    ],
    hooks: ['session_start', 'before_agent_start', 'session_shutdown'],
    settingsSurface: 'registerFlag surfaces: fff-mode, fff-frecency-db, fff-history-db, fff-enable-root-scan, fff-enable-home-scan, fff-follow-symlinks, fff-warn-home-scan; FFF config module also reads mode, scan paths, root/home scan and symlink preferences.',
  },
  {
    packageName: '@heyhuynhgiabuu/pi-pretty',
    version: '0.6.30',
    sourceRef: 'src/index.ts (package.json pi.extensions[0])',
    commands: [
      entry('fff-health', 'Show FFF file finder health and indexer status', 'No arguments; registered only when the FFF service is available', 'src/index.ts:133', {
        collisionGroup: 'fff-health',
        registrationCondition: 'if (fffService)',
        precedenceNote: 'Shares /fff-health with @ff-labs/pi-fff; runtime native command resolution decides which registration is effective.',
      }),
      entry('fff-rescan', 'Trigger FFF to rescan files', 'No arguments; registered only when the FFF service is available', 'src/index.ts:170', {
        collisionGroup: 'fff-rescan',
        registrationCondition: 'if (fffService)',
        precedenceNote: 'Shares /fff-rescan with @ff-labs/pi-fff; runtime native command resolution decides which registration is effective.',
      }),
    ],
    hooks: ['session_start', 'session_info_changed', 'agent_start', 'agent_end', 'agent_settled', 'message_update', 'message_end', 'session_shutdown'],
    settingsSurface: '~/.pi/agent/pi-pretty.json: background, theme, icons, enabled/disabled tools, highlighting/preview/cache limits, workingIndicator, thinkingIndicator, and optional FFF home/root scan settings; optional pretty-fff-home-scan and pretty-fff-root-scan flags.',
  },
  {
    packageName: '@jmcombs/pi-1password',
    version: '2.3.2',
    sourceRef: 'index.ts (package.json pi.extensions[0])',
    commands: [
      entry('1password_diagnose', 'Run full 1Password diagnostics. Gathers op status, plugin configuration, and active injected variables, then presents a clean report directly (no extra user prompting required).', 'No arguments; runs the diagnostic report', 'index.ts:900'),
      entry('1password_setup', "Guided setup: pick from supported tools or enter a custom op:// reference, write '!op read ...' entry to ~/.pi/agent/auth.json for transparent injection.", 'No arguments; guided menu/picker then persists auth configuration', 'index.ts:926'),
    ],
    hooks: ['user_bash', 'session_start'],
    settingsSurface: '~/.pi/agent/auth.json receives the generated !op read entry; 1Password CLI/plugin configuration and injected variables are read for diagnostics.',
  },
  {
    packageName: '@jmcombs/pi-headroom',
    version: '2.0.1',
    sourceRef: 'index.ts (package.json pi.extensions[0])',
    commands: [
      entry('headroom-status', 'Report Headroom proxy health, version, mode, key settings, and session + proxy token savings.', 'No arguments; reports status', 'index.ts:744'),
      entry('headroom_setup', 'Set up or update your Headroom API key (never shown to the agent).', 'No arguments; guided setup prompt', 'index.ts:767'),
      entry('headroom-stats', 'Show detailed Headroom statistics: session + lifetime savings, request counts, proxy tuning, and a per-strategy breakdown.', 'No arguments; reports statistics', 'index.ts:782'),
      entry('headroom-simulate', 'Dry-run Headroom compression on pasted text (no LLM call): projected token savings + transforms.', 'Pasted text/arguments; simulation is local', 'index.ts:795'),
    ],
    hooks: ['context', 'session_start'],
    settingsSurface: 'registerFlag exposes Headroom disable and autoretrieve-disable switches; setup handles the Headroom API key without displaying it, with proxy/session values read from its source configuration.',
  },
  {
    packageName: '@juicesharp/rpiv-ask-user-question',
    version: '2.12.0',
    sourceRef: 'index.ts (package.json pi.extensions[0]); hook registration in reconcile.ts',
    commands: [],
    hooks: ['before_agent_start'],
    settingsSurface: 'Extension configuration is read by config.ts and the @juicesharp/rpiv-config package; the loaded entry registers no slash command.',
  },
  {
    packageName: '@mjfuertesf/pi-quota-status',
    version: '0.2.0',
    sourceRef: 'src/extension.ts (package.json pi.extensions[0])',
    commands: [
      entry('quota-status-usage', 'Fetch and print quota usage for the active provider. Use --json for structured output.', '[--json]; reads active provider/auth and emits a display message or print-mode output', 'src/commands/usage.ts:39'),
      entry('quota-status-extract', 'Extract quota-status provider auth config from a supported HAR export.', '[--write] [--no-verify] [--provider <anthropic-subscription>] <path/to/file.har>', 'src/commands/extract.ts:126'),
    ],
    hooks: ['session_start', 'model_select', 'turn_end', 'agent_end', 'session_compact', 'session_shutdown'],
    settingsSurface: 'Provider auth is read through modelRegistry/provider adapters; --write stores extracted Anthropic subscription config in ~/.pi/agent/auth.json under quota-status.anthropic-subscription.',
  },
  {
    packageName: '@ogulcancelik/pi-herdr',
    version: '0.4.0',
    sourceRef: 'index.ts (package.json pi.extensions[0])',
    commands: [],
    hooks: [],
    settingsSurface: 'No slash-command settings or settings registration found. The extension exposes Herdr process/layout tools and reads live Herdr state.',
  },
  {
    packageName: '@tintinweb/pi-subagents',
    version: '0.19.0',
    sourceRef: 'src/index.ts (package.json pi.extensions[0])',
    commands: [
      entry('agents', 'Manage agents', 'No arguments; opens the agents manager menu', 'src/index.ts:3968'),
    ],
    hooks: ['session_start', 'input', 'session_before_switch', 'session_shutdown', 'tool_execution_start'],
    settingsSurface: 'Package-owned subagent/workflow settings and agent definition files; the extension also registers the subagents-workflow-file flag.',
  },
  {
    packageName: '@tintinweb/pi-tasks',
    version: '0.9.0',
    sourceRef: 'src/index.ts (package.json pi.extensions[0])',
    commands: [
      entry('tasks', 'Manage tasks — view, create, clear completed', 'No arguments; opens task menu with create/list/clear actions', 'src/index.ts:1222'),
    ],
    hooks: ['turn_start', 'agent_settled', 'turn_end', 'tool_result', 'context', 'session_start', 'before_agent_start', 'tool_execution_start'],
    settingsSurface: 'Tasks store and global/project scope configuration are loaded by tasks-config.js; task files are stored in session/project/global task scopes.',
  },
  {
    packageName: 'pi-herdr-agents',
    version: '2.0.5',
    sourceRef: 'pi-extension/subagents/index.ts (package.json pi.extensions[0])',
    commands: [
      entry('subagents-init', 'Draft task-category model preferences from the live registry; optional arguments set ranking preferences', '[preferences]; unavailable in PI_SUBAGENT_ID child sessions', 'pi-extension/subagents/index.ts:4142', { registrationCondition: '!process.env.PI_SUBAGENT_ID' }),
      entry('btw', 'Open an ephemeral side-question session in a background Herdr tab', '[question text]; asks for/uses a side question', 'pi-extension/subagents/index.ts:4155'),
      entry('btw-close', 'Close the current BTW side-question session', 'No arguments; closes current side-question session', 'pi-extension/subagents/index.ts:4238'),
      entry('worktree', 'Parent session: fork into a worktree, list retained worktrees, or explicitly remove one; otherwise: fork this session into a worktree; use /worktree list to inspect them', '[create|list|remove …]; also opens a selection menu', 'pi-extension/subagents/index.ts:4256'),
      entry('iterate', 'Fork session into a subagent for focused work (bugfixes, iteration)', '[task]; forks focused work', 'pi-extension/subagents/index.ts:4405'),
      entry('subagent', 'Spawn a subagent: /subagent <agent> <task>; list agents: /subagent list', '<agent> <task> | list; lists or spawns', 'pi-extension/subagents/index.ts:4418'),
      entry('plan', 'Start a planning session: /plan <what to build>', '<what to build>; starts planning workflow', 'pi-extension/subagents/index.ts:4656'),
    ],
    hooks: ['session_start', 'session_shutdown', 'input', 'before_agent_start', 'agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end', 'before_provider_request', 'after_provider_response', 'message_update', 'tool_execution_start', 'tool_call', 'tool_execution_update', 'tool_result', 'tool_execution_end'],
    settingsSurface: 'Subagent settings and agent definitions are read from the package/agent configuration; workflow, model preference and worktree state are managed by the extension and Herdr integration.',
  },
  {
    packageName: 'pi-intercom',
    version: '0.16.0',
    sourceRef: 'index.ts (package.json pi.extensions[0])',
    commands: [
      entry('intercom', 'Open session intercom overlay', 'No arguments; opens the intercom overlay', 'index.ts:3207'),
      entry('intercom-id', 'Insert a stable pi-intercom handoff snippet for this session into the editor', 'No arguments; inserts the session handoff snippet into editor text', 'index.ts:3212'),
      entry('alias', 'Set the current session alias (usage: /alias <name> or /alias menu)', '<name> or menu; argument sets alias, empty/menu prompts', 'index.ts:3217'),
      entry('handover', 'Summarize this session and hand it over to another session (usage: /handover to pick a session, or /handover <target or project path> [next task])', 'to | <target or project path> [next task]; menu or direct target and optional next task', 'index.ts:3222'),
    ],
    hooks: ['session_start', 'session_shutdown', 'turn_end', 'agent_start', 'tool_execution_start', 'tool_execution_end', 'agent_end', 'turn_start', 'model_select', 'tool_result'],
    settingsSurface: 'Intercom configuration loaded from config.ts: enabled/transport, session identity, busy delivery, inbound trigger, confirmation and cross-machine/broker settings.',
  },
  {
    packageName: 'pi-markdown-preview',
    version: '0.19.2',
    sourceRef: 'index.ts (package.json pi.extensions[0])',
    commands: [
      entry('preview', 'Rendered markdown preview (--pick select response, --file <path> or bare path, --browser/-b for HTML, --watch/-w to auto-refresh responses or files, --list/--stop manage watchers, --pdf for PDF, --terminal to force inline, --font-size <px>)', '[--pick|--file <path>|--browser|-b|--watch|-w|--list|--stop|--pdf|--terminal|--font-size <px>] [path]', 'index.ts:5882'),
      entry('preview-browser', 'Open browser preview (--watch/-w starts or reopens response/file watchers; --list and --stop manage them)', '[--watch|-w|--list|--stop] [path or response selector]', 'index.ts:5887'),
      entry('preview-pdf', 'Export markdown to PDF via pandoc + LaTeX and open it', '[source/path and PDF options]', 'index.ts:5894'),
      entry('preview-clear-cache', 'Clear rendered preview cache (${CACHE_DIR})', 'No arguments; removes rendered preview cache', 'index.ts:5902'),
    ],
    hooks: ['agent_end', 'agent_settled', 'session_shutdown'],
    settingsSurface: 'Preview cache path and runtime preview/watch configuration are local to the extension; no Pi settings schema is registered in the entrypoint.',
  },
  {
    packageName: 'pi-memory',
    version: '0.4.2',
    sourceRef: 'index.ts (package.json pi.extensions[0])',
    commands: [],
    hooks: ['session_start', 'session_shutdown', 'input', 'before_agent_start', 'session_before_compact'],
    settingsSurface: 'Environment settings include PI_MEMORY_EXIT_SUMMARY and PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS; qmd configuration and the pi-memory collection are external CLI/configuration surfaces.',
  },
  {
    packageName: 'pi-multi-account',
    version: '1.24.0',
    sourceRef: 'index.ts (package.json pi.extensions[0])',
    commands: [
      entry('multi-account', 'Manage automatic multi-account failover & rotation', 'status | accounts [refresh] | best | priority […] | limits [refresh] | models | pick | pin <provider/model> | unpin <provider-or-family> | pins | save-default | log | only-active | rediscover | add/remove/revive | clear/stop/reset/reload/enable/disable; pickers are opened for selection subcommands', 'index.ts:9995', {
        aliases: ['provider-failover', 'failover'],
      }),
    ],
    hooks: ['context', 'message_end', 'agent_start', 'agent_settled', 'session_compact', 'before_provider_request', 'session_start', 'session_shutdown', 'session_before_compact', 'session_compact_failed', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'turn_start', 'message_start', 'message_update', 'tool_execution_update', 'tool_execution_start', 'tool_execution_end', 'input', 'before_agent_start', 'thinking_level_select', 'model_select', 'after_provider_response', 'agent_end'],
    settingsSurface: 'CONFIG_PATH configuration plus Pi auth.json/models.json/modelRegistry provider and OAuth surfaces; command add/remove/revive, failover policy, limits, pins and controls update or inspect that state.',
  },
  {
    packageName: 'pi-powerline-footer',
    version: '0.19.1',
    sourceRef: 'index.ts (package.json pi.extensions[0]); /cd helper in cd-command.ts',
    commands: [
      entry('reply', 'Quote a previous user or assistant message into the editor', '[message selector or range]', 'index.ts:2479', { collisionGroup: 'pi-native:reply', precedenceNote: 'This extension registers /reply, which is also a Pi-native name; keep the Pi-native owner ahead of this extension fallback on collision.' }),
      entry('queue', 'Manage Powerline queued prompts and project aliases', '[send|retry|clear|target|alias] [args]; empty opens queue picker', 'index.ts:2487', { collisionGroup: 'pi-native:queue', precedenceNote: 'This extension registers /queue, which is also a Pi-native name; keep the Pi-native owner ahead of this extension fallback on collision.' }),
      entry('powerline', 'Configure powerline status (toggle, preset)', '[toggle|preset|placement|…]; empty toggles, menu/options otherwise', 'index.ts:2582'),
      entry('stash-history', 'Open prompt history picker', 'No arguments; opens prompt-history picker', 'index.ts:2670'),
      entry('bash-mode', 'Toggle sticky bash mode (on, off, toggle)', '[on|off|toggle]; empty toggles', 'index.ts:2683', { collisionGroup: 'pi-native:bash-mode', precedenceNote: 'This extension registers /bash-mode, which is also a Pi-native name; keep the Pi-native owner ahead of this extension fallback on collision.' }),
      entry('powerline-perf', 'Show or reset opt-in editor performance profiling', '[reset]; otherwise reports counters', 'index.ts:2703'),
      entry('bash-reset', 'Reset the managed bash session', 'No arguments; disposes/resets the managed shell session', 'index.ts:2719'),
      entry('vibe', 'Set working message theme. Usage: /vibe [theme|off|mode|model|generate]', '[theme|off|mode|model|generate] [args]; empty reports current theme', 'index.ts:2743'),
      entry('cd', 'Switch the Pi session working directory', '<path>; argument completion is supplied by getArgumentCompletions', 'cd-command.ts:183', { collisionGroup: 'pi-native:cd', precedenceNote: 'This extension registers /cd and switches sessions through SessionManager; preserve the Pi-native owner ahead of this extension fallback on collision.' }),
    ],
    hooks: ['session_start', 'session_shutdown', 'tool_result', 'user_bash', 'model_select', 'thinking_level_select', 'session_tree', 'session_info_changed', 'before_agent_start', 'input', 'agent_start', 'message_update', 'message_start', 'message_end', 'turn_end', 'session_before_compact', 'session_compact', 'session_compact_failed', 'agent_settled', 'tool_call', 'agent_end'],
    settingsSurface: 'Global ~/.pi/agent/settings.json and project .pi/settings.json (powerline, powerlineShortcuts and bash-mode settings); compaction-policy.json; powerline stash-history state under the agent directory.',
  },
  {
    packageName: 'pi-web-access',
    version: '0.35.0',
    sourceRef: 'dist (package.json pi.extensions[0]; source registration in index.ts)',
    commands: [
      entry('websearch', 'Open web search curator', '[query or search request]; opens curator flow', 'index.ts:3274', { registrationCondition: 'isCommandEnabled(initConfig, "websearch")' }),
      entry('curator', 'Toggle or configure the search curator workflow', '[workflow/config]; empty toggles current workflow', 'index.ts:3537', { registrationCondition: 'isCommandEnabled(initConfig, "curator")' }),
      entry('google-account', 'Show the active Google account for Gemini Web', 'No arguments; reads browser account/cookie state', 'index.ts:3579', { registrationCondition: 'isCommandEnabled(initConfig, "google-account")' }),
      entry('search', 'Browse stored web search results', 'No arguments; opens stored-result selection', 'index.ts:3627', { registrationCondition: 'isCommandEnabled(initConfig, "search")' }),
    ],
    hooks: ['session_start', 'session_tree', 'session_shutdown', 'before_agent_start', 'agent_settled'],
    settingsSurface: 'Web access config controls command enablement, search providers/workflow, browser-cookie access, tool activation and curator settings; browser cookie/profile access is gated by allowBrowserCookies.',
  },
]

/** Flatten registered names (including same-handler aliases) without changing the snapshot. */
export function getInstalledExtensionCommandNames(
  inventory: readonly InstalledExtensionInventoryEntry[] = installedExtensionInventory,
): readonly { packageName: string; name: string; sourceRef: string; collisionGroup: string | null }[] {
  return inventory.flatMap((extension) => extension.commands.flatMap((command) => [
    { packageName: extension.packageName, name: command.name, sourceRef: command.sourceRef, collisionGroup: command.collisionGroup },
    ...command.aliases.map((name) => ({
      packageName: extension.packageName,
      name,
      sourceRef: command.sourceRef,
      collisionGroup: command.collisionGroup,
    })),
  ]))
}
