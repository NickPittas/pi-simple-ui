# Pi Desktop Companion — Product and Architecture Plan

## Product idea

Build a core, barebones graphical desktop UI for Pi coding-agent users. Preserve Pi's real input, session, command, model, and configuration behavior without replacing its semantics with a second agent implementation.

This is a fresh application, not a continuation of deleted source and not a fork of pi-gui. The product is an Electron desktop application with a React and TypeScript renderer and a Pi SDK 1.0.1 host running in Electron main. The host is the single owner of Pi runtimes and privileged resources; a small, validated, sandboxed preload bridge exposes only capabilities the renderer needs.

Pi remains authoritative for prompt execution, sessions, tools, extensions, providers, credentials, resource loading, native configuration, and command effects. The application adds graphical presentation and the interaction/observation seams in the approved core scope. It must not quietly replace these with a second orchestrator, credential store, extension runtime, or invented configuration model.

Keep the implementation understandable and maintainable. Where a selected public API lacks a necessary core seam, add only a small, version-pinned compatibility change; avoid private-field reach-ins, callback replacement, duplicate dependency instances, global package mutation, or broad upstream forks. Do not require a named third-party provider or extension as a standalone acceptance prerequisite.

## Runtime and trust boundaries

Electron main owns Pi runtime creation, native session and extension lifecycle, configuration/resource access, process launches, secrets, MCP, and the authoritative event stream. It translates trusted Pi events and validated UI requests into narrow IPC messages. The renderer never receives credentials or unrestricted Node access.

The preload surface is deliberately small, typed, and validated on both sides. Production navigation, CSP, origins, file access, popups, permissions, markdown, attachments, and browser-like content are constrained. Extension trust and workspace trust must remain visible and accurate; approving a workspace happens before project extensions, tools, MCP configuration, or other project resources are loaded.

Use Pi's native config and stores at their native scopes. User, trusted-project, session, and application presentation preferences are not interchangeable. Preserve native file content and scope; Pi retains inheritance and semantics. Do not create a third credential or MCP store. Separate GUI preference storage is optional, not a core acceptance prerequisite.

## Approved core product scope

The required product is the graphical Pi core: native Pi input and command dispatch; root conversation and session navigation/recovery; native model/thinking/toggle operations; reusable graphical select/input/confirm/editor dialogs; and a persistent Pi-and-extension configuration file editor. The editor works with existing native plain-text formats at their native paths/scopes, supports edits and additions, preserves content it does not edit, and saves changes back for Pi to interpret and load. Do not invent a parallel settings schema or claim Pi has loaded an edit before its native reload/use path does so.

Render standard extension UI requests through reusable graphical dialogs that return the actual choice or cancellation to the original continuation. Render custom extension submenus through one generic `custom()`-hook host: run the original native component in a terminal-style panel and preserve native input, callbacks, back/cancel, and nesting. Do not build per-extension menus, forms, field schemas, adapters, or management pages. Compatibility is not universal: extensions requiring direct stdin/stdout or an external terminal may not be hostable and must be identified honestly rather than silently approximated.

Keep full core session/conversation behavior. For any subagent session the host actually observes, make its complete actual conversation viewable; this is passive observation, not a second orchestrator or external launcher integration. Treat Herdr as external and show it only if encountered. Pi remains authoritative for command execution/effects, configuration meaning/loading, and other native operations.

Other existing application modules and integrations may remain in the repository, but their existence does not make them approved core deliverables. In particular, named per-extension integrations, MCP management/catalog/Apps surfaces, package/resource administration, provider-specific agent editors, usage/Code Mode dashboards, and data-sharing workflows are not prerequisites for this scope unless separately authorized. Native command routing and truthful result/feedback remain in scope.

## Extension and runtime integrations

### Graphical extension interactions

Present standard extension select, input, confirm, and editor requests using reusable dialogs, returning the chosen native value or cancellation to the original continuation. For custom menus, provide the generic native `custom()`-hook host described above; keep the original component, input, callbacks, nesting, and back/cancel semantics. Do not translate individual extensions into bespoke graphical surfaces or hardcode their fields. Direct stdin/stdout or external-terminal requirements are honest compatibility limits, not a reason to invent alternate semantics. Pi's native command dispatch remains available and its result/feedback is surfaced.

### Live child-worker conversations

Passively observe child-session creation/binding where available and subscribe to each child Pi session the host actually encounters. Show the actual conversation (including thinking, structured content, tool starts/updates/results/errors, and terminal state) rather than a status-only preview. Do not intercept an external launcher's subprocess behavior or create a second orchestrator. Preserve native parent/child identity when presenting observed sessions.

The shared worker view opens an observed subagent's complete actual conversation—not a status-only preview. This is passive viewability, not a worker-control or orchestration surface. Herdr is not controlled; an observed Herdr child is shown as a conversation only.

Use actual session events for conversations the host observes; do not infer a live stream from a top-level hook or RPC response. A flushed turn-end output transcript is recovery data, not realtime observation. Where history restoration is available, use native JSONL and minimal correlation data without duplicating model messages or feeding observational records back into context.

### External Herdr boundary

Herdr is an external TUI and remains responsible for its own panes, subprocess launcher, trust broker, and FIFO transport. The app must not reimplement or control those surfaces or mechanisms. Pi remains authoritative for input and native command dispatch. The app may passively observe any subagent session it actually encounters and, if that session is Herdr-launched, display its complete observed conversation in the shared worker view; do not assume or require a Herdr launch, reporter, pane, or transport integration. Preserve the external owner's process lifetime and detached-child policy.

### Native configuration files

Read and edit the existing Pi and extension plain-text configuration files (formats such as YAML, TOML, JSON, or conf as actually present). Allow existing values to be changed and new native entries to be added, preserve unedited and unknown content, and save to the existing native location/scope. Pi remains the only authority for parsing semantics, validation, execution, reload, and resource loading. Do not add per-extension configuration forms or separate MCP connection/catalog/Apps management as prerequisites; configuration file edits are the approved management surface.

## Product journeys and consistent operation

A workspace opens into a real Pi conversation, with cwd and trust visible before project-owned resources are activated. Session/workspace switches must not let stale events or dialogs mutate the newly active session.

During a turn, live Pi output and tool activity remain connected to the owning root session. If the host observes a subagent session, selecting it opens the actual complete conversation, not a status-only preview. Do not create a second orchestrator or control an external launcher.

An extension interaction starts with the extension's actual request and continuation. A standard dialog or generic native custom-menu panel returns actual input or cancellation; there are no per-extension replacement forms. Configuration edits are saved to native files and only take effect according to Pi's native loading/reload behavior.

Session navigation keeps a visible distinction between sessions and branches. Creating, resuming, forking, or recovering a session changes the active native session, while its descendants, active leaf, compaction points, and observed worker conversations remain attributable.

### Native effect conventions

Dialogs and forms are interaction surfaces, not alternate command implementations. A native command remains the source of effect; the UI only supplies its real arguments or choices and presents its result. Cancellation is a normal outcome and must not partially apply an edit or accidentally fall through to model execution.

The native file editor identifies the file and native scope being edited, preserves unrelated/unknown content, and never writes one scope in place of another. Pi remains responsible for effective values, validation, inheritance, and reload timing.

Native operations expose truthful outcomes and feedback. Observed worker conversations and loading/error states are not confused with empty results. Where a native capability does not exist, identify the limitation rather than simulating success.

### Completeness boundary

Native Pi commands remain discoverable and are dispatched to Pi with native arguments and effects. Native menus/dialog requests receive suitable reusable graphical presentation; command feedback is returned truthfully. Do not create an obligation to implement every extension-specific integration.

The configuration editor preserves text/content outside the user's edit and writes to the native file. Pi retains all format parsing, provider/extension semantics, trust rules, reload behavior, and conflict/validation authority.

Presentation conveniences cannot become an alternate source of truth. Native session history remains Pi's, and native configuration files remain authoritative. Herdr owns its state and transport; the app only presents complete conversations from subagent sessions it actually observes.

## Everyday agent experience

The root chat is a real Pi session: display native conversation/tool activity and forward input, stop, steer, follow-up, toggles, and other operations only through supported Pi paths. Preserve native command precedence and reject unknown slash commands rather than accidentally sending them as prompts. Pi remains authoritative for Herdr-related input and commands; the app is not a Herdr controller.

Keep core workspace and session behavior: safe workspace switching, native new/resume/name/tree/fork/clone/recovery operations, branches/active leaf, and restored root histories. Serialize session changes and callbacks so stale events cannot affect the new session. Restore/view observed child conversations as available.

Expose core native model selection, thinking, and relevant toggles through Pi. Do not invent persisted state or replace Pi's availability, clamping, or routing semantics.

## Native commands, settings, and extension ecosystem

Forward native Pi commands to Pi rather than reimplementing command effects. Native argument/menu interactions preserve their real values, cancellation, and outcomes through reusable dialogs/custom-menu host. Do not add named per-extension command integrations as acceptance prerequisites. Unknown commands are not prompts. App help, if present, remains separate from Pi's own commands.

The configuration editor reads, displays, edits, adds, and saves the existing Pi and extension configuration files at their native scopes. Preserve unrelated/unknown text and avoid rewriting formats or meanings the editor does not own. Pi remains responsible for validation, effective settings, and reload/application timing; never write a different native scope by accident.

Native account, provider, and other operations remain available through Pi command dispatch; this app does not supply separate account routers or per-extension/provider management surfaces in the approved core scope.

Do not add provider-specific subagent definition editors or require a particular third-party provider. The native config file editor may expose relevant files as text; Pi and the owning extension retain their own semantics. Regardless of provider name, show full conversations for any subagent sessions the host actually observes.

## Explicitly non-required extras

Separate MCP server connection/catalog/exposure management and MCP Apps, provider-specific definition/account managers, named extension integrations or extension-specific graphical surfaces, Code Mode/tool catalog and usage dashboards, package/resource lifecycle managers, and data-sharing/consent workflows are not prerequisites for the approved core deliverable. Existing code for these areas may remain; do not describe it as removed. Native commands still route to Pi and native results/feedback remain visible. Do not claim universal custom extension compatibility where an extension requires direct stdin/stdout or an external terminal.

## Ownership, persistence, and recovery

The host stamps event ownership at the point it receives events from a root or child runtime. Renderer tabs are views over that ownership, not independent runtimes; switching a tab cannot redirect an in-flight action to a different session.

Native histories and configuration are restored by their existing Pi loaders. GUI-specific state is limited to presentation details and the minimum correlation data that native records do not contain. Recovery never silently converts an incomplete trace into a complete conversation.

Errors remain attached to the native operation that failed: workspace/session load, extension continuation, configuration save, or observed worker conversation. The user can retry or cancel only where Pi/native continuation provides a real path, and results are refreshed from their owner.

## Quality bar and delivery

Build for keyboard navigation, focus management, labels/screen readers, responsive panes/tabs, large histories and virtualization, loading/empty/error/recovery states, and reduced motion. The UI should make real state and irreversible actions clear; it must not disguise absent capability as successful work.

Installable delivery and any packaging review are a separate follow-up, not prerequisites for the approved core product behavior. If delivery work is separately authorized, record platform and signing limits accurately.

Completion for this approved scope means Pi input and native commands work through the graphical UI; native sessions/conversations are usable; model/thinking/toggle operations reach Pi; native configuration files can be read, edited, extended, preserved, and saved; standard dialogs return real values/cancellation; the generic custom-menu host works with native callbacks/back/cancel/nesting; and complete conversations are viewable for subagent sessions actually observed. Do not mark the generic custom-menu host complete based on typechecks, file presence, or adjacent bridge code. The checklist records implementation scope, not feature confirmation.
