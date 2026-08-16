---
# wm-mfn2
title: Configure adaptive window handling
status: completed
type: feature
priority: high
created_at: 2026-08-15T21:46:10Z
updated_at: 2026-08-15T21:53:43Z
---

Add configuration, runtime commands, and policy integration for adaptive uncooperative-window handling. Options include max retries (default 5) and profile mode: store/reuse learned constraints and retry policy, infer on every request, or optimistic ideal-first then learned fallback. After constrained stable placement, re-plan peers using greedy/stack/overlap/reject policy.

## Plan

- [x] Add config model/defaults/schema/example/docs.
- [x] Add global and per-workspace runtime commands and protocol methods.
- [x] Re-plan tile/move/focus around accepted stable constraints.
- [x] Add deterministic policy, parser, daemon, and configuration tests.
- [x] Integrate adaptive engine and run focused validation (live AX deferred).

## Implementation Notes

Canonical configuration/wire keys: `max_geometry_retries` and `geometry_profile_mode`. Modes: `store`, `infer`, and `optimistic`. Runtime method: `geometry_policy.set`; CLI: `geometry-policy [WORKSPACE] --max-retries N --profile-mode MODE`.

Engine/profile files are concurrently modified; integration will use their public recorder/profile APIs and avoid reverting those edits.

## Progress

- Added global defaults and inherited per-workspace overrides for `max_geometry_retries` (default 5) and `geometry_profile_mode` (`store`, `infer`, `optimistic`).
- Added `geometry_policy.set` and CLI global/per-workspace commands.
- Wired configured/runtime retry counts into daemon tiling, move, and focus reconciliation; learned constraints feed workspace replanning under the existing uncooperative policy.
- Added deterministic config, protocol, CLI, and daemon tests.

## Validation

- `swift test --filter WMConfigurationTests` passed (22 tests).
- `swift test --filter WMProtocolTests` passed (12 tests across XCTest/Testing output).
- `swift test --filter WMCLITests` passed (33 tests).
- `swift test --filter WMDaemonTests` passed except the newly added receipt assertion was corrected; `swift test --filter geometryPolicyRuntimeUpdatesGlobalAndWorkspaceSettings` then passed.
- `git diff --check` passed.

## Integration Gap

The concurrent geometry engine currently exposes profile lookup/recording but no request-scoped mode switch. `infer` therefore ignores stored profiles during layout planning, and `optimistic` follows ideal-first placement, but persistence suppression and profile-derived retry-strategy ordering still require an engine API from the concurrent agent. Live AX validation was not run.

## Continuation Plan

- [x] Translate resolved daemon policy to request-scoped `WindowGeometryRetryPolicy`.
- [x] Replace recursive/fallback tiling with bounded classification-driven planning shared by strict and observer paths.
- [x] Add deterministic policy translation and constrained-replan coverage.
- [x] Run focused inventory, workspace, daemon, protocol, and CLI tests.

## Continuation Summary

Daemon tiling now calls `WindowGeometryService.setGeometry` with request-scoped retry policy. `exact` continues; `constrained` records only dimensions exceeding the requested tile and permits one deterministic full-workspace replan; `progressing` and `failed` preserve observed excess and fail strict placement without a compatibility wrapper. Observer placement uses the same shared bounded tiler. Move and workspace-focus paths already converge through this function.

Policy translation maps `store` to `storeAndReuse`, `infer` to `inferEveryRequest`, and `optimistic` to `optimisticIdealFirst`. Added a deterministic daemon translation test. Existing layout tests cover peer frame changes from learned minimums; direct daemon engine injection is not currently available.

Focused daemon tests passed (38), workspace tests passed (25), and `git diff --check` passed. Focused engine semantic tests currently crash in concurrent `WindowGeometryTests.swift` force unwraps because no profile is present at lines 89, 111, 125, and 149; this is outside the daemon integration edits and remains an engine-test blocker. Live AX validation remains deferred.

## Summary of Changes

Implemented config, schema, JSONC documentation, protocol/API, CLI, runtime overlays, persisted workspace settings, request-scoped adaptive engine policy, and bounded classification-driven workspace replanning for tile/move/focus and observer paths. Focused daemon/workspace/config/protocol/CLI validation passes; concurrent engine tests have documented profile force-unwrap failures.
