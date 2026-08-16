---
# wm-z0gm
title: Implement topology recovery
status: in-progress
type: feature
priority: high
created_at: 2026-08-14T18:58:47Z
updated_at: 2026-08-15T21:01:56Z
---

Scope: display topology epochs, stable snapshots, work areas, and workspace migration.

Acceptance:
- Normalize display identity and expose ambiguity diagnostics.
- Apply global/per-display work-area margins.
- Pause writes until topology stabilizes.
- Migrate workspaces intact on disconnect and restore arrangement on reconnect.
- Handle resolution, scale, rotation, position, menu/Dock, Stage Manager, clamshell, and affinity changes.
- Verify every affected layout and add deterministic topology/migration tests.


## Plan

- [x] Audit current display identity, geometry, workspace assignment, and observation paths.
- [x] Add stable topology snapshots, work-area normalization, and migration/reconnection behavior.
- [x] Integrate topology stabilization with daemon writes and layout reconciliation.
- [x] Add deterministic topology and migration tests.
- [x] Run focused and full validation.


## Progress

Implemented the topology foundation, canonical AX coordinate conversion, fail-closed display stabilization, and disconnect/reconnect workspace migration. Full automated validation passes. Stable hardware identity ambiguity diagnostics, configurable work-area margins, and live topology acceptance remain before this bean can be completed.


## CLI Selector Plan

- [x] Rename `workspace move-display` to `workspace move` and accept display selector flags.
- [x] Resolve canonical ID, Core Graphics ID, NSScreen number, and display name with ambiguity errors.
- [x] Make `display list` concise by default and retain full output behind `--verbose`.
- [x] Update help, docs, and parser/daemon tests.
- [x] Run focused and full validation.


## Next Display Plan

- [x] Add `workspace move next [NAME]` with focused-workspace default and deterministic wraparound.
- [x] Verify configured preferred display affinities resolve through all selector forms.
- [x] Add parser, daemon, workspace, and configuration tests.
- [x] Validate moves and geometry against the two connected displays when safe.
- [x] Run full validation.


## Live Validation

On the connected Built-in Retina Display and DELL C3422WE, `workspace move next T` moved and verified the tiled window at the Dell AX work area `(-1030, -1440, 3440, 1440)`. The wrap move was safely rejected because the application clamped the requested built-in `1512x950` frame to `2434x974`; workspace state remained assigned to Dell, and the window was restored and verified at the Dell work area. This exposes an existing resistant/minimum-size window policy gap rather than a selector or cycling failure.


## Per-Display Layout Plan

- [x] Add selector-based display configuration with margin and gap overrides.
- [x] Apply display overrides after workspace/default settings for the workspace current display.
- [x] Validate duplicate/ambiguous selectors and measurements.
- [x] Update config example, schema/docs, and tests.
- [x] Run focused and full validation.


## Per-Display Layout Summary

Added selector-based `displays` config entries for margin and gap. Precedence is defaults, workspace settings, then current-display overrides. Cross-display workspace movement recalculates every BSP window from the destination work area, verifies each native frame before committing, and snapshots live pre-move geometry for full rollback on failure. Added destination-bound multi-window tests and validation for duplicate selectors and invalid measurements. Full validation passes with 136 tests and both geometry verifiers.


## Live Cross-Display Debug Plan

- [x] Add left-shift + right-shift + Tab skhd binding for `wm workspace move next`.
- [x] Capture live display, workspace, config, minimum-size, and window geometry state.
- [x] Reproduce Dell-to-built-in move and identify why frames exceed destination constraints.
- [x] Fix destination fitting/verification and rollback behavior with regression tests.
- [x] Revalidate live movement and run the full suite.


## Live Cross-Display Debug Summary

Added the skhd binding and reloaded skhd. Root cause: directly resizing Ghostty from the Dell `3440x1440` frame to built-in `1512x950` triggered an intermediate macOS cross-display clamp at `2434x974`; it was not a true minimum because a staged smaller resize succeeded. Geometry fitting now stages through a 75% destination frame, expands to the final configured target, and verifies containment. Move rollback now snapshots actual live frames before writes. Live built-in -> Dell -> built-in cycling verified exact frames `(-1030,-1440,3440,1440)` and `(0,32,1512,950)`. Full validation passes with 136 tests and both geometry verifiers.


## Occupied Display Move Plan

- [ ] Capture and reproduce T/B moves onto the occupied Dell display.
- [ ] Identify visibility, parking, focus, or geometry transaction failure.
- [ ] Fix occupied-display workspace movement while preserving global uniqueness and focus invariants.
- [ ] Add deterministic multi-workspace/multi-display state and geometry regressions.
- [ ] Revalidate the live sequence and full suite.

## Occupied Display Investigation\n\nLive revalidation showed that repeated geometry strategies, shrinking on the source display, moving a bounded staging frame first, and reversing incoming/outgoing transaction order all still leave Zen constrained to built-in height 950 when expanding on the occupied Dell display. The next experiment focuses the incoming window after staging it on Dell and before final expansion. Validation is currently blocked by an unrelated concurrent edit in Sources/WMConfiguration/Configuration.swift: exampleText declares displayEntries and then has a multiline string without return, causing a compile error.\n

## Occupied Display Progress\n\nRoot cause was twofold: the BSP path only attempted fit for oversized frames, so smaller app-constrained frames never reached bounded fitting; and macOS clamps off-screen parking coordinates, leaving large windows partially visible. Geometry fit now tries native zoom plus best-effort staged/progressive writes and accepts only final frames contained within the destination tolerance. BSP invokes fit for every verified frame mismatch and records bounded observed constraints. Occupied move B onto Dell committed successfully with B visible and T hidden, and reverse focus restored T. Coordinate parking acceptance now correctly detects partial overlap. Daemon workspace hiding now preserves outgoing frames and relies on raising/focusing the incoming window for occlusion instead of moving windows to unreliable off-screen coordinates.\n\nFocused geometry, parking, and daemon tests pass; build and diff checks pass. Remaining live issue: the current Dell top margin is 32 while Ghostty retains a 1440-point frame at y=-1408, exceeding the 1408-point configured content height by 32. Strict geometry verification correctly rejects focusing T under that configuration; resolve the margin/application chrome policy before completing live validation.\n

## Geometry Settlement Evaluation\n\n- [ ] Implement bounded polling settlement after geometry writes.\n- [ ] Implement AX move/resize notification-assisted settlement.\n- [ ] Benchmark latency, reads, missed notifications, and timeout behavior.\n- [x] Select or combine the more reliable approach and add regressions.\n- [ ] Revalidate live Zen cross-display movement and full suite.\n

## Geometry Settlement Results\n\nImplemented and live-benchmarked bounded polling and pre-armed AX moved/resized notification settlement against Zen. Across five alternating safe frame trials, successful writes were normally visible on the first read in about 1.3-10 ms. Zen produced zero useful consumed AX move/resize notifications. A constrained trial required the full polling budget: 13 reads and about 343-352 ms; notification-only waiting has a missed-event/hang risk when the first read is intermediate. Selected polling: immediate first read, then up to 12 reads at the existing 25 ms cadence. Removed experimental notification and benchmark product code after measurement. Added testSetPollsUntilAnimatedFrameSettles. Full validation passes: 137 Swift Testing cases, 52 XCTest cases, build, both geometry verifiers, and git diff --check. Live cross-display revalidation remains unchecked due to the separate Dell top-margin/Ghostty height conflict.\n

## Zen Immediate Transaction Experiment\n\n- [ ] Disable app AXEnhancedUserInterface around geometry mutation.\n- [ ] Apply immediate size-position-size writes without inter-write delay.\n- [ ] Require three stable reads within 600 ms and allow one corrective transaction.\n- [ ] Add delayed-animation and stable-wrong regression tests.\n- [ ] Rebuild and replay live Zen cross-display movement.\n- [ ] Run full validation and record results.\n

## Adaptive Zen Geometry Experiment\n\n- [ ] Add trajectory-aware settlement at display-like cadence.\n- [ ] Evaluate position-size, size-position-size, and staged strategies without overwriting active progress.\n- [ ] Disable AXEnhancedUserInterface during each transaction.\n- [ ] Benchmark every strategy live against Zen in both display directions.\n- [ ] Select adaptive strategy ordering and add deterministic regressions.\n- [ ] Run full validation and update live findings.\n

## Adaptive Zen Geometry Results\n\nImplemented immediate adapter-level geometry transactions with AXEnhancedUserInterface temporarily disabled. Strategy order is position-size first, then size-position-size corrective attempts. AX settlement samples every 17 ms for up to about 600 ms, tracks normalized distance to the target, and waits through improving trajectories instead of issuing a new write; success requires three target samples, while stable non-improving geometry releases the next strategy. Added testSetDoesNotOverwriteProgressingAnimation and updated transaction sequence coverage.\n\nLive Zen validation succeeded exactly in both directions: built-in `(0,32,1512,950)` and Dell `(-1030,-1440,3440,1440)`. Four additional alternating moves all committed, ending at the exact Dell frame with Zen focused and strongly joined. Full validation passes: 137 Swift Testing cases, 53 XCTest cases, build, both geometry verifiers, and git diff --check. One timing-sensitive health subscription test failed only during the first concurrent validation run, then passed narrowly and in the full suite rerun.\n

## Zen Dell-to-Built-in Regression\n\n- [ ] Reproduce snap-back with current Zen window identity.\n- [ ] Distinguish geometry settlement failure from later focus/reconciliation rollback.\n- [ ] Fix direction-specific regression and add coverage.\n- [ ] Repeat live round trips and full validation.\n

## Current Major Bugs\n\n- [ ] Reproduce inability to focus workspace B before and after daemon restart.\n- [ ] Reproduce inability to move workspace T to built-in before and after daemon restart.\n- [ ] Determine whether AX throttling/process health contributes.\n- [ ] Fix both command paths with deterministic regressions.\n- [ ] Revalidate exact live commands and full suite.\n

## In-Bounds Anchor Experiment\n\n- [ ] Place window at a smaller frame fully inside destination bounds and aligned to target top-left.\n- [ ] Settle anchor before expanding to exact margin-adjusted target.\n- [ ] Reproduce focus B and move T to built-in.\n- [ ] Add in-bounds anchor regressions and full validation.\n

## Native Tiling Reset Experiment\n\n- [ ] Inspect Zen Window menu AX hierarchy and identify native half-tile command metadata.\n- [ ] Add focused-window native half-tile reset fallback after anchor height stalls.\n- [ ] Reapply exact WM target and verify configured margins.\n- [ ] Reproduce focus B and move T to built-in, then run full validation.\n

## Runtime Debug Controls Plan

- [ ] Define raw AX window geometry commands that bypass workspace reconciliation.
- [ ] Add runtime switches for reconciliation/layout effects with safe defaults and inspectable status.
- [x] Add protocol, CLI, daemon, and deterministic tests.
- [ ] Validate focused tests and full suite.
- [x] Use raw controls to characterize Zen native tiling and geometry settlement live.

## Raw AX Permutation Harness

- [ ] Build a script that snapshots all current windows and display frames.
- [ ] Disable automatic reconciliation and exercise full/left/right/top/bottom frames on both displays across all AX write orders.
- [ ] Sample raw AX geometry at cumulative 1, 17, 100, 500, and 1000 ms intervals and record concise results.
- [ ] Restore every window to its original frame before re-enabling reconciliation.
- [ ] Run the harness live and summarize behavior by application, target, and write order.

## Raw AX Permutation Results

Ran 250 corrected permutations across Ghostty, System Settings, Spotify, Zen, and Messages with automatic reconciliation disabled. Each case reset through verified geometry, issued exactly one raw AX operation, and sampled at cumulative 1, 17, 100, 500, and 1000 ms. Only two trajectories changed after 1 ms, and total exact matches remained 72 at every interval, so waiting does not resolve these failures. Compound order dominates: size-position-size produced 36 exact matches, size-position 28, position-size 18, position-only 3, and size-only 3. Ghostty matched every target with size-position-size and size-position. Messages matched every target with size-position-size. Spotify matched six targets with size-position-size but no built-in half target. System Settings has a fixed 723-point width and cannot match any requested tile width. Zen matched zero raw cases: requests mutate either position or size but compound operations commonly leave one component at its original Dell frame; Dell requests also demonstrate a persistent 32-point top/height policy, and built-in top/bottom requests clamp 475 height to 495. All five windows were verified restored to their original frames and automatic reconciliation was re-enabled. Corrected raw output: /tmp/wm-ax-permutations-v2.ndjson.

## Focused Raw AX Permutations

- [ ] Add a raw AX focus command and CLI surface that does not trigger reconciliation.
- [ ] Extend the harness with optional focus-before-mutation and explicit match/failure/error summaries.
- [ ] Run the corrected 250-case matrix with each window focused before mutation.
- [x] Restore all windows, re-enable reconciliation, and compare focused versus unfocused results.

## Focused Raw AX Results

Added `debug ax focus WINDOW_ID` and optional `WM_AX_FOCUS=1` harness behavior. The focused run produced 55 matches, 145 completed failures, and 50 errors across 250 cases. System Settings accounted for all errors because its AX handle became unavailable during the run. Among completed cases, focus did not improve settlement: exact matches remained 55 at every sample interval and only two trajectories changed after 1 ms. By order: position 3 matches/37 failures, size 0/40, position-size 17/23, size-position 13/27, size-position-size 22/18; each order also had 10 System Settings errors. Zen remained 0 matches/50 failures. Ghostty improved from 25 to 27 matches, Spotify stayed at 17, while the app set changed because Discord opened and Messages lacked a display assignment at snapshot time. All still-addressable windows were restored to the focused run snapshot, and automatic reconciliation was re-enabled. Focused output: /tmp/wm-ax-permutations-focused-v2.ndjson; summary: /tmp/wm-ax-permutations-focused-v2-summary.json.

## removed-comparison-tool Comparison Harness

- [ ] Inspect installed removed-comparison-tool configuration, state schema, monitor indexing, and window identifiers.
- [ ] Define the closest layout-driven equivalents for full, left, right, top, and bottom on both displays.
- [ ] Build a harness that snapshots independent AX frames and removed-comparison-tool state throughout each operation.
- [ ] Stop wm, start removed-comparison-tool with controlled animation/layout settings, and run the comparison battery.
- [ ] Restore windows, stop removed-comparison-tool, restart wm, and summarize comparative behavior.

## removed-comparison-tool Harness Recovery

- [ ] Capture a durable pre-removed-comparison-tool window/frame snapshot before stopping wm.
- [ ] Make removed-comparison-tool state the primary source for hidden window identity and membership.
- [ ] Limit AX reads to the visible target and print progress before every blocking operation.
- [ ] Run the comparison, stop removed-comparison-tool, restart wm, and restore frames from the durable snapshot.
- [x] Verify service health and summarize removed-comparison-tool results.

## removed-comparison-tool Comparison Results

The redesigned harness completed 46 of 50 planned cases before receiving SIGTERM during Ghostty. It used removed-comparison-tool state rectangles and monitor/workspace membership at 1, 17, 100, 500, and 1000 ms. There were no command errors, but no case matched raw monitor bounds or the configured work-area-adjusted target exactly. Seven cases changed after 1 ms; several transitioned from plausible visible tiles to offscreen parking coordinates by 1 second. This shows removed-comparison-tool layout/workspace commands are asynchronous and the current harness begins sampling before workspace visibility and movement settle; the data characterizes transition and parking behavior rather than a fair stable-layout success rate. removed-comparison-tool parking is effective and explicit in state: hidden workspace windows retain membership while their rectangles move outside monitor bounds. Cleanup was interrupted before automatic restoration, so wm was restarted manually and all five durable snapshot frames were subsequently restored and verified exactly. removed-comparison-tool is stopped and wm is healthy. Partial output: /tmp/removed-comparison-tool-geometry-comparison-v2.ndjson; restoration report: /tmp/removed-comparison-tool-restore-report-v2.ndjson.

## Reconciliation-Enabled AX Battery

- [ ] Add a harness mode that preserves automatic reconciliation throughout the raw AX battery.
- [ ] Run the same corrected 250-case target/order matrix with reconciliation enabled.
- [ ] Restore all windows and verify service health.
- [ ] Compare matches, failures, errors, and trajectories against reconciliation-off results.
- [x] Record implications for durable uncooperative-window constraints and fallback policies.

## Reconciliation-Enabled AX Results

Ran 250 raw AX permutations with automatic reconciliation enabled: 98 matches, 152 failures, and zero errors. By order: position 4/46, size 7/43, position-size 28/22, size-position 25/25, size-position-size 34/16. By app: Ghostty 25/25, Discord 17/33, Spotify 17/33, Zen 9/41, Messages 30/20. Exact match totals were identical at 1, 17, 100, 500, and 1000 ms, with zero trajectories changing after 1 ms. The prior reconciliation-off run was 72 matches, 177 failures, and one error, but it used System Settings instead of Discord and different starting frames; four reconciliation-on windows began at built-in full size, inflating no-op and single-component success. The timing evidence is comparable and decisive: periodic reconciliation did not correct or revert any raw mutation during the one-second observation window. This supports recording stable observed constraints independently of reconciliation and applying an explicit fallback policy after a failed exact placement. Candidate durable constraint data should distinguish minimum width/height, anchored/rejected position axes, display-dependent chrome insets, parking overlap, and confidence/sample count. All windows restored exactly and wm remains healthy. Output: /tmp/wm-ax-permutations-reconciliation.ndjson; summary: /tmp/wm-ax-permutations-reconciliation-summary.json.

## Failure Constraint Analysis

- [ ] Extract requested/observed failure signatures from the reconciliation-enabled battery.
- [ ] Separate component-only expected mismatches from compound-operation constraints.
- [ ] Identify deterministic minimum sizes, position anchoring, display insets, and cross-display clamps per app.
- [ ] Run narrow confirmation probes where signatures are ambiguous.
- [x] Record a durable constraint model suitable for greedy, stack, overlap, and reject policies.

## Failure Constraint Results

Compound size-position-size failures revealed stable limits. Three repeated narrow probes confirmed Discord minimum size 800x500, Spotify 800x600, and Zen minimum height 495 while accepting width 700. All three preserved requested x/y for top and bottom probes, so these are true size constraints rather than position clamps. Discord and Spotify accepted Dell margin-adjusted full frame (-1030,-1408,3440,1408) in all three repetitions. Ghostty and Messages matched every tested target with size-position-size and have no observed durable size constraint in this range. Zen Dell full placement was state-dependent across identical repetitions: first remained at built-in (0,32,1512,950), second moved position only (-1030,-1408,1512,950), third reached exact Dell full. Record this as a transition constraint, not a minimum size. Cross-display restoration of Discord, Spotify, and Zen initially clamped at built-in 2434x950; a 700x950 in-bounds anchor followed by expansion restored all exactly to 1512x950. Proposed persisted model: identity scope (bundle/executable plus optional window role/subrole), min_width/min_height with confidence and sample count, per-display position/size residuals, transition sequence outcomes, last confirmed time, topology signature, and invalidation when app version/window identity/display topology changes. Output: /tmp/wm-removed-constraint-probes.ndjson.

## Zen Third-Attempt Repeatability

- [ ] Reset Zen to exact built-in full frame before every trial.
- [ ] Issue one identical Dell margin-adjusted full size-position-size request per trial.
- [ ] Record immediate and one-second outcomes across repeated independent trials.
- [x] Restore Zen and determine whether third-attempt success is repeatable or sequence-dependent.

## Zen Repeatability Result

Five independent cycles reset Zen to exact built-in full (0,32,1512,950), then issued the identical Dell request (-1030,-1408,3440,1408) three times with size-position-size and one-second settlement. Every cycle produced the same sequence: attempt 1 moved position only to (-1030,-1408,1512,950); attempt 2 reached exact Dell full; attempt 3 remained exact. Therefore the earlier apparent third-attempt success was an artifact of its initial starting state. From a clean built-in reset, second-attempt success is 5/5 and first-attempt success is 0/5. This is a repeatable two-phase transition: first establish destination position/display association, then reapply size. Zen was restored exactly and reconciliation remains enabled. Output: /tmp/removed-transition-probe.ndjson.

## Bidirectional Zen Repeatability

- [ ] Test built-in to Dell across five independent three-attempt cycles.
- [ ] Test Dell to built-in across five independent three-attempt cycles.
- [ ] Classify each attempt as exact, position-only, size-only, or other.
- [x] Restore Zen and record whether the two-phase behavior is symmetric.

## Bidirectional Zen Result

Five cycles in each direction show symmetric two-request behavior. Built-in to Dell: attempt 1 always moved position only to (-1030,-1408,1512,950), attempt 2 reached exact Dell (-1030,-1408,3440,1408), attempt 3 remained exact. Dell to built-in: attempt 1 always applied built-in size while retaining Dell position (-1030,-1408,1512,950), attempt 2 moved to exact built-in (0,32,1512,950), attempt 3 remained exact. Each attempt class was 5/5. The shared intermediate frame is (-1030,-1408,1512,950): position is Dell, size is built-in. Therefore direction determines which component changes first, but one identical corrective transaction after settlement is sufficient in both directions. Zen restored exactly and reconciliation remains enabled. Output: /tmp/zen-transition-bidirectional.ndjson.
