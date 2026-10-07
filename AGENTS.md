# Implementation rules

## Feature confirmation and regression tests

**MANDATORY USER RULE FOR EVERY CURRENT AND FUTURE IMPLEMENTATION AGENT:** “NEVER create or run tests for an unverified feature. Implement → review → fix → confirm actual working feature → only then user-authorized regression tests.” Typechecks and file existence are not confirmation that a feature works. Do not create tests for unverified features, do not use tests to stand in for feature confirmation, and do not run test suites before the feature has been confirmed and the user has authorized regression coverage.

A Vitest regression suite (`npm test`) now exists, authorized by the user on 2026-10-07 for features the user confirmed working in the running app (attachments, inline command notices, validators, conversation projection, model scope). The rule above still applies to every new feature: no tests for an unverified feature, and no test plans disguised as verification. Add or extend tests only after the user confirms the feature, and keep this suite green. Typechecks and passing tests do not confirm a feature works.

## Herdr ownership boundary

Herdr is an external TUI. The app must not control or reimplement Herdr's panes, subprocess launcher, trust broker, or FIFO transport. Pi remains authoritative for input and native command dispatch. The requested app behavior is Pi input/commands plus viewability of complete conversations for any subagent session the host actually observes; show Herdr only if it is actually encountered. Passive observation does not authorize taking over an external launch or process lifecycle.

## Work priority and scope

Prioritize connecting native backend capabilities to the frontend. Respect each user's explicit write scope and validation limits; do not modify unrelated application, vendor, package, or test artifacts when the requested scope is documentation-only. Do not commit unless the user explicitly asks.

## Approved product boundary

The approved deliverable is a core/barebones graphical Pi UI: Pi remains authoritative for execution, command effects, configuration meaning/loading, and native operations. Persistently read, display, edit, add, and save Pi and extension configuration through their existing native plain-text files (for example YAML, TOML, JSON, or conf formats as encountered), preserving unedited/unknown content. Forward model, thinking, toggle, and other native operations to Pi rather than reproducing their semantics.

Use reusable graphical select/input/confirm/editor dialogs for standard native interactions. For extension custom submenus, use a generic host for the original native `custom()` component in a terminal-style panel, preserving its native input/callbacks, back/cancel behavior, and nesting. Do not hardcode per-extension fields, menus, or management UIs, and do not promise universal compatibility with arbitrary extensions; direct stdin/stdout or external-terminal requirements may not be hostable and must be reported honestly. The generic custom-menu host is not implemented/confirmed merely because related bridge code exists; keep it pending until actual behavior is confirmed.

Keep core Pi session and conversation behavior. Show complete conversations for any subagent sessions the host actually observes, without creating an orchestrator or assuming a Herdr launch. Preserve Herdr's external ownership boundaries. Existing optional/extra modules are not automatically deliverables; retain native command routing and feedback without turning each extension into a separate integration prerequisite. Nicobailon is not a standalone acceptance prerequisite.
