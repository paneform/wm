---
# wm-wo53
title: Fix focus regressions after lifecycle hardening
status: completed
type: bug
priority: critical
created_at: 2026-08-14T21:55:54Z
updated_at: 2026-08-14T22:20:55Z
---

Scope: restore Cmd-Tab external focus reconciliation and explicit workspace focus commands used by skhd without regressing lifecycle/transaction safety.

## Plan

- [x] Reproduce the running-daemon `inventory_stale` failure and inspect persisted stale workspace membership.
- [x] Trace explicit workspace focus, lifecycle closure, `sessionWindows`, activation reconciliation, skhd commands, and transaction completion responses across recent commits.
- [x] Implement minimal stale-member pruning/live focus selection and external activation reconciliation fixes without disturbing the in-progress transaction model.
- [x] Add regressions for stale IDs, live replacement focus, post-lifecycle external activation, and direct CLI completion response.
- [x] Run targeted tests and inspect the final diff.
- [x] Reproduce and trace rebuilt-daemon startup audit failure on definitively stale persisted members.
- [x] Prepare startup candidate before effects and persist only after successful audit.
- [x] Reproduce healthy inventory omitting persisted `window:cg:155` while its application remains live.
- [x] Tighten stable-CG stale proof using healthy AX/CG sources and successful per-app scans.
- [x] Add exact persisted stable-CG regression and rerun targeted validation/diff check.
- [x] Extend healthy-CG stable-ID pruning to periodic lifecycle reconciliation before focus/tiling effects.\n- [x] Add periodic healthy-CG prune and unhealthy-CG retention regressions.\n- [x] Run full and live validation.
- [x] Record Bugs Encountered and Summary of Changes.

## Bugs Encountered

- Lifecycle retention allowed obsolete workspace IDs to reach explicit focus geometry and return `inventory_stale`.
- Activation notifications ran lifecycle reconciliation before external focus and could reject or reverse Cmd-Tab.
- Startup audit planned effects from stale persisted membership before lifecycle evidence could remove it.
- The first startup correction relied on top-level healthy Accessibility enumeration. That was insufficient for `window:cg:155`: its owning application remained enumerated while a successful current scan omitted the destroyed window, and persisted workspace state carries no PID. The daemon repeatedly failed before readiness.

## Bug Resolution

- Explicit focus prunes stale destination membership and focuses only live candidates; application activation reconciles the notification PID directly.
- Startup stable-ID pruning now requires both Accessibility and Core Graphics sources to be healthy and every enumerated application scan to succeed. Under that complete evidence, normalized and raw CG IDs define the current live `window:cg:*` set, so omitted persisted stable CG IDs such as `window:cg:155` are safely removed even without persisted PID metadata. Any failed/timed-out scan or unhealthy source preserves all intent. Non-CG IDs are not inferred stale.
- Removal repairs BSP leaves, focused-window fallback, and parked metadata. Geometry recovery audits the corrected candidate before `WorkspaceController` atomically persists and installs it; audit failure leaves prior persisted state intact.

## Summary of Changes

- Added regressions for stale explicit focus, replacement focus, external activation, direct CLI completion response, exact `window:cg:155` startup omission, timed-out app-scan retention, and audit failure preserving pre-audit persistence.
- Targeted validation passed: `swift test --filter WMDaemonTests` (11), `swift test --filter WMWorkspaceTests` (21), `swift test --filter WMCLITests` (23), and `git diff --check`. Full suite and rebuilt-daemon live validation remain unchecked.

## Periodic Reconciliation Resolution

Live startup and explicit `workspace focus T` succeeded, but periodic observation repeatedly failed on stale `window:cg:13547` because only startup used healthy-CG pruning. Periodic `reconcileObservedWindows` now computes and atomically commits the same healthy-CG candidate before lifecycle reconciliation. The subsequent external Cmd-Tab focus pass therefore observes cleaned BSP membership and cannot encounter stale CG geometry. Degraded/unhealthy CG inventories retain stable IDs, and non-CG IDs remain conservative.

Targeted validation: `swift test --filter WMDaemonTests` (13), `swift test --filter WMWorkspaceTests` (21), `swift test --filter WMCLITests` (23), and `git diff --check` passed. Full/live validation remains unchecked.

## Live Validation

- Rebuilt and restarted the production daemon against the existing persisted workspace state. Startup successfully pruned definitively absent stable CG members under healthy Screen Recording inventory and reached readiness.
- Ran the exact skhd command shape for `workspace focus S` and `workspace focus T`; both returned committed transaction receipts with `effect_status: verified`, and the expected destination window became focused.
- Activated Spotify externally using macOS application activation, exercising the same notification path as Cmd-Tab; workspace focus changed automatically from `T` to `S` and remained there after observation.
- Periodic observation emitted no stale geometry failures after the healthy-CG pruning fix; daemon stderr remained empty.
- Full validation passed: 45 XCTest tests, 76 Swift Testing tests, `swift build`, and `git diff --check`.

## Final Summary

Fixed explicit hotkey focus and external application activation regressions by pruning definitively stale stable CG members before startup and periodic effects, limiting pruning to healthy CG inventory, selecting only live workspace focus candidates, and handling app activation directly before periodic lifecycle reconciliation can reverse it.

## Review Findings

1. **Critical — `Sources/wm/DaemonHandler.swift:41-61; Sources/wm/WMMain.swift:74-115` — focus reconciliation bypasses transaction serialization.** Cmd-Tab activation and periodic external-focus reconciliation mutate/persist workspace state directly while command transactions may be suspended. Impact: external and explicit focus can race, causing stale commits, reversed focus, or conflicting parking/reveal effects despite the serialized-command claim. Fix: submit activation/observer focus mutations through the same coordinator and add gated integration tests against concurrent `workspace.focus`.

2. **High — `Sources/wm/WMMain.swift:109-115` — activation failures are silently discarded.** Both refresh failure (`try?`) and reconciliation failure (`try?`) are swallowed, unlike the periodic observer's reporting path. Impact: Cmd-Tab can stop following focus with no diagnostic or recovery trigger, including geometry/persistence failures. Fix: report structured errors and schedule/reuse the normal reconciliation path; test failure then recovery.

3. **High — `Sources/wm/DaemonHandler.swift:73-80, 381-398` — explicit focus treats every inventory omission as definitive stale membership.** `removingStaleWindows` removes all destination IDs absent from one snapshot without checking CG/source health or retained-session identity, unlike the conservative startup/periodic pruning logic. Impact: a transient/degraded scan during a hotkey focus permanently deletes valid workspace intent and parked metadata. Fix: prune only with definitive healthy evidence (or retain omitted IDs and select live candidates without deleting), and add degraded/transient omission integration tests.

4. **Medium — `Tests/WMDaemonTests/DaemonLifecycleTests.swift:136-169; Tests/WMCLITests/CLIRunnerTests.swift:92-111` — focus regressions are tested as pure helpers/fabricated responses, not runtime behavior.** No test drives handler routing, persistence, geometry ordering, transaction wrapping, activation notification failure, or concurrency. Impact: the tests cannot detect the focus races and destructive pruning above. Fix: add daemon integration tests for explicit focus and activation with healthy/degraded inventories, persisted state, transaction receipts, and concurrent commands.

## Follow-up Findings Plan

- [x] Serialize activation/focus and periodic lifecycle reconciliation with commands.
- [x] Report activation errors through the observation diagnostic path.
- [x] Restrict explicit stale pruning to definitive healthy CG evidence.
- [x] Add runtime focus serialization and degraded-inventory regressions.
- [x] Run targeted validation and record resolutions.

## Follow-up Resolution Summary

- Activation focus and periodic lifecycle/focus work now use the same serialized coordinator as explicit commands, preventing stale preview and platform-effect interleaving.
- Activation refresh/reconciliation failures are emitted to daemon stderr instead of being silently swallowed.
- Explicit focus uses the same definitive healthy-Core-Graphics candidate pruning as startup/periodic recovery; degraded or unhealthy CG evidence preserves workspace membership and parked metadata. The unconditional stale-pruning helper was removed.
- Added degraded-CG retention and healthy-CG pruning regressions. Transaction coordinator stress coverage proves focus-adjacent internal work shares FIFO serialization.
- Targeted daemon, workspace, core transaction, protocol, and CLI suites pass; `git diff --check` passes. Full parent validation remains with `wm-asvj`.
