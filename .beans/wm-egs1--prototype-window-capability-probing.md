---
# wm-egs1
title: Prototype window capability probing
status: completed
type: feature
priority: high
created_at: 2026-08-20T17:17:27Z
updated_at: 2026-08-20T19:15:52Z
---

Add generic per-window position/size capability metadata with reported and behaviorally confirmed evidence, project macOS AX settability into reported evidence, and prototype bounded geometry probes that restore the original frame. Expose the prototype through debug/observation tooling and test it against representative live windows without changing workspace admission policy.

## Plan

- [x] Define generic capability evidence and source metadata
- [x] Project AXPosition/AXSize settability into inventory and protocol models
- [x] Implement bounded move/resize probes with restoration and identity cancellation
- [x] Expose a debug probe command and structured results
- [x] Add unit and protocol regression coverage
- [x] Run focused and full validation
- [x] Probe representative live windows and record findings

## Exploration Notes

- Generic model path: `Sources/WMInventory/InventoryModels.swift` (`RawAXWindow`, `NormalizedWindow`) -> `WindowNormalizer.makeWindow` -> inventory/state JSON. Mirror protocol DTOs in `Sources/WMProtocol/Domain.swift` if typed consumers are retained.
- AX projection point: `Sources/WMInventory/SystemInventorySources.swift:readWindow`; query `AXUIElementIsAttributeSettable` separately for `kAXPositionAttribute` and `kAXSizeAttribute`, preserving unknown/error rather than collapsing to false. Existing private implementation is in `AXWindowGeometryAdapter.isSettable`.
- Geometry probe seam: extend `WindowGeometryAdapter`/`WindowGeometryEffects` in `Sources/WMInventory/WindowGeometry.swift`; use resolve/read/write-or-transact/settle, with unconditional best-effort restoration and final read verification. Inject raw geometry into `DaemonHandler` rather than retaining the hard-coded private adapter for daemon tests.
- API/CLI path: method in `Sources/WMProtocol/State.swift`, typed params/results in `WindowGeometry.swift`, switch in `Sources/wm/DaemonHandler.swift`, method classification extension at file end, parser/help in `Sources/WMCLI/CLI.swift` and `Help.swift`.
- Tests: inventory normalization/source stubs in `Tests/WMInventoryTests/InventoryTests.swift`; actor fake adapters in `WindowGeometryTests.swift`; protocol wire tests in `WMProtocolTests/WindowGeometryProtocolTests.swift`; CLI parser/runner tests; daemon request helpers and `DirectionalGeometry` in `WMDaemonTests/DaemonLifecycleTests.swift`.
- Critical pitfalls: AXMovable/AXResizable differ from attribute settability and neither proves behavioral cooperation; independently probe position and size; avoid `WindowGeometryService.setGeometry` for probing if it records profiles; serialize against automatic geometry/reconciliation; check logical identity before every write/restore; account for asynchronous animation/clamping; report restoration status distinctly and never mutate inventory to the probe frame.

## Summary of Changes

- Added generic position/size capability metadata with separate reported and confirmed states plus generic evidence sources.
- Projected AXPosition and AXSize settability independently without affecting inventory health on query failure.
- Added a dedicated bounded behavioral probe, restoration verification, generic protocol endpoint, and debug AX CLI command.
- Added protocol, inventory, geometry, CLI, and injected daemon coverage.
- Validation: WindowGeometryTests (30 passed), CLI parser tests (22 passed), WindowGeometryProtocolTests (3 passed), focused inventory metadata test (1 passed), swift build passed, and git diff --check passed.
- Full swift test: all XCTest suites passed (90 tests); the parallel Swift Testing phase later crashed with the known allocator failure: Fatal error: failed to allocate 5914614169289621576 bytes of memory with alignment 8.
- Live probing was not run because it requires coordination with the parent/session owner; that checklist item remains open.

## Hardening Review

- [x] Serialize probe through mutation lifecycle and test pause coordination
- [x] Restore and rethrow cancellation
- [x] Revalidate logical identity before every probe operation
- [x] Stop after intermediate restoration failure
- [x] Make no-change and cross-component outcomes conservative
- [x] Add complete old/new wire compatibility coverage
- [x] Reduce formatting-only diff
- [x] Run focused validation and build

## Hardening Summary

- Reconstructed missing generic capability/probe DTOs with tolerant decoding and distinct reported/confirmed evidence.
- Added independent AXPosition/AXSize settability projection while keeping AXMovable/AXResizable and inventory eligibility unchanged.
- Hardened bounded probes for component-specific classification, identity validation, cancellation restoration, and immediate stop after reset failure.
- Serialized geometry.capability.probe through the existing transaction coordinator and retained explicit paused behavior.
- Added inventory projection/unknown, old/new wire, CLI, probe, cancellation, identity, restoration, and paused endpoint coverage.
- Validation on 2026-08-20: WindowGeometryTests 34 passed; InventoryTests focused command 71 XCTest plus 2 Swift Testing passed; WindowGeometryProtocolTests 3 passed; CLI parser 22 passed; geometryProbeIsBlockedWhilePaused 1 passed; swift build passed; git diff --check passed; full swift test passed with 95 XCTest plus all Swift Testing suites and no allocator crash.
- No live probe was run. The live probing checklist remains unchecked, and this bean remains in-progress.


## Live Probe Findings

- AutoFillPanelService `window:cg:3819`: position supported in all four directions; all four resize attempts rejected; size confirmed fixed; restoration verified.
- Docker Desktop `window:cg:4261`: position and size supported in all eight directions; restoration verified.
- Persisted AutoFill capability survived daemon restart and was applied as floating workspace membership outside BSP.
