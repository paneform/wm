---
# wm-0bn8
title: Handle fixed-size System Settings windows
status: completed
type: bug
priority: high
created_at: 2026-08-16T06:57:34Z
updated_at: 2026-08-16T17:21:05Z
---

Investigate focus/inventory visibility drift and layout behavior for System Settings, whose standard window appears fixed or maximum-width constrained. Default behavior should support floating System Settings while explicit tiling remains deterministic under greedy/stack/overlap/reject policies.

## Plan

- [x] Reproduce and characterize focus, visibility, inventory, and workspace-state divergence.
- [x] Characterize System Settings fixed/maximum geometry and policy modeling gaps.
- [x] Implement reasonable explicit tiled behavior with maximum bounds.
- [x] Add regression coverage for membership replacement, maximum learning, and bounded planning.
- [x] Run focused/full validation.

True per-window default floating is tracked separately in `wm-k9ff` because the current floating workspace effect path is incomplete.

## Findings

Focusing empty C exposed stale identity and membership divergence: System Settings had been pruned from C and re-adopted into workspace 1. Geometry profiles modeled only minimum dimensions, so its observed 723-point width when requesting a larger tile was treated as generic failure. The live floating-workspace experiment also showed movement still invokes BSP geometry and fails, so default floating cannot be safely shipped as a config-only change.

## Summary of Changes

- Geometry profiles now learn backward-compatible maximum width/height constraints from stable smaller-than-requested clamps.
- Geometry verification recognizes known maximum clamps.
- Greedy BSP allocation gives surplus space to flexible peers; stack and overlap clamp bounded windows to known maxima.
- Daemon replanning records both minimum and maximum observed constraints.
- Lifecycle replacement mapping preserves workspace membership across unambiguous same-PID/app/role identity churn instead of adopting replacements into workspace 1.
- Live config assigns System Settings initially to C but keeps C tiled until true per-window floating is implemented in follow-up wm-k9ff.

Validation passed: 70 XCTest cases, 158 Swift Testing cases, swift build, config validation, and git diff --check.

## Final Live Restore Fix

- Rejected parked restore frames whose centers are outside every display instead of treating them as valid saved geometry.
- BSP transitions now place constrained windows before focusing them.
- Fully contained smaller-than-requested frames are accepted as bounded constraints and request-local bounds are preserved during replanning.
- Background workspace moves no longer activate and tile the destination unnecessarily.
- System Settings was migrated from workspace `1` to configured workspace `C`.
- Live `workspace focus 1` and `workspace focus C` both committed with `effect_status: verified`; Settings was physically placed at the bounded visible frame before focus.
