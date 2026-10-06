# Implementation checklist

The application is under implementation. Paths below describe intended task scope; they do not by themselves establish completion. Report necessary path changes without dropping functionality. Tasks list implementation steps, cautions, and completion criteria.

**Implementation policy:** No tests, test suites, browser smoke checks, or packaging reviews are current deliverables. Preserve the user rule exactly: implement → review → fix → confirm actual working feature → only then user-authorized regression tests. Typechecks and file presence are not confirmation. Connect backend capabilities to the frontend before lower-priority packaging work.

## Foundation and native host

- [x] **T01 — Scaffold the fresh Electron/React/TypeScript app**  
  **Owner:** backend (fixer) · **Wait for:** none  
  **Files:** `package.json`, `electron-builder.yml`, `tsconfig.json`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`  
  **How:** Create the minimal runnable desktop application; make Electron main the future Pi host and React the renderer; configure development and production entry points.  
  **Beware:** This is a fresh scaffold, not a restore, archive, backup, or continuation of deleted source. Keep the eventual release target macOS-first.  
  **Done:** A clean install and launch opens the React shell in a sandboxed Electron window; package scripts build the same entry points.

- [ ] **T02 — Establish required Pi source provenance and seams**  
  **Owner:** backend (fixer) · **Wait for:** T01  
  **Files:** `vendor/pi/packages/coding-agent/**`, `package.json`, `pnpm-lock.yaml`  
  **How:** Verify the Pi SDK source/version/license and app dependency resolution. Add a narrow Pi compatibility seam only if a core host capability is actually missing; record provenance and patch ownership. Third-party extension forks/providers are not standalone deliverables.  
  **Beware:** Do not mutate global installs, duplicate the Pi runtime, or add unrelated source forks. Keep any necessary compatibility changes additive and narrow.  
  **Done:** Pi SDK provenance is recorded and the app resolves one native Pi runtime; any additional host seam is justified by the core feature that needs it.

- [x] **T03 — Bootstrap the single native Pi runtime**  
  **Owner:** backend (fixer) · **Wait for:** T02  
  **Files:** `src/main/pi/bootstrap.ts`, `src/main/pi/session-host.ts`, `src/main/index.ts`, `vendor/pi/packages/coding-agent/src/**`  
  **How:** Start Pi SDK 1.0.1 in Electron main; own the native Pi runtime, root sessions, extension lifecycle, and resource loading there.  
  **Beware:** Verify installed public declarations/source before naming APIs. Do not activate project-owned executable packages, MCP servers or resources before T05 trust approval; do not auto-apply global MCP defaults or touch live user config during implementation. No backend-process migration, second orchestrator, private-field reach-in, or callback monkeypatch.  
  **Done:** The Electron main host starts one Pi runtime, loads its native extension/resource environment after trust approval, and completes a real turn through Pi's native session lifecycle.

- [x] **T04 — Secure the Electron capability bridge**  
  **Owner:** backend (fixer) · **Wait for:** T01  
  **Files:** `src/preload/index.ts`, `src/shared/ipc-contracts.ts`, `src/main/ipc/register.ts`, `src/main/security/window-policy.ts`  
  **How:** Expose narrow typed IPC operations and event subscriptions; validate sender, payload, active-session/child ownership, and event generation on both sides; enforce production origin, navigation, popup, permission, CSP, and canonical file-path rules.  
  **Beware:** Keep context isolation and sandbox enabled; renderer must never receive Node access, credentials, unrestricted file reads, or arbitrary IPC. Account for safe development React refresh without weakening production policy.  
  **Done:** Malformed or unauthorized IPC requests are rejected, while the production window enforces restricted navigation, permissions, and file access through the actual bridge.

- [x] **T05 — Implement workspace trust and scoped runtime selection**  
  **Owner:** backend (fixer) · **Wait for:** T03  
  **Files:** `src/main/workspaces/workspace-service.ts`, `src/main/pi/session-host.ts`, `src/main/ipc/workspaces.ts`, `src/shared/ipc-contracts.ts`  
  **How:** Track cwd, recent/missing/moved workspaces, and native trust approval/revocation; gate project extensions, tools, MCP and resources until approval; serialize switch/start/cancel operations and invalidate stale watchers/dialogs/events.  
  **Beware:** Carry the selected trust and resource boundary into children, workflows, tool caches, and project settings; never infer approval from an old path after it moves.  
  **Done:** An untrusted project loads no project resources; approval enables the native load path; revocation blocks later loads; and stale switch events cannot affect the active workspace.

- [ ] **T06 — Own root-session lifecycle and recovery**  
  **Owner:** backend (fixer) · **Wait for:** T03, T05, T52  
  **Files:** `src/main/pi/session-host.ts`, `src/main/pi/session-events.ts`, `src/main/sessions/session-store.ts`, `src/main/sessions/session-index.ts`, `src/shared/ipc-contracts.ts`  
  **How:** Serialize new/switch/fork/reload mutations with extension callbacks; publish actual Pi turn, content, tool, retry, compaction, summary, error, and terminal events; recover valid JSONL sessions and report corrupted-file recovery.  
  **Beware:** Treat native session files as authoritative and ignore stale events after a session change; never manufacture a second message history.  
  **Done:** The host publishes correctly ordered native session events, serializes replacement/cancellation/reload, and recovers valid sessions while reporting corrupted-session recovery.

## Chat, native commands, and reusable extension host

- [ ] **T07 — Build the root conversation and command-entry surface**  
  **Owner:** UI (designer) · **Wait for:** T04, T06, T08, T13, T14, T52, T53  
  **Files:** `src/renderer/chat/Conversation.tsx`, `src/renderer/chat/Message.tsx`, `src/renderer/chat/Composer.tsx`, `src/renderer/commands/CommandPalette.tsx`, `src/renderer/security/SafeMarkdown.tsx`, `src/renderer/chat/chat.css`  
  **How:** Render the live native conversation and tool/results/errors; provide text input, command entry, and native-supported stop/steer/follow-up/toggles. Route native command arguments and no-argument menus through Pi and reusable dialogs/custom-menu host.  
  **Beware:** Do not show fictional queue/control behavior, flatten tool errors, or send unknown commands as model prompts.  
  **Done:** The conversation surface displays native conversation/tool activity, supported controls invoke their matching Pi actions, and cancellation leaves no stale composer state.

- [ ] **T08 — Discover and dispatch native commands faithfully**  
  **Owner:** backend (fixer) · **Wait for:** T03, T12, T13  
  **Files:** `src/main/commands/command-catalog.ts`, `src/main/commands/dispatch.ts`, `src/main/ipc/commands.ts`, `src/shared/commands.ts`  
  **How:** Build the command catalog from native Pi dispatch; preserve native precedence, aliases, arguments, menus, cancellation, and effects. Reject unknown slash commands explicitly.  
  **Beware:** Inspect source dispatch rather than deriving effects from command names; app help is separate, and `/orchestrator` is not an installed command.  
  **Done:** The catalog reflects the installed runtime; argument and no-argument commands preserve native effects and cancellation, precedence and autocomplete match Pi, and unknown commands are rejected without invoking the model.

- [ ] **T09 — Adapt core Pi commands and session effects**  
  **Owner:** backend (fixer) · **Wait for:** T08  
  **Files:** `src/main/commands/native-core-adapter.ts`, `src/main/sessions/session-service.ts`  
  **How:** Forward core Pi settings/model/thinking/session and other native commands to their original Pi handlers, preserving actual argument/menu/cancel behavior and presenting returned feedback.  
  **Beware:** Preserve native command semantics and native session tree/active leaf; use the reusable dialogs and generic custom-menu host rather than invented command forms.  
  **Done:** Native operations reach their original handler and their real outcome/cancellation is visible in the UI.

- **T10 — Legacy named extension workflows (OUT OF SCOPE)**  
  **Scope:** The named per-extension workflows and Headroom/1Password onboarding are not prerequisites for the approved core deliverable. Retain existing code/evidence if present; do not claim it was removed. Native command routing and feedback remain covered by T08/T11.

- [ ] **T11 — Preserve native extension command discovery and feedback**  
  **Owner:** backend (fixer) · **Wait for:** T08  
  **Files:** `src/main/extensions/command-adapters.ts`, `src/main/extensions/installed-inventory.ts`  
  **How:** Keep installed native commands discoverable and route them to Pi's original dispatch with native arguments and effects. Present standard interactions through reusable dialogs and custom menus through T13/T14; return native outcomes/feedback.  
  **Beware:** Do not create a separate adapter/UI for each extension. Native commands must not be dropped or accidentally sent to the model; custom terminal requirements may be honestly unsupported.  
  **Done:** Native command dispatch, cancellation, and result/feedback remain connected without per-extension management surfaces or hardcoded menu fields.

- [x] **T12 — Bridge Pi ExtensionUIContext interactions**  
  **Owner:** backend (fixer) · **Wait for:** T03  
  **Files:** `vendor/pi/packages/coding-agent/src/**`, `src/main/extensions/extension-ui-bridge.ts`, `src/main/ipc/extension-ui.ts`, `src/shared/extension-ui.ts`  
  **How:** Present original extension select/confirm/input/editor interactions through reusable graphical dialogs; return actual values/cancellation to the original continuation and preserve multistep behavior.  
  **Beware:** Do not claim a missing public API already exists, call private `.handler` directly, replace global callbacks, or force custom terminal rendering into dialog forms.  
  **Done:** Standard interactions return their actual selected values/cancellation to native continuations; do not mark complete from bridge presence alone.

- [ ] **T13 — Implement generic native custom-menu host hook**  
  **Owner:** backend (fixer) · **Wait for:** T12  
  **Files:** `vendor/pi/packages/coding-agent/src/**`, `src/main/extensions/custom-view-host.ts`  
  **How:** Add the minimum host hook needed to run the original native `custom()` component in a generic terminal-style panel. Preserve native input and callbacks, back/cancel, and nested menu behavior; keep standard select/input/confirm/editor interactions on T12.  
  **Beware:** Do not translate extensions into semantic schemas, custom field lists, or bespoke adapters; do not use direct private-handler invocation or replace Pi's command dispatch. Be honest about direct stdin/stdout/external-terminal limitations.  
  **Done:** Actual native custom components execute through one generic host path with their callbacks and navigation/cancellation intact; until actual behavior is confirmed this remains pending.

- [ ] **T14 — Render the generic native custom-menu panel**  
  **Owner:** UI (designer) · **Wait for:** T13, T53  
  **Files:** `src/renderer/extensions/CustomMenuPanel.tsx`, `src/renderer/extensions/ExtensionUiHost.tsx`  
  **How:** Render the original native component output/input in a reusable terminal-style panel; connect its callbacks and preserve nesting, back, and cancel. Do not create extension-specific settings or management pages.  
  **Beware:** Do not claim universal extension compatibility; a direct stdin/stdout or external terminal dependency may be unsupported and must be surfaced honestly. Do not implement Herdr panes or controls.  
  **Done:** Custom components supported by the generic hook remain the native component, not a hardcoded recreation, and their interaction reaches the original callbacks.

## Live workers and observed subagents

- [ ] **T15 — Observe every child Pi session encountered by the host**  
  **Owner:** backend (fixer) · **Wait for:** T03, T52  
  **Files:** `src/main/workers/child-session-observer.ts`, `src/main/pi/session-events.ts`  
  **How:** Observe and subscribe to each child Pi session the host actually encounters; forward its actual conversation content, thinking, tool lifecycle/results/errors, and terminal state to the shared view. Passively observe sessions only when encountered; do not intercept external launchers.  
  **Beware:** A turn-end transcript is recovery data, not a live conversation. Do not build a second orchestrator or alter Pi messages/context. Herdr remains external and is shown only if its child session is actually observed.  
  **Done:** Every encountered session for which the host has actual events is viewable as its complete real conversation, not a status-only summary.

- **T16 — Provider-specific worker controls (OUT OF SCOPE)**  
  **Scope:** Dedicated provider RPC, spawn/stop/consume, and worker-control surfaces are not part of the approved core viewability deliverable. Preserve Pi-native command routing; observed external sessions remain view-only.

- [ ] **T17 — Persist and restore worker conversation identity**  
  **Owner:** backend (fixer) · **Wait for:** T15  
  **Files:** `src/main/workers/worker-registry.ts`, `src/main/workers/worker-history.ts`, `src/main/workers/trace-links.ts`, `src/main/ipc/workers.ts`  
  **How:** Correlate native child identity to its actual conversation/history where available; restore native histories after restart and persist only minimal missing-trace relationships if needed.  
  **Beware:** Do not duplicate model messages or count observational sidecar data as context; detached workers follow their native lifetime.  
  **Done:** Restart restores root and observed-worker conversations and links once; missing/corrupt trace metadata is recoverable without rewriting native messages.

- [ ] **T18 — Build observed-subagent conversation view**  
  **Owner:** UI (designer) · **Wait for:** T15, T17, T55  
  **Files:** `src/renderer/workers/WorkersPane.tsx`, `src/renderer/workers/WorkerConversation.tsx`, `src/renderer/workers/workers.css`  
  **How:** Provide a view for selectable root and observed-child conversations. Show actual text, thinking, structured content, tool lifecycle/results/errors, and terminal states for every observed subagent; Herdr appears only if actually encountered.  
  **Beware:** A status-only preview or artifact-tail transcript is not a conversation. Handle out-of-order events and large histories without losing actual content.  
  **Done:** Selecting an observed child renders its complete actual live/restored conversation; it is viewability, not a new orchestration/control surface.

- **T19 — Provider-owned worker controls (OUT OF SCOPE)**  
  **Scope:** A separate worker-control UI is not a prerequisite. Keep the observed-subagent conversation view in T18; do not imply that viewability gives control over external sessions.

## Optional management modules and core model controls

- **T24 — MCP observability/catalog management (OUT OF SCOPE)**  
  **Scope:** MCP connection/catalog observability is not a core prerequisite. Native config files may be edited by T30/T60; Pi retains connection ownership and command routing. Existing MCP code is not claimed removed.

- **T25 — MCP connection/credential manager (OUT OF SCOPE)**  
  **Scope:** Dedicated MCP server CRUD, connection lifecycle, OAuth/credential prompts, and masked secret-entry flows are not approved deliverables. Text-file editing remains governed by T30/T60 and native Pi loading semantics.

- **T26 — MCP management and discovery views (OUT OF SCOPE)**  
  **Scope:** Separate MCP management/catalog UI is not part of the approved core; native Pi command execution and its feedback remain required.

- **T27 — MCP exposure and Apps viewer (OUT OF SCOPE)**  
  **Scope:** MCP tool-exposure controls and MCP Apps viewer are not approved core deliverables. Existing implementation artifacts may remain; do not describe them as removed.

- [ ] **T28 — Implement native model selection and thinking behavior**  
  **Owner:** backend (fixer) · **Wait for:** T06  
  **Files:** `src/main/models/model-service.ts`, `src/main/models/model-settings.ts`, `src/main/ipc/models.ts`  
  **How:** Present the native model selection and thinking options supported by Pi; forward changes through Pi's actual operation and reflect its result.  
  **Beware:** Do not invent settings, provider authentication/routing, or model semantics. Preserve Pi's limits and availability behavior.  
  **Done:** Model/thinking selections reach Pi and displayed state reflects the native result.

- **T29 — Provider/account management UI (OUT OF SCOPE)**  
  **Scope:** A separate provider/account manager, OAuth journey, or masked secret-prompt UI is not part of the approved core. Native commands remain routed to Pi; configuration file editing is covered by T30/T60.

- [ ] **T30 — Read and edit native Pi/extension configuration files**  
  **Owner:** backend (fixer) · **Wait for:** T05, T28  
  **Files:** `src/main/config/settings-service.ts`, `src/main/config/atomic-write.ts`, `src/main/ipc/settings.ts`  
  **How:** Read, display, edit, add, and save existing Pi and extension configuration in their native plain-text files/formats and paths/scopes. Preserve content outside the edit and write back to the actual native file; Pi remains responsible for interpretation, validation, and reload/use timing.  
  **Beware:** Do not generate per-extension field schemas or management forms. Do not change the native scope/path accidentally, discard unknown content, or claim an edit is active until Pi's loader applies it.  
  **Done:** The editor round-trips a real native file edit and addition while preserving untouched content; Pi remains the authority for semantics and loading.

- **T31 — Package/resource lifecycle management (OUT OF SCOPE)**  
  **Scope:** Package installation and resource lifecycle management are not approved core deliverables. Existing native config/resource files remain accessible through the generic editor where in scope; Pi owns resource loading and trust behavior.

- **T32 — Skills/template management UI (OUT OF SCOPE)**  
  **Scope:** A skills/templates-specific management UI is not required. Plain-text native files can be edited through the generic configuration editor without app-owned field semantics.

## Optional provider-specific modules (out of scope)

- **T33 — Provider-specific subagent definition editor (OUT OF SCOPE)**  
  **Scope:** No Tintinweb-specific definition editor or field-level agent management is required. Relevant native files can use the generic text editor; the extension remains authoritative for meanings.

- **T35 — Nicobailon-specific definitions (OUT OF SCOPE)**  
  **Scope:** Nicobailon is not a standalone integration or acceptance prerequisite. No install, provider adapter, or definition editor is required by the approved core.

- **T36 — Provider-specific agent editor registry (OUT OF SCOPE)**  
  **Scope:** Provider-specific agent editor registries and individual provider adapters are not approved. Keep native Pi dispatch and generic configuration file editing instead.

- **T37 — Code Mode execution/trace integration (OUT OF SCOPE)**  
  **Scope:** A separate Code Mode runner/trace surface is not part of the approved core. Any native command remains available through Pi dispatch.

- **T38 — Usage/cost reporting (OUT OF SCOPE)**  
  **Scope:** A separate usage and cost ledger is not an approved core deliverable.

## Sessions, accessibility, and security

- [ ] **T39 — Build complete session tree and search navigation**  
  **Owner:** UI (designer) · **Wait for:** T06  
  **Files:** `src/renderer/sessions/SessionBrowser.tsx`, `src/renderer/sessions/SessionTree.tsx`, `src/renderer/sessions/SessionSearch.tsx`  
  **How:** Browse/search/new/resume/rename/import, all branch nodes and active leaf, compaction navigation, summarize/fork/clone and recovered root/worker histories.  
  **Beware:** A flattened recent-session list is insufficient; preserve branch identity and handle moved, missing, large, or corrupted files.  
  **Done:** Search and tree navigation expose native operations across branches, compaction, missing files, and corrupted recovery, restoring the correct active leaf.

- **T40 — Session transfer/privacy flows (OUT OF SCOPE)**  
  **Scope:** Separate export/share, consent, and privacy workflow surfaces are not approved core prerequisites. Core native session navigation/recovery remains in T39.

- **T41 — Help/transfer/native-info pages (OUT OF SCOPE)**  
  **Scope:** Separate help, transfer, privacy, and native-info pages are not approved core surfaces. Native commands and feedback still flow through Pi.

- [ ] **T42 — Deliver keyboard and assistive-technology parity**  
  **Owner:** UI (designer) · **Wait for:** T07, T18, T39, T53, T54, T55, T60  
  **Files:** `src/renderer/styles/accessibility.css`, `src/renderer/components/FocusManager.tsx`, `src/renderer/components/PaneLayout.tsx`, `src/renderer/components/Tabs.tsx`  
  **How:** Add keyboard navigation, focus restoration, labels/screen-reader semantics, responsive panes/tabs, loading/empty/error/recovery states, large-history virtualization, and reduced-motion support across primary surfaces.  
  **Beware:** Keep worker/chat focus stable during event updates; do not make essential actions mouse-only or hide errors in visual-only styling.  
  **Done:** Every principal page/editor supports keyboard and assistive-technology operation, focus survives live worker updates, and large histories remain navigable.

- [ ] **T43 — Harden privileged native config-file operations**  
  **Owner:** backend (fixer) · **Wait for:** T04  
  **Files:** `src/main/security/content-policy.ts`, `src/main/security/files.ts`  
  **How:** Keep native configuration reads/writes in main behind explicit bounded operations; validate canonical native file paths and prevent path traversal/unauthorized writes.  
  **Beware:** Do not broaden renderer file access or claim MCP Apps support.  
  **Done:** Configuration access is constrained to approved native paths/scopes and cannot read/write outside them.

- [ ] **T44 — Redact diagnostic logging and keep trust truthful**  
  **Owner:** backend (fixer) · **Wait for:** T04, T05  
  **Files:** `src/main/logging/redaction.ts`, `src/main/logging/diagnostics.ts`, `src/main/security/trust.ts`  
  **How:** Redact credentials and sensitive headers from logs/diagnostics; record truthful trust state and safe startup/auth failures; bound retained diagnostics by app privacy preferences.  
  **Beware:** Never claim a project or extension is trusted from stale state or redact so aggressively that actionable error class disappears.  
  **Done:** Failure diagnostics contain no secrets while preserving error categories; trust revocation appears immediately in subsequent diagnostics.

## Deferred installable delivery

- [ ] **T49 — Prepare installable macOS delivery**  
  **Owner:** backend (fixer) · **Wait for:** backend-to-frontend integration and T01, T03  
  **Files:** `electron-builder.yml`, `package.json`, `scripts/package-macos.ts`  
  **How:** After feature integration, wire the production macOS package to the actual app entrypoints, Pi SDK, WASM/jiti/native helpers, extension assets, userdata migration/rollback, and manual update behavior; signing/notarization depends on the release environment.  
  **Beware:** Deferred behind backend-to-frontend connection; this is not a current packaging review request. Do not bundle credentials or assume other-OS support.  
  **Done:** When resumed, the installable macOS app launches the connected native host with required assets, and its promised upgrade/rollback lifecycle preserves user data.

## Native input and UI host integration

- **T51 — Nicobailon runtime integration (OUT OF SCOPE)**  
  **Scope:** Nicobailon installation, adapter, and provider-specific worker support are not standalone prerequisites. The approved worker requirement is complete conversation viewability for any session the host actually observes, regardless of provider name.

- [ ] **T52 — Enforce runtime input, cancellation, serialization, and launch trust**  
  **Owner:** backend (fixer) · **Wait for:** T03, T04, T05  
  **Files:** `src/main/pi/runtime-operations.ts`, `src/main/pi/input-service.ts`, `src/main/security/launch-policy.ts`, `src/main/ipc/chat.ts`, `src/shared/ipc-contracts.ts`  
  **How:** Implement native send/stop/steer/follow-up and supported Pi input operations; cancel at a generation/preflight boundary before async work can reach a provider; serialize new/switch/options and clean old dialogs/watchers; propagate workspace trust across Pi-owned runtime/resource operations.  
  **Beware:** Do not replace Pi input/queue semantics or invent per-item controls if not public; unknown slash commands remain rejected. Do not take over an external Herdr subprocess launcher or trust broker.  
  **Done:** Cancellation at preflight prevents stale input from reaching the provider; untrusted Pi-owned paths load no project resources; trusted root/child input streams correctly and supported controls preserve Pi semantics.

- [ ] **T53 — Render standard graphical extension interactions**  
  **Owner:** UI (designer) · **Wait for:** T04, T12, T55  
  **Files:** `src/renderer/extensions/ExtensionUiHost.tsx`, `src/renderer/extensions/SelectDialog.tsx`, `src/renderer/extensions/InputDialog.tsx`, `src/renderer/extensions/ConfirmDialog.tsx`, `src/renderer/extensions/EditorDialog.tsx`, `src/renderer/extensions/extension-ui.css`  
  **How:** Render original select/confirm/input/editor requests as reusable graphical dialogs; return native values or cancellation to the extension continuation and clear stale requests on session switch. Custom submenus are handled by generic T13/T14.  
  **Beware:** Do not implement extension-specific forms or masked secret prompts as separate flows; preserve actual continuation behavior.  
  **Done:** Each supported standard dialog returns its actual value/cancellation; custom menu behavior is confirmed separately through the generic host.

- [ ] **T54 — Build native model, thinking, and toggle controls**  
  **Owner:** UI (designer) · **Wait for:** T28, T55  
  **Files:** `src/renderer/models/ModelPicker.tsx`, `src/renderer/models/ThinkingControls.tsx`, `src/renderer/models/models.css`  
  **How:** Present core model selection and thinking/toggle operations through Pi-native capabilities and display the native result.  
  **Beware:** Do not invent persisted state, provider routing, or model semantics; preserve Pi's limits and availability behavior.  
  **Done:** User selections/toggles reach Pi and displayed state reflects the native result.

- [ ] **T55 — Build application shell and workspace navigation**  
  **Owner:** UI (designer) · **Wait for:** T04, T05  
  **Files:** `src/renderer/App.tsx`, `src/renderer/layout/AppShell.tsx`, `src/renderer/layout/WorkspacePicker.tsx`, `src/renderer/layout/Navigation.tsx`, `src/renderer/styles/app.css`  
  **How:** Provide root/observed-worker views; expose workspace cwd/recent/missing/moved and actual trust grant/revoke before load.  
  **Beware:** Do not wait for every page before providing navigation; loading slots are fine but no final feature placeholder is complete. Keep project trust visible and gate project resources before activation.  
  **Done:** Workspace selection/trust operations reflect host state and root/observed-worker views target the correct session.

- [x] **T56 — App preference store (EXISTING EXTRA; OUT OF SCOPE)**  
  **Scope:** This existing app-specific preference module may remain, but separate app-preference storage/UI is not required for the approved core deliverable and is not a mirror of Pi/extension config.

- **T57 — Code Mode/tool-trace view (OUT OF SCOPE)**  
  **Scope:** A separate Code Mode/tool trace UI is not part of the approved core. Native tool command behavior remains Pi-owned.

- **T58 — MCP exposure/activity/Apps views (OUT OF SCOPE)**  
  **Scope:** MCP exposure, activity, and Apps views are not required; see T24–T27.

- **T59 — Usage/cost/context dashboard (OUT OF SCOPE)**  
  **Scope:** A separate usage/cost/context dashboard is not an approved core deliverable.

- [ ] **T60 — Build the generic native configuration file editor**  
  **Owner:** UI (designer) · **Wait for:** T30, T55  
  **Files:** `src/renderer/settings/SettingsPage.tsx`, `src/renderer/settings/ResourceEditor.tsx`, `src/renderer/settings/settings.css`  
  **How:** Present the existing Pi and extension plain-text configuration files in their native formats/paths. Allow text edits and additions, preserve untouched/unknown content, and save back to the native file. Reusable editor dialogs may support focused editing, but do not generate per-extension schemas/forms.  
  **Beware:** Pi owns parsing, semantic validation, effective values, trust, and reload/use timing. Preserve path/scope and do not show an edit as active before Pi applies it.  
  **Done:** User can edit/add native config and save while retaining untouched data; Pi remains authoritative for meaning and loading.

- **T61 — Provider/account/authentication UI (OUT OF SCOPE)**  
  **Scope:** A separate provider/account/authentication management UI is not approved. Native commands remain forwarded to Pi, and existing provider/config files remain accessible through T30/T60.
