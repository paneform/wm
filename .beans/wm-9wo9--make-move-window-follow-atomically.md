---
# wm-9wo9
title: Make move-window follow atomically
status: completed
type: bug
priority: high
created_at: 2026-08-16T17:58:38Z
updated_at: 2026-08-16T18:26:52Z
---

Make `workspace move-window NAME` atomically move the focused window, focus NAME, and lay out NAME. Optimize the effect plan so cooperative windows move directly once: compute destination layout with the incoming window, park unfocused source peers, move the focused window directly to its destination frame, then place other destination windows. Avoid parking then immediately restoring the moved focused window.\n\n## Acceptance\n\n- [x] Move workspace assignment from source to NAME.\n- [x] Focus NAME in the same verified transaction.\n- [x] Apply NAME layout immediately.\n- [x] Preserve atomic rollback and workspace invariants.\n- [x] Use a direct transition sequence without transient parking of the moved focused window.\n- [x] Add deterministic and live tests.

## Summary of Changes

Tracked newly moved destination windows in transition plans and prioritized their final BSP placement after source peers park, avoiding transient parking or redundant restore of the moved window. Added deterministic planner coverage and a daemon-level command test covering assignment, focus, layout, and no moved-window parking. Verified with `swift test`, `swift build`, and `git diff --check`.
