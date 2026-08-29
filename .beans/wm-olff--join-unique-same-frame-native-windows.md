---
# wm-olff
title: Join unique same-frame native windows
status: completed
type: bug
priority: high
created_at: 2026-08-28T22:14:34Z
updated_at: 2026-08-28T22:17:58Z
---

Allow native normalization to join a normal AX window to a unique same-PID, exact-frame Core Graphics surface when AXWindowNumber is unavailable and titles differ, while preserving ambiguity rejection.

## Plan

- [x] Add normalizer regression coverage for unique-frame and ambiguous-frame joins.
- [x] Implement the minimal join acceptance change.
- [x] Run native and full workspace validation.
- [x] Rebuild/package the signed native host and verify Activity Monitor enters inventory.
- [x] Review live behavior and final diff.

## Summary of Changes

- Allowed unique same-PID exact-frame AX-to-CG joins when IDs are unavailable and titles differ.
- Added regressions for the successful unique join and rejected duplicate-frame ambiguity.
- Passed native and workspace tests, lint, typecheck, build, and diff checks.
- Rebuilt and signed WM.app, refreshed the launch agent, and verified Activity Monitor is managed as window:cg:47.
