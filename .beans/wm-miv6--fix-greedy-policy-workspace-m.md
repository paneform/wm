---
# wm-miv6
title: Fix greedy policy workspace M
status: completed
type: bug
priority: high
created_at: 2026-08-15T21:33:21Z
updated_at: 2026-08-15T21:38:48Z
---

Workspace M does not reflect greedy uncooperative-window behavior. Identify whether profiles are missing/not loaded, cooperation data is not reaching layout planning, configured/runtime policy resolution is wrong, or generated greedy frames are not applied. Fix root cause, add deterministic regression coverage, and validate live workspace M.

## Plan

- [x] Capture live workspace M, windows, policy, profile file, and frames.
- [x] Trace profile loading through cooperation inputs and greedy layout targets.
- [x] Fix root cause with regression coverage.
- [x] Run focused/full validation and verify workspace M live.

## Findings

- Live workspace M had Messages and Discord in a vertical BSP with greedy policy, but both observed/expected frames were the full 1512x950 work area.
- The profile catalog loaded correctly and contained Discord minimumWidth 1417; policy resolution was also correct.
- The daemon treated every successful geometry.fit result as a minimum on both axes. An exact/full-height fit therefore persisted 950 as a height minimum, and full-work-area recovery could persist 1512 as width. Greedy BSP then allocated the entire axis to one child and produced a zero-sized peer target, which the apply loop skipped.
- The fix derives session minima per axis only when the fitted dimension exceeds the requested tile. Exact dimensions are cooperative, not constraints.
- Deterministic tests cover minimum derivation and assert greedy gives the peer all remaining width after the gap.

## Validation

- Focused tests passed: fittedFrameOnlyContributesDimensionsThatExceedTile, uncooperativePoliciesProduceDeterministicPlans, and WindowGeometryTests/testFitAcceptsContainedPlatformConstraint.
- Full swift test passed: 57 XCTest tests and 144 Swift Testing tests.
- swift build passed.
- Live deployment was not performed: wm restart returns not_implemented, no launch agent exists, and the active daemon is manually started PID 93628. The final live observation is therefore intentionally pre-fix: M remains greedy with Messages and Discord both at x=0, y=32, width=1512, height=950. The persisted profile file remains unchanged, including Discord minimumWidth 1417 and Messages pendingMinimumWidth 1017.

## Summary of Changes

Corrected session minimum derivation after geometry fitting so only dimensions larger than the requested tile are treated as constraints. Added deterministic daemon and BSP assertions, and validated the complete test suite/build. Source is fixed; live verification awaits a controlled restart of the manually managed daemon.

## Live Verification

Restarted the latest daemon and removed Discord’s stale pre-fix 1417px learned minimum while preserving cooperation history. Workspace M now focuses and commits successfully under greedy policy: Messages receives `(0,32,712,950)` and Discord receives `(712,32,800,950)`. The frames exactly fill the built-in display while honoring Discord’s confirmed 800px minimum width.
