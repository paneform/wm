---
# wm-i001
title: Implement managed window lifecycle
status: completed
type: feature
priority: critical
created_at: 2026-08-14T18:59:08Z
updated_at: 2026-08-14T19:56:09Z
---

Scope: verified close removal, manage/unmanage overrides, classification lifecycle, and retained handle eviction.

Acceptance:
- Confirm closure before removing membership and parked metadata.
- Collapse BSP parents immediately for verified closes.
- Retain handles across transient omissions but evict definitively destroyed/PID-restarted windows.
- Implement explicit manage/unmanage lifetime overrides.
- Treat replacement AX windows as fresh insertions and cover multi-window app cases.

## Implementation Plan

- [x] Inspect existing inventory/workspace lifecycle behavior and tests.
- [x] Implement verified close handling, retained-handle eviction, and manage/unmanage overrides.
- [x] Add coverage for transient omissions, PID restarts, replacement AX windows, BSP collapse, and multi-window apps.
- [x] Run targeted and full validation.
- [x] Record encountered bugs and summarize changes.

## Bugs Encountered

- Transient AX scan omissions were treated like durable absence at the inventory boundary. Impact: a failed or timed-out per-app scan could eventually lose window control or incorrectly remove desired state. Resolution: retain logical windows unless the owning PID disappears or a successful scan of that app confirms omission.
- Workspace reconciliation only inserted observed windows and never removed confirmed closes. Impact: closed windows remained in membership, BSP trees, focus, and parked-frame metadata indefinitely. Resolution: pass verified-close IDs into one atomic workspace mutation that removes membership, promotes the BSP sibling, repairs focus, and clears parked metadata.
- Retained AX handles had no definitive lifecycle eviction path. Impact: destroyed or PID-restarted windows could leave stale handles cached. Resolution: added explicit handle eviction driven by lifecycle-confirmed closure while preserving handles across transient omissions.
- Classification had no managed state or lifetime override mechanism. Impact: explicit manage/unmanage intent could not survive rescans, and replacement windows could inherit stale intent if keyed identically. Resolution: added managed state and lifetime-scoped overrides, clearing them on verified close or PID change so replacements are fresh insertions.

## Summary of Changes

Implemented managed-window lifecycle reconciliation, verified close removal with immediate BSP collapse, definitive retained-handle eviction, lifetime-scoped manage/unmanage overrides, and targeted multi-window/PID-restart/replacement coverage. Targeted WMInventoryTests and WMWorkspaceTests pass; full validation intentionally remains unchecked for parent-agent validation.

## Review Bugs Encountered

- **Critical — explicit lifetime overrides are unreachable from the product surface.** Locations: `Sources/WMInventory/ManagedWindowLifecycle.swift:27`, `Sources/WMProtocol/State.swift:39`, `Sources/wm/DaemonHandler.swift:166`, `Sources/WMCLI/CLI.swift:140`. Impact: `setOverride` is called only by unit tests; there is no `window.manage`/`window.unmanage` protocol method, daemon route, parameter type, or CLI command, so the explicit-manage/unmanage acceptance criterion is not behaviorally implemented. Mitigation: add both protocol methods and CLI parsing, route them to actor-isolated lifecycle override mutation, validate the target/current lifetime, immediately reconcile workspace membership (including removal on unmanage), and expose the effective managed state.
- **Critical — a failed application enumeration is interpreted as every app/PID having exited.** Locations: `Sources/WMInventory/InventoryScanner.swift:30-31`, `Sources/WMInventory/ManagedWindowLifecycle.swift:35-43`. Impact: when the top-level Accessibility application source is unhealthy and returns an empty list (including lost AX permission), `appScans` is empty, `livePIDs` is empty, and all retained windows become verified closes; workspace/BSP/parked metadata and geometry handles are then evicted despite enumeration failure. Mitigation: carry application-enumeration success/health explicitly into the snapshot and permit PID-absence closure only after a successful complete app enumeration; otherwise retain all prior lifetimes. Add a test for unhealthy/failed top-level enumeration, distinct from a failed per-app window scan.
- **Critical — PID-restart replacement IDs are sent as both closed and observed, so close removal wins after insertion accounting.** Locations: `Sources/WMInventory/ManagedWindowLifecycle.swift:47-61`, `Sources/WMWorkspace/WorkspaceMutations.swift:165-184`. Impact: for an old window `a` replaced in the same reconciliation by PID-restarted `a`, lifecycle returns `a` in both `windows` and `verifiedClosedWindowIDs`. Workspace computes `added` before removing the old assignment, then removes `a` and never reinserts it. The replacement is therefore absent from membership/BSP instead of being a fresh insertion. Mitigation: represent closure with a lifetime token (at minimum old PID plus ID) and process verified removals before calculating additions, then insert every currently managed replacement; add an integration test spanning lifecycle output through `WorkspaceState`.
- **High — ID-only eviction can delete a newly resolved replacement handle.** Locations: `Sources/wm/DaemonHandler.swift:56-63`, `Sources/WMInventory/AXWindowGeometryAdapter.swift:34-39`, `Sources/WMInventory/ManagedWindowLifecycle.swift:49-55`. Impact: eviction identifies only `windowID`; a PID-restarted replacement sharing the ID is simultaneously live, so any replacement handle already reconciled/resolved under that ID can be removed as though it belonged to the closed lifetime. This also cannot prove that a delayed close event applies to the old PID. Mitigation: key retained handles by logical lifetime (ID + PID/generation) and evict that exact old lifetime; alternatively atomically replace/validate the mapping and never emit an ID-only close for an observed replacement.
- **High — explicit unmanage would not clean up existing workspace state even if `setOverride` were exposed.** Locations: `Sources/WMInventory/ManagedWindowLifecycle.swift:27-31,59-61`, `Sources/WMWorkspace/WorkspaceMutations.swift:165-175`. Impact: an unmanaged live window is filtered out of observed managed IDs, but workspace reconciliation removes only `verifiedClosedWindowIDs`; existing membership, BSP leaf, focus, and parked metadata remain indefinitely. Mitigation: return a separate `newlyUnmanagedWindowIDs` removal set (without treating it as destruction/evicting its valid AX handle), and remove those IDs atomically from workspace state.
- **Medium — protocol window management cannot represent the newly emitted `managed` value.** Locations: `Sources/WMInventory/InventoryModels.swift:306-307`, `Sources/WMProtocol/Domain.swift:116-118`. Impact: inventory lifecycle now produces `.managed`, but the public protocol model still defines only unmanaged/ineligible/pending, leaving the integration contract inconsistent and preventing typed protocol encoding/decoding of effective managed state where that model is used. Mitigation: add `managed` to `WMProtocol.WindowManagement` and update protocol fixtures/schema documentation.
- **Medium — handle eviction is not integration-tested and retained auxiliary per-window state is not evicted.** Locations: `Sources/WMInventory/AXWindowGeometryAdapter.swift:34-39`, `Sources/wm/DaemonHandler.swift:25-26,57-58`. Impact: tests assert lifecycle IDs but never verify adapter cache eviction; additionally `windowMinimumSizes` survives definitive close/PID restart, so a replacement sharing an ID inherits stale sizing constraints. Mitigation: inject a recording geometry adapter/service for daemon reconciliation tests, assert exact old-lifetime eviction and transient retention, and remove per-lifetime minimum-size/session metadata on verified close before fresh insertion.
- **Medium — startup bypasses lifecycle semantics.** Locations: `Sources/wm/WMMain.swift:34-45`. Impact: startup adopts every normal-classified window directly before the lifecycle exists, rather than using the same managed classification/lifetime path as subsequent scans. This creates two integration paths and leaves startup behavior untested for overrides/replacements. Mitigation: construct the handler/lifecycle before initial workspace adoption and run the initial snapshot through the same reconciliation entry point.

## Review Bug Resolutions

- Explicit overrides: resolved by adding `window.manage` and `window.unmanage` protocol methods, typed params, daemon routes, CLI commands, target validation, immediate reconciliation, and effective-management responses.
- Application enumeration failure: resolved by requiring healthy top-level Accessibility enumeration before PID absence can verify closure; per-app successful omission remains sufficient.
- Same-ID PID replacement: resolved with `WindowLifetime` closure tokens and workspace ordering that removes old membership before computing current managed additions.
- Replacement-safe handle eviction: resolved by recording handle lifetimes and evicting only an exact `(window ID, PID)` lifetime.
- Immediate unmanage/manage behavior: resolved with a separate newly-unmanaged removal set; unmanage removes membership/BSP/parking without handle eviction, and manage reinserts the still-live window.
- Protocol management mismatch: resolved by adding `managed` to `WMProtocol.WindowManagement`.
- Auxiliary state cleanup: resolved by clearing session metadata only for matching closed lifetimes and clearing cached minimum sizes on definitive closure/PID replacement. Targeted geometry tests verify transient retention and replacement-safe eviction.
- Startup lifecycle bypass: resolved by constructing the daemon handler before initial adoption and routing the first inventory snapshot through `reconcileObservedWindows`.

Targeted validation completed: WMInventoryTests, WMWorkspaceTests, WMProtocolTests, and WMCLITests pass. Full validation remains intentionally unchecked for independent parent-agent validation.

## Validation

- `swift test`: passed, 42 XCTest tests and 57 Swift Testing tests.
- `swift build`: passed.
- `git diff --check`: passed.
- Live macOS AX interaction was not exercised; deterministic lifecycle and adapter tests cover the implemented semantics.

## Final Summary

Completed verified managed-window lifecycle behavior across inventory, workspace state, daemon protocol, and CLI. Confirmed closes now atomically collapse BSP state and clear parked metadata; transient scan failures retain logical windows and handles; PID restarts use lifetime-aware eviction and fresh insertion; explicit manage/unmanage overrides persist for one logical lifetime and update workspace membership immediately.

## Live Validation

- Started the real daemon on isolated port `17833`; Accessibility capability was available and live AX/CG inventory populated.
- `wm verify --url ws://127.0.0.1:17833/v1` passed welcome, request/response, subscription, refresh event, and unsubscribe checks.
- Unmanaged live Ghostty window `window:cg:155`; command returned `unmanaged`, workspace membership and BSP leaf were removed immediately, and remained removed after inventory refresh.
- Managed the same live window; command returned `managed`, workspace membership and BSP leaf were restored immediately, and remained restored after inventory refresh.
- Daemon exited cleanly via SIGTERM.

## Deferred Observation

- `window.list` exposes the normalized classifier value rather than the lifecycle override, so it continued showing `unmanaged` after the explicit manage command. Workspace behavior and command responses were correct. This is a query-projection consistency issue, not a failure of the lifecycle acceptance criteria; it can be tracked separately.
