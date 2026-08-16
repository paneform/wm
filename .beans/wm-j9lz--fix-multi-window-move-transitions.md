---
# wm-j9lz
title: Fix multi-window move transitions
status: completed
type: bug
priority: high
created_at: 2026-08-16T18:31:58Z
updated_at: 2026-08-16T18:33:47Z
---

Make workspace move-window run the full verified destination transition for multi-window source and destination workspaces.\n\n## Acceptance\n\n- [x] Park remaining source peers when following the moved window.\n- [x] Move the selected window directly to its final destination tile.\n- [x] Retile existing destination peers after the moved window.\n- [x] Preserve rollback, focus, persistence, and workspace invariants.\n- [x] Add deterministic tests for populated source and destination workspaces.\n- [x] Restart and verify with live multi-window workspaces.

## Summary of Changes

Changed workspace.move_window to always execute the full verified destination transition instead of only reconciling when the destination was already focused. The transition parks source peers, places the moved window directly at its final destination tile, then tiles destination peers. Preserved lifecycle-promoted `managed` status in retained session windows so workspace observations report effective management consistently under `expected.management`. Strengthened daemon coverage to require exact multi-window effect ordering and managed observation status.

Verified with `swift test`, `swift build`, and `git diff --check`. Restarted the live daemon as PID 74627. Live populated-destination test moved Messages from M into D, restored parked Discord, and produced left/right frames `(0,32,800,950)` and `(800,32,712,950)`. Live populated-source test moved Messages from D to M, parked Discord at `(-760,950,800,950)` with restore frame `(0,32,800,950)`, and placed Messages at full destination frame `(0,32,1512,950)`. Restoring Messages to D recovered the original BSP, focus, and exact frames.
