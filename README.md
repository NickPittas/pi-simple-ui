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

## Scope and release notes

See [v0.1.0 release notes](docs/releases/v0.1.0.md) and [implementation boundaries](AGENTS.md). This release does not promise universal compatibility with arbitrary custom terminal UIs or extensions. Private handoff screenshots, local runtime data, and internal development history are excluded from Git and packages.

No custom application icon is supplied; Linux builds currently use Electron's default icon. Vendored packages retain their upstream license and attribution files.
