---
# wm-hf13
title: Unify command hierarchy and shared Result parser
status: completed
type: feature
priority: normal
created_at: 2026-10-01T17:12:58Z
updated_at: 2026-10-01T18:03:50Z
---

Implements the command migration agreed during docs review wm-b842.

## Plan

- [x] Implement one portable token parser and Result-returning text wrapper, command catalog and schemas.
- [x] Update engine target defaults and independent assignment follow behavior.
- [x] Migrate CLI, keybind, scenario and guided-client adapters, remove public probe-limits.
- [x] Migrate examples, configuration defaults, scripts and documentation to the new syntax.
- [x] Add meaningful parsing equivalence and assignment behavior tests; format and run tests, lint, typechecks and builds.

## Error presentation requirement

User requests friendly parsing/tokenization failures, including unknown roots such as wm doctor: doctor is not a command recognized by wm, followed by a newline and help text. Keep errors structured in Result values; CLI prints the readable message and relevant command help. Include invalid quoting, unknown commands/options, missing values and duplicate flags in validation.

## Progress

Shared parser, generated catalog, optional engine targets, assignment follow/no-follow, all client adapters, native CLI service dispatch, examples and documentation are implemented. Parser and engine regression checks pass, including focused no-follow, nonfocused follow and focused workspace defaults. Limit probing is now internal-only, including rejection by the public wire schema. Full verification passed; see Validation below.

## Summary of Changes

Implemented the agreed window/workspace/display/config namespaces, permissions reporting and window assign syntax. CLI, keybindings and scenarios share a portable token parser and Result-returning text wrapper. One specification generates the catalog, help and guided choices. Parse errors carry readable messages and contextual help; the CLI doctor smoke check prints the requested not-recognized message, help and exit status 1. Guided edits normalize alternate flag order and equals-style values through the same parser.

Unified assignment JSON under moveWindowToWorkspace with independent optional windowId and follow fields. Omitted targets resolve in the engine at execution time. Assignment follows by default; no-follow retains the source view and focuses a remaining member when applicable. Same-workspace no-follow preserves focus. Focused workspace defaults are supported for mode/display movement, and reload defaults to delta. Internal limit probing is removed from public text commands/docs and rejected by the public WebSocket schema.

Migrated examples, hero actions, docs routes, scenarios, authoring metadata, browser-check expectations and reference docs. Added docs/command-interface.md. Native service invocations now enter the TypeScript parser before host dispatch.

## Validation

All root checks passed: pnpm test (483 layout, 150 layout-browser, 17 macOS TypeScript, 54 wm, 279 site and 17 Swift tests: 1,000 total), pnpm lint, pnpm typecheck and pnpm build. Changed-file formatter checks and git diff --check passed. Regression coverage includes parser/text/JSON equivalence, quoted IDs, negative coordinates, malformed text/options, old spelling rejection, explicit-ID following, focused no-follow, same-workspace focus preservation and focused workspace defaults.
