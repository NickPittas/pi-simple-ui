# Approved core implementation ledger

This supplements `TODO.md`; it does not replace or reorder task IDs. The accepted
product is the core/barebones graphical Pi UI described in `PLAN.md` and
`AGENTS.md`. Existing optional modules may remain in the source tree, but their
presence does not make them deliverables and their absence is not a core gap.
Do not claim that out-of-scope code was removed.

File presence and typechecks are not feature confirmation. No tests, test suites,
browser checks, or packaging reviews are current deliverables. Preserve the user
rule: implement → review → fix → confirm actual working feature → only then
user-authorized regression tests.

## In-scope integration points

- Native Pi command menus and their outcomes/continuations must reach the renderer;
  standard select/input/confirm/editor interactions use reusable graphical
  dialogs and preserve native values and cancellation.
- Native Pi input, command effects, model/thinking/toggle operations, and command
  feedback remain Pi-owned and must be connected to the graphical host. Do not
  replace them with extension-specific adapters or model prompts.
- Pi and extension configuration is edited through existing native plain-text
  files at their native paths/scopes. Support edit/add/save while preserving
  untouched content; Pi remains authoritative for interpretation and loading.
- **Generic custom-menu host is pending, not confirmed (active88).** T13/T14
  require one generic host that runs the original `custom()` component in a
  terminal-style panel and preserves native input/callbacks, nesting, back, and
  cancel. It must not become a collection of hardcoded per-extension menus or
  forms. Related bridge code, typechecks, or file presence do not complete it.
- Complete conversation viewability remains required for every subagent session
  the host actually observes. Do not require or assume a particular provider or
  Herdr launch. Restore actual conversation history where available; do not
  substitute status-only previews or turn-end artifact tails for live events.
- Preserve Herdr's external ownership: no control of its panes, launcher, trust
  broker, or FIFO transport. Pi remains authoritative for input and native
  commands. Display a Herdr conversation only if the host actually observes it.

## Not acceptance prerequisites

Dedicated powerline, pi-tasks, Headroom/1Password, web-access/curator, and other
named extension integrations are not prerequisites. Neither are masked secret
prompts, provider-specific definition/account editors, MCP connection management,
MCP catalogs/exposure controls/Apps viewers, or skills/package/resource
management pages. Native command dispatch and truthful result/feedback are still
required. Native config files remain editable through the generic editor; no
field-specific extension UI is implied.

Do not promise universal custom-extension compatibility. Extensions requiring
direct stdin/stdout or an external terminal may not be hostable; report that
limitation instead of inventing alternate behavior.

## Historical source-inspection notes (not current obligations)

The earlier 2026-10-04 source ledger recorded the following integration notes
under the broader product scope. They are retained as historical evidence only;
this documentation-only correction did not re-inspect source or assert that code
was removed:

- MCP management/catalog/exposure/Apps factories had pending composition and
  renderer wiring notes.
- Skills/templates management UI mounting and provider-model editor composition
  had pending integration notes. The approved native-file editor supersedes those
  specialized management surfaces; it does not assert their files or code vanished.
- Worker-history startup restoration/readiness and conversation pagination had
  pending wiring notes. This remains relevant only to complete conversations for
  sessions the host actually observes.
- Tintinweb/nicobailon provider adapters and provider editor registry had pending
  composition notes. Provider-specific definitions/install are not prerequisites;
  observed-session conversation viewability is still in scope.
- A Radius-first sharing operation and consent path had pending SDK export and
  composition notes. Sharing is not an approved core prerequisite.
- Quota/web-access/curator/FFF bridge bindings had hardcoded/stub behavior notes.
  Those named integrations are not prerequisites; do not infer their implementation
  state from this historical note.

## Reconciliation rule

Keep approved core tasks unchecked until actual behavior is confirmed. Do not add
per-extension integration prerequisites to close a generic host or native-file
editor gap. Do not use tests or typechecks as feature confirmation.
