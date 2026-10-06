# Upstream provenance

This app-local copy is based on the installed npm package `@jmcombs/pi-1password@2.3.2` at:

`/Users/npittas/.pi/agent/npm/node_modules/@jmcombs/pi-1password`

Upstream project: <https://github.com/jmcombs/pi-extensions/tree/main/packages/1password>

The source files, package metadata, curated data, README, and MIT license were copied from that installed package. `ui/bordered-popups.ts` is the only adapted upstream source file: its native `ctx.ui.custom` TUI path is retained, with an RPC fallback to native UI methods when the host reports custom UI unsupported. The fallback fails closed for masked secret input because the public SDK input/editor API does not provide masking. No credential operations, storage formats, command behavior, or public exports were changed.

The local extension loader entry is `vendor/pi-1password/index.ts`, matching `package.json`'s `pi.extensions: ["./index.ts"]`; `main` and `types` also remain `./index.ts`. The package does not declare an `exports` map. Its credential API barrel exports `onboardSecret`, `changeSecret`, `verifySecret`, `resolveSecret`, `deleteSecret`, and `is1PasswordAvailable`; the upstream index's other named exports and default extension entry are also retained.

The upstream `LICENSE` is included unchanged. Do not edit the globally installed package; make app-specific changes only in this directory.
