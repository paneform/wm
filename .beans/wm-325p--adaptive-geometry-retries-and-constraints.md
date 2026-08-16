---
# wm-325p
title: Adaptive geometry retries and constraints
status: completed
type: feature
priority: high
created_at: 2026-08-15T21:46:03Z
updated_at: 2026-08-15T21:55:24Z
---

Implement adaptive geometry retries that distinguish exact success, stable constrained success, and unstable failure. Every tile/move/workspace focus should attempt ideal geometry, accept known stable app constraints promptly, retry higher/new clamps, and learn required retry counts. Support configurable max retries and learning modes: store/reuse, infer every request, and optimistic ideal-first with learned fallback.

## Plan

- [x] Define exact, constrained-stable, progressing, and failed geometry outcomes.
- [x] Learn consistent constraints and required corrective retry counts without false transient minima.
- [x] Apply configured retry/reuse mode to every geometry request.
- [x] Add focused engine and persistence tests.
- [x] Integrate policy retiling and run full automated validation (live AX validation deferred).

## Validation Notes

- WMInventoryTests target builds successfully.
- Focused test execution is currently blocked by concurrent protocol work: DaemonHandler.swift has a non-exhaustive RequestMethod switch missing geometryPolicySet.
- Full/live validation and user-facing policy wiring remain integration work.

## Integration Review Follow-up

- [x] Preserve maximum escalation budget in all modes.
- [x] Isolate infer-every-request from profile lookup and persistence.
- [x] Make optimistic mode ideal-first with learned fallback ordering.
- [x] Learn repeated unknown stable clamps without accepting them as constrained success.
- [x] Verify focused engine and persistence tests.

## Integration Review Summary

All modes retain the configured maximum attempt budget. Store/reuse uses learned corrective count only to select the stronger corrective transaction; optimistic performs one ideal transaction before learned corrective fallback; infer-every-request performs no profile lookup, classification reuse, recording, or persistence. Unknown stable clamps remain failed outcomes but can promote a minimum after three matching samples. Only exact and accepted promoted constraints update successful samples and corrective attempt count. Progressing or hybrid transitions do not promote minima.

Focused validation passed: WindowGeometryTests (23), WindowGeometryProfileTests (5), and WindowGeometryProfileStoreTests (2).

## Summary of Changes

Integrated request-scoped adaptive retry policies into daemon tile, move, focus, and observer geometry paths. Exact outcomes continue, accepted stable constraints update only excess dimensions and trigger one bounded full-workspace replan, and unstable outcomes fail strict placement while retaining useful observed constraints. Store, infer, and optimistic modes now preserve the configured escalation budget with correct profile isolation and fallback ordering. Durable profile learning excludes progressing and hybrid transitions. Fixed replan rollback to record each moved window once so failure restores the original frame.

Full validation passed: `swift test` (67 XCTest and 148 Swift Testing cases), `swift build`, and `git diff --check`. Live AX validation was intentionally deferred because it mutates the active desktop; Zen sequence optimization remains tracked by `wm-cndm`.
