---
# wm-nesr
title: Stop workspace focus activation loops
status: completed
type: bug
priority: critical
created_at: 2026-08-16T17:58:38Z
updated_at: 2026-08-16T18:18:50Z
---

Investigate and fix rapid workspace focus swapping after focusing C then M. Determine interaction among NSWorkspace activation notifications, observer reconciliation, retained/stale window identities, focused workspace state, parking, and transaction coalescing. Preserve external-focus adoption without manager-initiated focus causing feedback loops.

## Plan

- [x] Reproduce or derive the C/M activation feedback sequence.
- [x] Identify the missing suppression/idempotency boundary.
- [x] Implement a focused fix with deterministic regression coverage.
- [x] Run full and live validation.

## Reproduction Update

User reproduced the focus loop with Spotify and System Settings together on workspace C after commenting overlap out of the configured policy chain. Investigate both the apparent overlap despite stack fallback and the C focus activation loop against the current final daemon.

## Summary of Changes

Fixed two interacting defects. Configuration application now clears stale per-workspace runtime layout-policy overrides, so hotloaded config is authoritative and commenting out overlap produces `greedy,stack,overflow`. Manager-initiated focus effects now register bounded one-shot expected activation PIDs; matching NSWorkspace activation callbacks are consumed instead of being mistaken for external focus intent. Observer-triggered geometry placement remains best-effort and no longer rolls back an otherwise valid externally focused workspace solely because constrained geometry failed to converge.

## Validation

Added `configurationReloadClearsWorkspaceLayoutPolicyOverride`. `swift test --filter WMDaemonTests` passed 41 tests, full `swift test` passed 161 Swift Testing and 70 XCTest cases, `swift build` passed, and `git diff --check` passed. Restarted the final daemon as PID 90083. Live `M -> C` focus with Spotify and System Settings on C remained focused on C after five seconds, C reported `greedy,stack,overflow`, and `/tmp/wm-daemon.log` remained empty.
