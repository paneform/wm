---
# wm-c6s1
title: Place new windows by precedence
status: completed
type: bug
priority: critical
created_at: 2026-08-19T22:48:10Z
updated_at: 2026-08-20T02:08:50Z
---

Implement new-window placement precedence: preserve restored/replacement membership, then configured affinity, then currently focused workspace. Remove hard-coded runtime fallback to workspace 1 and ensure adoption alone never changes focused workspace.

- [x] Add workspace-domain tests for placement precedence and focus preservation
- [x] Pass focused workspace fallback through lifecycle reconciliation
- [x] Preserve replacement/restoration and configured affinity precedence
- [x] Prevent same-cycle focused-window observation from switching workspaces
- [x] Run focused and full validation
- [x] Restart daemon and live-test modal behavior
- [x] Record summary and complete

## Progress

Implemented and deployed placement precedence. The daemon restarted healthy with workspace T focused. Existing/restored membership remains first, configured affinity is applied to unassigned windows next, and remaining unassigned windows join the currently focused workspace. Reconciliation does not change focused workspace. Full tests and build pass. Awaiting one live modal trigger to validate behavior end-to-end.

## Summary of Changes

Live FileVault validation succeeded for workspace placement: the authorization window `window:cg:3631` joined currently focused workspace T and T remained focused and visible throughout observation. No cross-workspace parking or activation occurred. The modal is still classified normal and inserted into T's BSP, causing local retiling; preventing that requires separate transient/floating identification or delayed tiling.

Validation: `swift test`, `swift build`, `git diff --check`, daemon restart, and live modal observation pass.
