---
# wm-jqsl
title: Re-review layout-browser anti-slop fixes
status: completed
type: task
priority: normal
created_at: 2026-09-01T07:59:29Z
updated_at: 2026-09-01T08:01:32Z
---

Re-review the current uncommitted packages/layout-browser diff after fixes for recording recovery, reference substitution, and CommandError recognition. Review only; do not modify package code.

## Plan

- [x] Inspect the revised diff and surrounding implementation.
- [x] Verify each prior finding and its tests, including edge cases.
- [x] Run package lint, typecheck, and tests.
- [x] Record any remaining findings or residual risk.
- [x] Deliver the re-review.

## Findings

No findings.

- Per-entry recording decode at packages/layout-browser/src/ui/scenarios.ts:376-397 isolates malformed entries, while save at lines 357-364 merges against raw storage and preserves malformed siblings. Tests at packages/layout-browser/test/renderer.spec.ts:609-634 cover recovery and preservation.
- JSON reviver substitution at packages/layout-browser/src/ui/scenarios.ts:192-201 operates on decoded strings and correctly resolves quoted, backslash, control-character, and empty refs. Tests are at packages/layout-browser/test/renderer.spec.ts:584-607.
- Command errors are validated structurally at packages/layout-browser/src/host.ts:41-54 and used at lines 109-119 and 140-146. Tests at packages/layout-browser/test/renderer.spec.ts:661-672 cover valid tagged timeouts and malformed payloads.

## Validation

- pnpm run lint: passed.
- pnpm run typecheck: passed.
- pnpm run test: passed (2 files, 31 tests).

## Residual Risk

- A syntactically invalid or non-record top-level localStorage value cannot be preserved when a later save replaces it.
- Timeout tests exercise the structural helper rather than a complete DOM-mounted renderer command flow.
- No browser end-to-end or package build was run because this was a no-edit review.

## Summary of Changes

Re-reviewed all three fixes and their added tests. The prior findings are addressed without an identified regression.
