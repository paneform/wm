---
# wm-0otw
title: Nest initial window assignments under workspaces
status: completed
type: feature
priority: high
created_at: 2026-08-16T06:34:52Z
updated_at: 2026-08-16T06:42:07Z
---

Refactor configuration so each workspace owns its initial window matchers instead of using top-level rules. Preserve app/name/executable matching and exact/contains/regex semantics, apply only when wm adopts a new window or recovers startup state, and keep later manual workspace moves authoritative.\n\n## Plan\n\n- [x] Map the existing schema, matcher, startup recovery, hotload, and new-window paths.\n- [x] Replace top-level rules with per-workspace initial assignment matchers and validation.\n- [x] Update runtime assignment behavior without reapplying matches to manually moved windows.\n- [x] Update examples, documentation, and tests.\n- [x] Run focused and full validation.

## Findings

- Top-level rules carry actions that runtime code does not generally apply; only workspace assignment is consumed during invalid-state recovery.
- Ordinary newly managed windows currently bypass configuration and are reconciled directly into workspace `1`.
- Workspace membership is persisted, and reconciliation only assigns unassigned IDs, so applying matchers only to newly added windows naturally preserves later manual moves.
- Workspace array order can provide deterministic first-match precedence when matchers overlap.

## Implementation Notes

- Removed top-level rules and added ordered per-workspace initial_assignment matchers.
- Applied initial assignment only to unassigned/new windows and invalid-state startup recovery.
- Made config adoption promote adopted workspaces so exact executable assignments beat overlapping compound matchers while preserving unrelated matchers.
- Added configuration, workspace, CLI, startup recovery, and daemon new-window/manual-move coverage.

## Focused Validation

- swift test --filter WMConfigurationTests
- swift test --filter WMWorkspaceTests
- swift test --filter newWindowUsesInitialAssignmentWithoutReassigningManuallyMovedWindow
- swift test --filter invalidPersistedStateIsQuarantinedAndRecoversByInitialAssignmentThenFallback
- swift test --filter WMCLITests
- git diff --check

Full validation intentionally remains unchecked for the user.

## Summary of Changes

Replaced top-level rules with ordered per-workspace `initial_assignment` matchers. New and recovery-adopted windows use the first matching workspace, unmatched windows use `1`, and persisted/manual membership remains authoritative. Updated config adoption, generated examples, documentation, unit/integration coverage, and the live config at `~/.config/wm/config.jsonc`.

## Final Validation

- `swift test`: 69 XCTest and 151 Swift Testing cases passed.
- `swift build` passed.
- `wm config validate` passed against the migrated live config.
- Generated `wm config example` parses and documents `initial_assignment`.
- Final daemon relaunch reported ready and retained Spotify on `1`, Messages/Discord on `M`, Zen on `B`, and Ghostty on `T`.
