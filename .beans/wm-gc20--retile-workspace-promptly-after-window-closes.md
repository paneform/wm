---
# wm-gc20
title: Retile workspace promptly after window closes
status: completed
type: bug
priority: high
created_at: 2026-08-28T16:39:19Z
updated_at: 2026-08-28T17:13:29Z
---

A closed window disappears from wm state before its workspace layout is recomputed, leaving a visible delay. Trace lifecycle event scheduling and trigger prompt retiling without adding redundant layout work.

## Plan

- [x] Trace close/removal events through world updates and rule evaluation.
- [x] Add a focused regression test for close-to-retile behavior.
- [x] Implement the smallest scheduling or event fix.
- [x] Run targeted and full validation.
- [x] Summarize the verified change.

## Summary of Changes

- Queue an immediate coalesced reconciliation after a removeWindow action is applied so BSP layout rules see the collapsed tree without waiting for another platform event.
- Add an event-driven regression test proving the surviving window fills the display after its peer closes.
- Verified the focused regression and startup-event test, TypeScript typecheck, oxlint, and git diff checks.
- Full Vitest attempts timed out in existing tests that leave engine fibers running. Repository format-check also reports 38 pre-existing files under the concurrently added oxfmt configuration.

## Restart Regression

- [x] Check daemon process, socket, and launchd logs after restart.
- [x] Determine whether reconciliation is looping or startup failed.
- [x] Fix and verify command handling before restarting again.

## Restart Regression Summary

- Root cause was a native lifecycle replacement collision: the replacement target was already managed, so substituting the stale source created duplicate membership and every periodic update failed validation.
- Preserve the already-managed replacement target and remove only the stale source membership.
- Added regression coverage for a replacement target already present in the BSP.
- Built and signed the release native host, restarted launchd, and verified state requests and SketchyBar state updates recover.
- Full Swift suite passed, including 147 XCTest cases and all Swift Testing cases; engine typecheck also passed.
