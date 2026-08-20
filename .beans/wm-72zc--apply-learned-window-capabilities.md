---
# wm-72zc
title: Apply learned window capabilities
status: completed
type: feature
priority: critical
created_at: 2026-08-20T18:48:42Z
updated_at: 2026-08-20T19:03:26Z
---

Persist reported and behaviorally confirmed position/size capability evidence, merge it into matching window lifetimes and future profiles, and use deterministic rules for workspace admission and geometry effects. Position-fixed windows remain outside management; size-fixed position-supported windows may be assigned and parked but must not be resized during layout.

## Plan

- [x] Define lifetime and persisted capability profile identity/invalidation
- [x] Persist successful probe evidence and merge it into inventory/session windows
- [x] Apply deterministic workspace admission rules from capability evidence
- [x] Make tiling and parking capability-aware
- [x] Reconcile existing membership when learned evidence changes eligibility
- [x] Add unit, daemon, persistence, and live regression coverage
- [x] Run full validation and record summary

## Exploration Findings (2026-08-20)

- Existing durable store: `Sources/WMPersistence/WindowGeometryProfileStore.swift`, loaded in `Sources/wm/WMMain.swift`; profile identity is bundle ID (fallback executable path) + AX role/subrole in `Sources/WMInventory/WindowGeometryProfiles.swift`.
- Probe results currently return only from `WindowGeometryService.probeCapabilities`; `DaemonHandler` does not persist, merge, or reconcile them.
- Admission is centralized in `ManagedWindowLifecycle.reconcile/applying`, followed by `DaemonHandler.applyLifecycleUpdate` and `WorkspaceState.reconcileObservedWindows`.
- Fixed-size layout requires an explicit no-resize representation; current min/max constraints still call `setGeometry`, and `AXWindowGeometryAdapter.validateControllability` requires both position and size settable.
- Parking currently performs size-position-size and verifies size, so fixed-size windows need position-only parking and position-centric acceptance.
- Position-fixed evidence should project to unmanaged before lifecycle reconciliation; post-probe changes should run the same lifecycle/update path immediately.
- Recommended minimal architecture: extend the existing geometry profile catalog with persisted capability evidence, add a deterministic capability resolver/policy shared by inventory merge, lifecycle admission, tiling, and parking, and make the probe endpoint persist then reconcile.
- Primary risks: coarse profile-key collisions, stale app-version/context handling, explicit manage override precedence, contradictory reported/confirmed evidence, non-transactional profile/workspace updates, and rollback paths attempting resize on fixed-size windows.

## Implementation Plan (2026-08-20)

- [x] Add persisted per-workspace floating membership and deterministic BSP/focus mutations
- [x] Add confirmed-first capability admission policy and lifecycle projection
- [x] Persist and merge verified profile evidence across startup, observations, and exact probed lifetimes
- [x] Add position-only geometry effects for floating parking/restoration/movement
- [x] Reconcile probe results immediately in restoration-safe endpoint order
- [x] Cover persistence, policy, lifecycle, workspace, geometry, daemon, startup, and future-profile behavior
- [x] Run focused tests, full swift test, swift build, and git diff --check

## Summary of Changes

- Added backward-compatible per-workspace floating membership. Position-only windows remain assigned and focusable but are excluded from BSP leaves, layout, and directional BSP commands.
- Added confirmed-first capability admission: position-fixed is unmanaged, position-supported/size-fixed is managed floating, supported position/size is BSP, and unknown or inconclusive evidence preserves management.
- Persisted only restoration-verified probe evidence in geometry profiles, merged profiles before startup/recovery/periodic lifecycle reconciliation, and reconciled the exact probed lifetime immediately.
- Added position-only geometry writes with unchanged-size verification for floating parking, restoration, transitions, rollback, startup audit, and shutdown.
- Added protocol/workspace/profile/lifecycle/geometry/daemon tests, including reported-versus-confirmed precedence, AutoFill-like fixed-size behavior, future matching windows, and immediate probe reconciliation.
- Validation: focused profile/lifecycle/workspace/geometry/persistence/daemon suites passed; full `swift test` passed with 102 XCTest tests plus all Swift Testing suites; `swift build` passed; `git diff --check` passed.

## Residual Risk

- Geometry profile identity is intentionally coarse: bundle ID (or executable path fallback) plus AX role/subrole and current profile context. Distinct window types sharing those fields can inherit capability evidence. Live representative probing should verify that this quarantine scope is acceptable before broad production use.
- Live representative application probing was not performed in this task; it remains tracked by wm-egs1.
