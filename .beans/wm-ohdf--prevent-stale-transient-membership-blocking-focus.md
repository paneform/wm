---
# wm-ohdf
title: Prevent stale transient membership blocking focus
status: completed
type: bug
priority: critical
created_at: 2026-08-20T02:27:11Z
updated_at: 2026-08-20T19:15:58Z
---

A stale or unhealthy window identity retained in workspace membership must not block all workspace focus operations. Reproduce from the AutoFillPanelService CG-to-AX identity transition, prune ineligible replacement membership, and ensure effect execution skips non-controllable stale members safely.

- [x] Commit generalized transient and placement solution without ignored-window configuration
- [x] Trace stale CG/AX replacement lifecycle and workspace reconciliation
- [x] Add regression coverage for focus operations with stale transient membership
- [x] Implement minimal lifecycle/effect fix
- [x] Run focused and full validation
- [x] Restart daemon and verify workspace switching
- [x] Record summary and complete

## Progress

Committed generalized handling as 0d149d8 (`fix(wm): keep transient windows out of workspace effects`). The ignored-window configuration and its bean were excluded.

## Design Direction

Move window decisions toward deterministic, ordered rules with traceable evidence and outcomes. Represent geometry capabilities as generic position/size controllability with separate reported and behaviorally confirmed evidence. Platform adapters project host-specific signals such as AX attribute settability into generic reported capabilities. Reported fixed geometry quarantines a window before membership; bounded probes attempt movement/resize and restore the original frame, then confirm support/fixed status or leave evidence indeterminate. Retest on relevant lifecycle changes such as focus regain, child changes, changed platform reports, or explicit assignment. Persist confirmed profiles with invalidation and identity safeguards.

New-window preflight and commit-on-success is tracked separately in wm-wddy.

## Safeguards Implemented

Replacement inference now excludes transient and unmanaged candidates. Workspace focus, parking, restoration, and tiling skip currently observed transient members. Session reconstruction applies authoritative stale-member pruning before geometry effects. Full tests and build pass. Live AutoFillPanelService remains represented as a current normal CG-backed surface, so capability discovery and behavioral probing are the remaining work.


## Current Reproduction

- [x] Reproduce focusing workspace T from another workspace.
- [x] Identify the failing geometry path and root cause.
- [x] Implement and test the minimal fix.
- [x] Verify the live transition and complete validation.


## Root Cause

`StartupIntentAudit.candidate` called `reconcileObservedWindows` without capability-derived floating IDs during every workspace focus. Focusing B therefore cleared `window:cg:3819` from T's `floating_window_ids` and inserted it into T's BSP. The subsequent B-to-T transition failed at `tile_incoming` because the fixed-size AutoFill surface cannot be resized.

## Verification

After rebuilding and restarting, focusing B preserved `window:cg:3819` as floating and outside T's BSP. The following B-to-T focus completed with `effect_status: verified`. The focused regression, full `swift test`, `swift build`, and `git diff --check` all pass.


## Summary of Changes

Preserved learned floating membership through startup-intent reconciliation, preventing fixed-size AutoFill surfaces from re-entering BSP during unrelated workspace focus. Added regression coverage across periodic reconciliation and request-time focus. Live B-to-T switching succeeds after restart, and full validation passes.
