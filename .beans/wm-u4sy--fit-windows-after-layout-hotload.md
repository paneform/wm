---
# wm-u4sy
title: Fit windows after layout hotload
status: completed
type: bug
priority: high
created_at: 2026-08-15T06:34:27Z
updated_at: 2026-08-15T06:35:26Z
---

Display margin hotload can move a window without resizing it to the reduced work area. Ensure config-driven layout reconciliation fits partially clamped windows within target bounds.

## Plan

- [x] Confirm the partial geometry failure path from live observations.
- [x] Add fit fallback for config-driven visible workspace retiling.
- [x] Validate tests and live margin behavior, rebuild, and relaunch daemon.

## Summary of Changes

- Confirmed the first geometry write moved Ghostty to the margin-adjusted Y coordinate but left its old 1440-point height, outside the 1408-point target.
- Observer/config retiling now invokes bounded geometry fitting after a partial verification failure before recording a persistent clamp.
- WMDaemonTests, WMInventoryTests, and `git diff --check` passed.
- Rebuilt and relaunched daemon as PID 26780. Live top-margin changes resized Ghostty from height 1440 to 1409 while repositioning it; restored the config to top margin 32 and verified it remains valid.
