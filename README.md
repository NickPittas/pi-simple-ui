# Pi Desktop

A desktop companion for native Pi coding-agent sessions. Pi remains responsible for model execution, commands, authentication, and configuration.

## Linux prerequisites

- Linux x86-64 and an installed, configured Pi CLI.
- Pi Desktop looks for `$PI_CODING_AGENT_DIR/bin/pi`, or `~/.pi/agent/bin/pi` when that variable is unset. If that executable is unavailable, it uses `pi` on `PATH`.
- A Nerd Font is recommended for terminal-origin glyphs. The application does not install fonts or bundle user credentials/configuration.

Open a project folder in the application to start its native Pi RPC session. The workspace terminal is a separate shell; Herdr retains ownership of its own panes and processes.

## Build from source

Requires Node.js >=22.19.0 and a C/C++ build toolchain for `node-pty`. The repository pins pnpm; no global pnpm installation is required.

```sh
npx --yes pnpm@10.34.6 install --frozen-lockfile
npx --yes pnpm@10.34.6 run dist:linux
```

This compiles vendored library dependencies and assets, typechecks the app, builds Electron output, rebuilds native modules for Electron, and produces AppImage/deb files in `release/` without publishing. The separately installed Pi CLI is not rebuilt or replaced.

For development after preparing vendored libraries:

```sh
npx --yes pnpm@10.34.6 run build:vendor
npx --yes pnpm@10.34.6 run dev
```

## Features

- Native Pi RPC conversation with a dark UI; Pi stays authoritative for execution, commands and configuration.
- **Attachments:** attach files or images with the picker, drag-and-drop or paste. Picker and drop insert the file's original path; pasted clipboard images are staged in a temp directory (cleaned after 24 hours) and their path is inserted.
- **Slash commands:** results of commands (`ctx.ui.notify`) appear inline in the conversation as "Command" cards. Attribution is timing-based and not persisted.
- **Models:** the top-bar picker has fuzzy search and shows your scoped models (`enabledModels`) by default, with a toggle for all models. The Models page edits the scoped list and can restart Pi to apply it.
- Workspace selection, separate workspace terminal, and generic editing of native Pi and extension configuration files.

## Tests

```sh
npx --yes pnpm@10.34.6 test
```

Runs the Vitest regression suite (renderer tests use jsdom). See the rule in [AGENTS.md](AGENTS.md): tests are added only for features confirmed working.

## Scope and release notes

See the [changelog](CHANGELOG.md), the [latest release notes](docs/releases/v0.1.5.md), [v0.1.0 notes](docs/releases/v0.1.0.md) and [implementation boundaries](AGENTS.md). Open work is tracked in [TODO.md](TODO.md). This project does not promise universal compatibility with arbitrary custom terminal UIs or extensions. Private handoff screenshots, local runtime data and internal development history are excluded from Git and packages. No custom application icon is supplied; Linux builds use Electron's default icon. Vendored packages retain their upstream license and attribution files.
