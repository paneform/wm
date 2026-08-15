---
# wm-ctc6
title: Fix delayed display hotload retiling
status: completed
type: bug
priority: high
created_at: 2026-08-15T05:13:45Z
updated_at: 2026-08-15T05:15:03Z
---

Display-specific margin changes can update workspace state without immediately moving visible windows; diagnose watcher/application ordering and ensure hotload performs immediate reconciliation.

## Plan

- [x] Reproduce delayed display override application by tracing config-only transitions with no incoming windows.
- [x] Fix config layout reconciliation so visible workspaces retile directly.
- [x] Validate focused checks, rebuild, relaunch, and verify with live margin edits.

## Summary of Changes

- Root cause: config application routed all visible workspace changes through `reconcileWorkspaceFocus`. A margin-only change does not create incoming windows, so its observer tiling step had no windows to move; the later periodic inventory observer performed the visible retile instead.
- Layout-only changes on an already-visible workspace now directly retile that workspace. Display/focus transitions continue using the full focus reconciliation path.
- WMDaemonTests, `swift build`, and `git diff --check` passed.
- Rebuilt and relaunched daemon as PID 55614. Live Dell top-margin changes from 32 to 31 and back moved the visible Zen window immediately after the 500 ms watcher interval; config validation remains successful.
