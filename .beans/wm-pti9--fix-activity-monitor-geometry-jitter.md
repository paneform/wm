---
# wm-pti9
title: Fix Activity Monitor geometry jitter
status: in-progress
type: bug
priority: critical
created_at: 2026-08-28T22:43:36Z
updated_at: 2026-08-29T00:26:58Z
---

Activity Monitor began jittering after live debug-stop validation and service restart. Diagnose competing geometry writes or unstable inventory/readback behavior, stop the live movement, and fix the root cause without weakening shutdown reporting.

## Plan

- [x] Capture live state, recent geometry diagnostics, and Activity Monitor frame behavior while paused.
- [ ] Identify the write loop and add a regression test.
- [ ] Implement the smallest safe fix.
- [ ] Run full validation and verify the live desktop remains stable.
- [ ] Record findings and complete the interrupted debug-stop bean if still valid.

## Findings

- Direct AX sampling reproduced alternating Activity Monitor widths of 740 and 756 points.
- InventoryService selects the first AXFocused window across all applications. Multiple apps retain an internally focused window, so varying collection order can emit false cross-app focus changes and repeatedly switch workspaces.
- Focus selection must be scoped to NSWorkspace.frontmostApplication.

## Additional finding

The frontmost-application filter passes native tests but did not stop the 740/756 Activity Monitor oscillation. The shutdown path also reported successful restoration while Activity Monitor remained parked after WM stopped, so authoritative shutdown readback or subsequent writes are still incorrect.

## Shutdown-path resolution

The parked-window shutdown failure was separate from the unresolved Activity Monitor jitter. Engine operations are now scoped and interrupted before restoration, the macOS event stream is cancellable, and service lifecycle commands signal the Node child and wait for verified restoration before launchd bootout. Live service-stop validation restored six windows with zero failures and left every sampled window visible after WM exited. The Activity Monitor 740/756 oscillation still requires a separate root-cause fix.
