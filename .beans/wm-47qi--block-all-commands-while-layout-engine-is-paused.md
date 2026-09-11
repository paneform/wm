---
# wm-47qi
title: Block all commands while layout engine is paused
status: completed
type: bug
priority: high
created_at: 2026-09-03T16:13:29Z
updated_at: 2026-09-03T16:15:52Z
---

Paused mode must reject every command except resume and togglePause.

- [x] Inspect command dispatch and existing paused behavior
- [x] Enforce the paused command allowlist
- [x] Add regression coverage
- [x] Run relevant checks

## Summary of Changes

Replaced the paused mutation denylist with a command-dispatch allowlist. While paused, only resume and togglePause execute; all queries, config operations, pause, and other mutations return the paused error. Added regression coverage and updated a lifecycle test to use the internal reconcile API while paused.

Validated with the full layout test suite (325 tests), lint, typecheck, build, targeted formatting checks, and git diff checks. The package-wide format check still reports pre-existing formatting issues in src/engine.ts and src/platform.ts.
