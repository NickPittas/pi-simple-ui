# TODO

Open work for Pi Desktop. The old T01-T61 implementation checklist was retired on 2026-10-07; its history lives in Git.

**Rules that still apply** (see [AGENTS.md](AGENTS.md)): Pi stays authoritative; no tests for a feature the user has not confirmed working; Herdr stays external; no per-extension UIs; do not commit or release unless asked.

Status words: **pending** = not built or not confirmed in the running app. Nothing below is claimed working until the user confirms it.

## Confirmed working (user-verified)
- File and image attachments in the native composer (path insertion; clipboard images staged to temp).
- Inline slash-command result cards.
- Regression suite for the above, validators and projections (`npm test`).
- Searchable scoped model picker and Models page scoped-models editor: shipped in v0.1.4/0.1.5, **popover placement and editor not yet confirmed**.

## Pending: product surfaces
- [ ] **Sessions page.** The nav item still shows "Pending native wiring". The sidebar list exists (`NativeSessionList`); a full browse/search/tree/resume page does not. Saved-session catalogue remains unsupported.
- [ ] **Generic custom-menu host.** Original native `custom()` components in a terminal-style panel (`NativeCustomTerminal`). Bridge code exists; actual behaviour, nesting and cancel are unconfirmed. Be honest about extensions that need direct stdin/stdout.
- [ ] **Observed subagent conversations.** Show full conversations for child sessions the host actually observes. Never assume a Herdr launch.
- [ ] **Standard blocking dialogs.** select/confirm/input/editor render, but real interaction is unconfirmed.
- [ ] **Known renderer error.** xterm dimensions console error persists even without opening the terminal.

## Pending: model scope
- [ ] Scoped editor treats glob entries (`zai/*`) as "not in catalogue" (they are kept on save). Make it glob-aware.
- [ ] Saving rewrites `settings.json` with 2-space indent; other formatting is lost. Consider a minimal-diff writer.
- [ ] Pi's own model cycling needs "Restart Pi to apply" after a scope change. Explore a live reload.
- [ ] Remove or wire the legacy main-process `models.*` code (`ipc/models.ts`, `models/model-service.ts`, `models/model-settings.ts`, `compose.ts`), which the real startup path (`native-compose.ts`) does not register.

## Pending: slash-command results
- [ ] Attribution is timing-based (20 s window, +3 s per notice). A background notice in that window shows under the command. Pi's RPC notify carries no command id; revisit if Pi adds one.
- [ ] Results are not persisted across reload (by decision).

## Pending: packaging and project
- [ ] App icon and `desktopName` in package.json (electron-builder warns on both).
- [ ] Verify downloaded release checksums against `SHA256SUMS` in CI or by hand.
- [ ] macOS and Windows packaging (Linux x86-64 only today).
- [ ] Sessions/Usage placeholders: decide per page whether to build or remove the nav item, as was done for Models.

## Tooling notes (outside the repo)
- The Herdr `medium`-thinking fix is a local patch to `~/.pi/agent/npm/node_modules/pi-herdr-agents/maestro/core/routing.ts` (original saved as `routing.ts.orig`). A `pi-herdr-agents` update overwrites it; reapply or restrict fallback chains to models supporting the level.
- Read-only Herdr roles rely on a prompt rule, not tool enforcement, because `codemode` can write.

## Explicitly out of scope
Provider/account management UI, MCP server management and Apps viewer, package/resource lifecycle management, skills/template managers, usage/cost dashboards, Code Mode trace views, provider-specific subagent editors (Tintinweb, Nicobailon), and any orchestrator or Herdr takeover.
