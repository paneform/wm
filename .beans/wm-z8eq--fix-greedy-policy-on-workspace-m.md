---
# wm-z8eq
title: Fix greedy policy on workspace M
status: completed
type: bug
priority: high
created_at: 2026-08-15T22:12:06Z
updated_at: 2026-08-16T05:44:39Z
---

Messages and Discord still do not behave correctly under the greedy uncooperative-window policy on workspace M.

## Plan

- [x] Inspect live workspace/profile state and current greedy planning.
- [x] Reproduce and identify the geometry or policy integration defect.
- [x] Implement a focused fix with regression coverage.
- [x] Run focused and full validation.

## Persisted-state startup recovery

- [x] Quarantine invalid persisted workspace state and recover from a clean state.
- [x] Apply configured workspaces, settings, display affinities, and first-match window workspace actions.
- [x] Assign every remaining managed normal window to workspace `1` exactly once with display fallback.
- [x] Add and run focused recovery tests; leave live greedy verification outstanding.

## Findings

- `WorkspaceStateStore.load()` already quarantines any decode, version, build, or validation failure by renaming the state file.
- `WorkspaceController.init` currently turns the quarantined result into a fatal startup error instead of retaining a clean state.
- Startup loads configuration before inventory reconciliation, but configuration rules are not currently used for initial workspace membership; generic reconciliation sends all unassigned managed windows to `1`.
- `WorkspaceController.configuredState` already preserves configured workspace settings and resolves display affinities, falling back to the selected default display when affinity resolution fails.
- Recovery must begin from an empty workspace state so no membership from invalid persistence can be restored.

## Startup recovery validation

- Focused test: `swift test --filter invalidPersistedStateIsQuarantinedAndRecoversByRulesThenFallback` passed (1 test).
- `git diff --check` passed.
- Live greedy verification remains outstanding, so this bean remains in progress.

## Policy Validation Plan

- [x] Prevent tolerant observer reconciliation from reporting failed geometry as verified placement.
- [x] Add deterministic behavior coverage for greedy, stack, overlap, and reject.
- [x] Verify strict user focus applies or rejects each policy deterministically.
- [x] Run full automated and live workspace M validation.

## Summary of Changes

Fixed live workspace placement end to end. Unknown stable clamps can now promote within one retry request; learned corrective strength is used from the first attempt; unchanged pre-request frames are not learned as minima; retry count no longer marks a window spatially uncooperative; workspace focus no longer bypasses policy with an implicit full-screen stack; smaller targets apply first to avoid transient overlap and stale identity; observer failures no longer commit as verified; policy replanning is bounded by window count and rejects infeasible plans; runtime policy overrides are reflected in workspace DTOs. Invalid persisted state now quarantines and recovers by configuration rules, assigning unmatched managed normal windows to workspace `1`.

Live policy verification on workspace M with automatic reconciliation paused during measurement: greedy produced Discord `(0,32,800,950)` and Messages `(800,32,712,950)`; stack produced both `(0,32,1512,950)`; overlap produced Discord `(0,32,800,950)` and Messages `(756,32,756,950)` with 44px overlap; reject failed activation and preserved the prior overlap frames. Greedy was restored and automatic reconciliation re-enabled.

Final validation passed: `swift test` (69 XCTest and 149 Swift Testing cases), `swift build`, and `git diff --check`.

## Live Visibility Follow-up

- [x] Reproduce Discord hidden and Spotify still visible after focusing M.
- [x] Restore physical parking for outgoing workspace windows.
- [x] Ensure M focus raises the intended focused window without hiding peers.
- [x] Revalidate all policies with automatic reconciliation enabled.

## Final Live Verification

After restarting the final debug binary, an automatic `M -> 1 -> M` cycle committed successfully with automatic reconciliation enabled. On workspace `1`, Spotify restored to `(0,32,1512,950)` while Discord and Messages were physically parked. Returning to `M` parked Spotify at `(-1472,918,1512,950)` and restored Discord to `(0,32,800,950)` plus Messages to `(800,32,712,950)`. Both workspace focus transactions reported `effect_status: verified`.
