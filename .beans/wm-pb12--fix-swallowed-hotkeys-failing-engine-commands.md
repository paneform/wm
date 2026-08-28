---
# wm-pb12
title: Fix swallowed hotkeys failing engine commands
status: completed
type: bug
priority: high
created_at: 2026-08-28T17:15:52Z
updated_at: 2026-08-28T17:28:01Z
---

Native keybinds are swallowed and emitted, but their engine commands have no visible effect after restart. Recent diagnostics report failures capturing window:cg:48.

## Plan

- [x] Reproduce the mapped command over WebSocket and identify the failed capture path.
- [x] Correct stale or uncontrollable-window handling without weakening identity safety.
- [x] Add regression coverage and run targeted/full validation.
- [x] Deploy, restart, and verify native hotkeys end to end.

## Current Finding

The final post-restart command reached the engine but capture failed for `window:cg:48`. `WindowMeta` currently replaces the AX-reported window number with the matched Core Graphics ID. When those IDs differ, `GeometryAdapter.resolve` rejects the same AX window as stale/not found. Preserve the AX-reported number for AX element resolution while retaining the Core Graphics ID as the public stable window ID.

## Summary of Changes

- Prevented empty workspace sentinels from causing infinite reconciliation.
- Serialized SketchyBar trigger publication to prevent process exhaustion.
- Preserved AX-reported window numbers when resolving live Accessibility elements, while retaining Core Graphics IDs for stable public window identity.
- Added focused engine and Swift regressions.
- Rebuilt, signed, deployed, and restarted the native host.
- Verified both direct workspace commands and the Right Shift+B native hotkey. The daemon remained healthy with no queued workspace-change trigger children.

Validation: focused engine regressions, node-host tests, engine/node-host typechecks, engine lint, full Swift tests, release build, signed package verification, direct commands, physical hotkey, and `git diff --check`.
