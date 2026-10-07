# Changelog

All notable changes to Pi Desktop. Dates are release dates; versions follow the GitHub releases.
Items are marked "verified" only when the maintainer confirmed them in the running app.

## 0.1.5
- Fix: the model picker popover opens below its button, right-aligned, and its height is capped to the window so it is no longer clipped.

## 0.1.4
- Model picker in the top bar is now a fuzzy-search combobox. It lists the scoped models (`enabledModels`) by default, with a "Show all models" toggle when a scope exists.
- Fix: the app talks to Pi over RPC, which only returns the full catalogue, so the scoped list never arrived. The main process now resolves `enabledModels` from `~/.pi/agent/settings.json` (exact `provider/id`, bare id, `*`/`?` globs, in order) on each model refresh. `NativeModelState` gained `allModels` and `scoped`.
- The Models page now hosts a scoped-models editor (search, tick by provider, reorder, save, "Restart Pi to apply") instead of a placeholder. Saving rewrites only `enabledModels` in `settings.json`.
- Removed the unused legacy model UI (`ModelPicker`, `ScopedModelsPage`, `ThinkingControls`).

## 0.1.3
- Added a Vitest regression suite (`npm test`) for confirmed behaviour: attachments, inline command notices, IPC and content validators, conversation projection.
- Fix: a tool result with plain-string content shows its text instead of `Structured content: {...}`.
- Fix: `native.pi.stage-attachment` rejects base64 whose length is not a multiple of 4.
- Staged clipboard attachments older than 24 hours are deleted at startup.

## 0.1.2
- Slash-command results (`ctx.ui.notify` output) appear inline in the conversation as "Command" cards (info, warning and error styles) instead of only in the notice panel. Attribution is timing-based (about 20 s after a submitted `/command`), is not persisted, and is cleared on reload. Verified.

## 0.1.1
- File and image attachments work in the native composer. The picker and drag-and-drop insert the file's original path; pasted clipboard images are staged to a temp file and its path is inserted, as Pi's own TUI does. Verified.

## 0.1.0
- First public release: dark conversation UI, native Pi RPC prompt flow, model and thinking controls, workspace selection, workspace terminal, native configuration views. See docs/releases/v0.1.0.md.
