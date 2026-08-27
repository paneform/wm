---
# wm-81u4
title: Fix workspace display move persistence
status: completed
type: bug
priority: high
created_at: 2026-08-27T01:30:07Z
updated_at: 2026-08-27T04:49:50Z
---

Investigate whether moving a workspace between displays fails to preserve its destination for later window moves. Verify workspace move-next behavior and the interaction among visibleOnDisplay, pinnedDisplayOverride, preferredDisplay, and explicit window moves.

## Todo

- [x] Capture current multi-display workspace assignments
- [x] Reproduce workspace move-next and later window move behavior
- [x] Identify the display-assignment state defect
- [x] Add regressions and implement the fix
- [x] Run full automated validation and review
- [x] Deploy engine fix and restart service
- [x] Live-verify after native inventory recovers
- [x] Record live results and complete the bean

## Root Cause

Native/external focus updates focusIntent but does not rewrite focusedWorkspace. `moveFocusedWorkspaceToNextDisplay` selected world.focusedWorkspace before acquiring the exclusive gate. Clicking Docker in D while C remained the last command-focused workspace therefore moved and pinned C instead of D. The captured live state confirmed this: C had a secondary-display pin while D had no pin. A later Ghostty T-to-D move correctly saw no D assignment and inherited T source display.

## Implementation

Resolve the workspace containing the authoritative focused window after acquiring the compound transaction gate, then fall back to focusedWorkspace only when no focused member exists. Capture only selected/displaced members, validate topology identity/order before commit, and preserve a true single-display no-op. Added external-focus, pending-focus race, and hidden pinned-destination regressions.

## Validation

Final quality review found no must-fix issues. Engine: 18 files and 291 tests passed; typecheck and git diff --check passed.

## Live Verification Blocker

The engine-only fix was deployed by restarting the authorized service. After restart, the native sidecar reports accessibility=true and screenRecording=true but returns an empty window inventory, including from a direct getWindows protocol request. Reconcile and a second service restart did not recover inventory. Display-move verification was intentionally stopped because issuing workspace mutations with empty membership would not test the real scenario safely. This inventory issue is separate from the display-selection defect and requires recovery before the final live check.

## Live Verification

After inventory recovered, B was made logically focused, Docker was focused directly, and `workspace move next` was invoked. D, not B, received the primary-display pinnedDisplayOverride. D later became hidden while B reconciled visible, but the D pin persisted.

Ghostty was then moved from T to D with the normal focused-window command. It landed on D’s pinned primary display and tiled beside Docker at x=756, proving destination display assignment was honored. Ghostty was moved back to T and settled at (-1030, -1408), 3440 x 1408 on the secondary display. D remained pinned and visible on primary with Docker full-size. Health remained healthy.

## Summary of Changes

Fixed workspace display movement to resolve the workspace containing the authoritative focused window under the transaction gate instead of using stale focusedWorkspace state. Preserved pins for hidden destinations, handled pending focus races and topology changes safely, retained true single-display no-op behavior, and verified later window moves use the destination workspace display assignment.
