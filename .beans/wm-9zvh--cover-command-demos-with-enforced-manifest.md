---
# wm-9zvh
title: Cover command demos with enforced manifest
status: completed
type: feature
priority: normal
created_at: 2026-09-29T23:21:05Z
updated_at: 2026-09-29T23:45:50Z
---

Add minimal scenario-backed examples for the command catalog and an exhaustive command-ID typed manifest, using reference move situations as the baseline.

## Plan

- [x] Inventory supported commands and define exhaustive typed scenario coverage and explicit host-only exceptions.
- [x] Author minimal scenario files with preparation/playback expectations and connect docs rendering to the manifest.
- [x] Verify compile-time rejection, command/file linkage, orphan detection, and all scenario expectations.
- [x] Format and run site/layout-browser tests, lint, typechecks, and production builds; document authoring.

## Implementation findings

The manage/unmanage scenarios exposed an existing engine bug: `unmanageWindow` leaves a tombstone and reconciliation immediately restores membership. `restore-membership.ts` did not honor the unmanaged override; `rule.ts` also omitted it when filtering automatic assignment. Both now respect that override, and the new manage/unmanage scenarios are regression tests.

The probe requires durable parked intent. Its scenario switches away from Editor before probing and verifies restoration of the parked frame. Service start/restart use the default workspace 1, matching fresh engine startup semantics. Native install/status/uninstall and diagnostics have explicit exceptions rather than simulated native output.

## Coverage checks

35 registered scenario files pass all expectations. Runtime tests verify every catalog form has a coverage decision, each scenario matches its registered command identity, and there are no missing/duplicate/orphan files. A dedicated TypeScript check exercises five negative contracts using expect-error, and runs as part of site typecheck. The shared service action union and local CLI command type supply the manifest keys; JSON inventory filenames remain literal types.

## Summary of Changes

Added 30 minimal JSON scenarios to the five existing reference examples (35 total) and connected every simulator-supported CLI command to an exhaustive engine-ID manifest. Matched the shared-edge example to the reference layout, added the explicit-ID workspace move as a separate situation, and recorded seven explicit native/transport exceptions. Static file imports enforce literal file IDs; page joins derive from the implementation command catalog. Demos now show their concrete command, starting/result caption, manager state, floating treatment, and both displays for display-move commands. Added scenario authoring instructions and a dedicated negative TypeScript check integrated into site typecheck. Fixed unmanaged-override handling uncovered by the new scenarios.

## Validation

- All 35 scenarios pass every preparation/playback expect clause; 44 docs tests also cover coverage, command linkage, orphan detection, and exceptions.
- Dedicated manifest typecheck passed with five invalid contract fixtures required to produce compiler errors.
- Full tests passed: site 261, layout 435, layout-browser 150.
- Lint, supported typechecks and production builds passed for all three packages.
- Chrome checks and screenshot review passed for directional move, focused/explicit workspace moves, two-display movement and floating.
- git diff --check passed.
