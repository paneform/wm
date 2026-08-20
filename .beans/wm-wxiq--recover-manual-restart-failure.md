---
# wm-wxiq
title: Recover manual restart failure
status: completed
type: bug
priority: critical
created_at: 2026-08-19T22:03:28Z
updated_at: 2026-08-19T22:05:13Z
---

`wm restart --manual` stopped the active daemon, then timed out with an inaccurate launchd-supervision message and left no daemon running.

- [x] Identify the startup failure and lifecycle-state mismatch
- [x] Recover a healthy daemon using the current build
- [x] Fix manual restart diagnostics or behavior
- [x] Add regression coverage
- [x] Run focused and full validation
- [x] Record summary and complete

## Summary of Changes

The manual restart correctly stopped the old daemon, but the replacement aborted during startup intent audit while attempting to park stale member `window:cg:169`. The audit scheduled every observed hidden-workspace member even when it was unmanaged or non-normal, bypassing transient movement safeguards. Updated the audit to restore or park only normal managed windows. Also removed the inaccurate blanket claim that launchd remains supervising from startup-timeout messages.

Started the rebuilt daemon manually and verified ping readiness plus healthy workspace T observation. Added regressions for stationary transient/unmanaged startup-audit members and manual timeout wording.

Validation: focused tests, `swift test`, `swift build`, and `git diff --check` pass.
