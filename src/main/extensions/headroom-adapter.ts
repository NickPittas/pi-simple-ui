/**
 * App-side description and routing metadata for @jmcombs/pi-headroom.
 * Read-only reports and simulation stay in the installed extension. Setup is
 * handed to an explicit, host-owned 1Password capability because its bordered
 * custom UI is not implemented by the RPC extension UI bridge.
 */

import type {
  InstalledExtensionCommandMenu,
  InstalledExtensionCommandSurface,
} from './ponytail-adapter.ts'

const setupMenus: readonly InstalledExtensionCommandMenu[] = Object.freeze([
  {
    id: 'headroom-existing-key',
    title: 'Headroom is already set up',
    conditional: true,
    items: [
      { value: 'replace', label: 'Replace it' },
      { value: 'keep', label: 'Keep the current key' },
    ],
  },
  {
    id: 'headroom-key-source',
    title: 'Set up your Headroom key',
    conditional: true,
    items: [
      { value: 'browse', label: 'Locate in 1Password', description: 'Browse your vaults and select item' },
      { value: 'paste', label: 'Type or paste the key', description: 'Manually insert your key' },
      { value: 'ref', label: 'Enter a 1Password reference', description: 'Advanced: an op://vault/item/field path' },
      { value: 'cancel', label: 'Cancel' },
    ],
  },
  {
    id: 'headroom-vault-picker',
    title: 'Choose a vault',
    conditional: true,
    items: [
      { value: 'dynamic-vaults', label: 'Live, alphabetically sorted vault choices' },
      { value: '__cancel', label: 'Cancel' },
    ],
  },
  {
    id: 'headroom-item-picker',
    title: 'Choose an item in the selected vault',
    conditional: true,
    items: [
      { value: 'dynamic-items', label: 'Live API Credential, Login, Secure Note, and Password items, sorted by title' },
      { value: '__cancel', label: 'Cancel' },
    ],
  },
  {
    id: 'headroom-field-picker',
    title: 'Which field holds the key?',
    conditional: true,
    items: [
      { value: 'dynamic-fields', label: 'Live item fields; skipped when there is exactly one credential field' },
      { value: '__cancel', label: 'Cancel' },
    ],
  },
  {
    id: 'headroom-manual-key',
    title: 'Enter your Headroom API key',
    conditional: true,
    items: [{ value: 'masked-input', label: 'Masked key entry (used when op is unavailable or selected manually)' }],
  },
  {
    id: 'headroom-op-reference',
    title: '1Password reference for Headroom',
    conditional: true,
    items: [{ value: 'op://Vault/Item/field', label: 'Plain-text op://vault/item/field reference input' }],
  },
])

/** Exact registered command names and descriptions from @jmcombs/pi-headroom/index.ts. */
export const headroomCommandSurface: InstalledExtensionCommandSurface = Object.freeze({
  packageName: '@jmcombs/pi-headroom',
  extensionPath: 'index.ts',
  commands: Object.freeze([
    Object.freeze({
      name: 'headroom-status',
      description: 'Report Headroom proxy health, version, mode, key settings, and session + proxy token savings.',
      args: Object.freeze([]),
    }),
    Object.freeze({
      name: 'headroom_setup',
      description: 'Set up or update your Headroom API key (never shown to the agent).',
      args: Object.freeze([]),
      menus: setupMenus,
    }),
    Object.freeze({
      name: 'headroom-stats',
      description: 'Show detailed Headroom statistics: session + lifetime savings, request counts, proxy tuning, and a per-strategy breakdown.',
      args: Object.freeze([]),
    }),
    Object.freeze({
      name: 'headroom-simulate',
      description: 'Dry-run Headroom compression on pasted text (no LLM call): projected token savings + transforms.',
      args: Object.freeze([{
        name: 'blob',
        description: 'Text to project through the compression pipeline; omit to receive the extension usage hint.',
        required: false,
        type: 'text' as const,
      }]),
    }),
  ]),
})

export const HEADROOM_SETUP_CAPABILITY_ID = '@jmcombs/pi-1password.onboardSecret' as const

/**
 * Description of the actual operation registered by Headroom. Its onboarding
 * API checks 1Password availability, may spawn `op` for vault browsing/verify,
 * and writes the credential to the Pi auth.json store. This adapter never does
 * those things itself; an app host must explicitly authorize and provide this
 * capability before the action can run.
 */
export const headroomSetupAction = Object.freeze({
  kind: 'host-action-required' as const,
  capabilityId: HEADROOM_SETUP_CAPABILITY_ID,
  extensionCommand: 'headroom_setup',
  entrypoint: 'onboardSecret',
  packageName: '@jmcombs/pi-1password',
  options: Object.freeze({ name: 'headroom' as const, label: 'Headroom' as const }),
  sideEffects: Object.freeze([
    'may invoke the op CLI to inspect availability, browse vault items, or verify a saved op:// reference',
    'writes the Headroom API-key entry to Pi auth.json',
  ]),
  bridgeGap: 'The onboarding package uses ctx.ui.custom bordered popups; the RPC bridge reports custom UI as unsupported.',
  requiresExplicitUserAction: true,
})

export interface ExplicitHeadroomSetupAuthorization {
  readonly type: 'explicit-user-action'
  readonly commandName: 'headroom_setup'
}

export interface HeadroomSetupResult {
  readonly ok: boolean
  /** Human-facing, secret-free result from the real onboarding implementation. */
  readonly message: string
}

/** The host implementation is responsible for the real 1Password flow. */
export interface HeadroomSetupCapability {
  readonly id: typeof HEADROOM_SETUP_CAPABILITY_ID
  onboardSecret(options: { readonly name: 'headroom'; readonly label: 'Headroom' }): Promise<HeadroomSetupResult>
}

export type HeadroomWorkflow =
  | { readonly kind: 'native-command'; readonly commandName: 'headroom-status' | 'headroom-stats' | 'headroom-simulate' }
  | typeof headroomSetupAction

/** Classify command routing only; status, stats, and simulation remain native. */
export function adaptHeadroomCommand(commandName: string): HeadroomWorkflow | undefined {
  if (commandName === 'headroom_setup') return headroomSetupAction
  if (commandName === 'headroom-status' || commandName === 'headroom-stats' || commandName === 'headroom-simulate') {
    return { kind: 'native-command', commandName }
  }
  return undefined
}

/**
 * Invoke the actual onboarding entry point only after an explicit user action.
 * Missing UI capability remains a typed gap rather than silently starting a
 * process or writing credentials.
 */
export async function executeHeadroomSetup(
  capability: HeadroomSetupCapability | undefined,
  authorization: ExplicitHeadroomSetupAuthorization | undefined,
): Promise<
  | { readonly kind: 'completed'; readonly result: HeadroomSetupResult }
  | { readonly kind: 'host-action-required'; readonly action: typeof headroomSetupAction }
> {
  if (!capability || capability.id !== HEADROOM_SETUP_CAPABILITY_ID
    || authorization?.type !== 'explicit-user-action'
    || authorization.commandName !== 'headroom_setup') {
    return { kind: 'host-action-required', action: headroomSetupAction }
  }

  return {
    kind: 'completed',
    result: await capability.onboardSecret(headroomSetupAction.options),
  }
}
