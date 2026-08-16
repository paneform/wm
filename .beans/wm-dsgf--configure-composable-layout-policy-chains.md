---
# wm-dsgf
title: Configure composable layout policy chains
status: completed
type: feature
priority: high
created_at: 2026-08-16T17:58:38Z
updated_at: 2026-08-16T18:10:31Z
---

Replace the single uncooperative-window policy with ordered workspace/default layout_policy chains. Policies remain independent primitives; orchestration tries configured entries in order and reports fallback degradation.

## Required config

`layout_policy` is an ordered array containing any composable subset of `greedy`, `overlap`, `stack`, `overflow`, and terminal `reject`. Defaults: greedy, overlap, stack, overflow. Omitting overlap means greedy may fall directly to stack.

## Plan

- [x] Model and validate ordered layout policy chains across config, workspace state, persistence, and protocol DTOs.
- [x] Implement independently callable policy primitives and orchestration result metadata.
- [x] Wire runtime overrides, daemon health/events/diagnostics, and fallback recovery.
- [x] Update schema, generated example/init config, docs, and broad tests.
- [x] Run focused suites and full/live validation where available.

## Acceptance

- [x] Keep every policy independently executable and testable.
- [x] Add overflow as an independent primitive retaining tile origins/allocations without clamping or shrinking peers.
- [x] Add ordered fallback orchestration from config defaults/workspace overrides.
- [x] Return requested chain, attempted chain, effective policy, frames/rejection, and fallback state.
- [x] Reject invalid/empty/duplicate chains and enforce reject as terminal if present.
- [x] Report unhealthy fallback such as `greedy->overlap->stack` and recover when fallback clears.
- [x] Update default config example/init, docs, protocol/CLI/runtime tests; live config remains for manual validation.
- [x] Run full and live validation.

## Summary of Changes

Implemented ordered `layout_policy` chains throughout configuration, persisted workspace state, protocol DTOs, CLI/runtime overrides, layout orchestration, diagnostics, and health. Added independent overflow behavior that preserves BSP origins and peer allocations while extending constrained dimensions off-workspace. Removed the singular policy API without compatibility aliases; versioned/build-gated persisted snapshots already quarantine incompatible state. Added validation and broad config, protocol, CLI, workspace, persistence, and daemon coverage.

Validation completed: `swift test --filter WMWorkspaceTests`, `swift test --filter WMConfigurationTests`, `swift test --filter WMCLITests`, `swift test --filter WMDaemonTests`, full `swift test` (160 Swift Testing + 70 XCTest tests), `swift build`, and `git diff --check`. Live daemon/configuration and workspace move/focus validation completed.

## Validation

Full `swift test` passed (160 Swift Testing and 70 XCTest cases), `swift build` passed, and `git diff --check` passed. The rebuilt daemon accepted the migrated live config and correctly applied workspace moves/focus with the configured chain. A live Spotify/System Settings pairing remained a valid greedy plan under the currently learned constraints, so fallback behavior is covered deterministically by tests rather than that particular live profile.

## Validation Correction

Reopened because the final rebuilt binary had not been restarted before completion. Live validation must run against the final daemon process.

## Final Live Validation

Gracefully stopped PID 19925 and started the final `.build/debug/wm daemon` as PID 68336 at 2026-08-16 11:10:08 local time. `configuration validate` passed. Live workspace observations exposed `layout_policy` and layout result metadata from the new daemon. A reversible runtime update changed workspace C to `stack,overflow`, observation confirmed it, then restored `greedy,overlap,stack,overflow` and observation confirmed restoration. Global health remains degraded only by unrelated AX scan failures.
