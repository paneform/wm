---
# wm-7imd
title: Add optional macOS geometry rules to simulation
status: completed
type: feature
priority: normal
created_at: 2026-09-16T17:23:19Z
updated_at: 2026-09-16T17:53:18Z
---

## Plan

- [x] Locate native boundary measurements and trace simulator/engine integration.
- [x] Confirm how the layout engine should consume OS rules.
- [x] Implement a configurable, optional OS geometry response stage with documented measurement provenance.
- [x] Cover native boundary cases, disabled rules, simulation input/write paths, and deterministic replay.
- [x] Run relevant tests, lint, typecheck, and builds.

## Evidence

Native Messages probes recorded a built-in top floor of 32 logical points, Sidecar top floor 0, one-point horizontal overlap accepted, zero overlap requests falling back to 40 points horizontally, and 52-point bottom overlap. Other apps/probes recorded 64-point bottom overlap or different horizontal behavior. Sources: wm-8ipb, wm-ykgq, wm-tqkk, wm-i6nr, wm-ysdj. These are measured profiles, not universal macOS constants. Existing simulator approximates offscreen refusal only during adapter position writes, and external move paths bypass it.

## Design Decision

Enforce OS rules in the simulator; the engine observes effective geometry through its existing adapter. No predictive engine policy changes. Provide an opt-in macOS profile and explicit off switch. Preserve omitted-option behavior for shipped scenarios that depend on the existing offscreen approximation. Use display work-area top as the modeled top floor; keep fallback/bottom distances configurable and document uncertain multi-display behavior.

## Injection and Pre-Launch Behavior

OsRuleset is an independent object contract (name + pure applyGeometry). macOsRules/createMacOsRules and unconstrainedOsRules are separately defined implementations. The simulation applies injected rules to adapter component writes and manual drift/nudge/update operations regardless of WM lifecycle. The landing hero and new playground documents select macOS; shared JSON stores a descriptor resolved at the session boundary. Custom OS objects require no layout-engine changes. Added measured-profile documentation and tests for native boundaries, custom injection, stopped/paused operations, and share/replay persistence.

## Focused correctness review plan

- [x] Inspect OS rules, adapter writes, scenario persistence, hero injection, and renderer manual paths.
- [x] Validate concrete counterexamples without repeating full suites.
- [x] Record prioritized findings and follow-up recommendations.

## Focused correctness review findings

1. **P2 — Cross-display correction is not idempotent.** Location: packages/layout-browser/src/sim/macos-rules.ts:72-76 (hostDisplay/constrainFrame). With display A=(0,0,1000,1000), work-area top 32, and B=(1000,500,1000,1000), work-area top 532, request (800,-500,1000,700) returns y=32; applying the rules again returns y=532. The first correction changes the largest-overlap host. Impact: unchanged follow-up edits move the window again, and component frame writes can differ from external edits. Mitigation: choose a stable constrained host/frame, with deterministic handling of ties/cycles, and test staggered displays and adapter/external parity. Confirmed with a focused tsx invocation.

2. **P2 — Animated frame writes discard the position component (pre-existing pipeline defect exposed by this integration).** Location: packages/layout-browser/src/sim/web-platform.ts:603-610, 626-630 (runWrite/setWindowFrame). Each component updates only target; subsequent components still read the old frame. For an animated window at (100,100,300,200), setWindowFrame(400,400,500,400) with macOS rules returns (100,100,500,400), stable=true. Impact: engine frame requests and injected rules see stale intermediate geometry and lose the requested position. Mitigation: advance/settle components or compose against the prior effective target, while retaining physical previous-frame semantics; add animated full-frame coverage. Confirmed with a focused tsx invocation.

3. **P2 — Toggling OS constraints loses measured overrides.** Location: apps/site/src/lib/play/AdvancedControls.svelte:42-45 and ScenarioPlayer.svelte:425-429. A macOS descriptor with custom distances is replaced by none/undefined; selecting macOS again constructs only {kind: macos}. Impact: temporarily disabling constraints silently restores default measurements and subsequent export/replay uses them. Mitigation: retain the last macOS descriptor separately for the current document and restore it when re-enabled; test macOS(custom) -> none/existing -> macOS. Verified by tracing both callbacks; no browser interaction test run.

## Review validation and scope

Inspected scenario descriptor/schema/resolver, state/session replacement, hero defaults, and renderer move/resize callbacks. Exact initial imports and omitted-profile legacy behavior were treated as intentional. No production files edited and no full test, lint, or build suites repeated. Only focused inline reproductions were executed. Follow-up implementation and regression tests remain with this feature; the feature bean is not complete.

## Review Resolutions

All three review findings were fixed and re-reviewed with no remaining blockers. The macOS profile retains frames legal on any display, ensuring stable correction on staggered screens. Animated writes compose against the effective target rather than stale geometry. The playground remembers configured measurements when toggled off and back on, resetting that memory only after successful import of a different document.

## Summary of Changes

Added the independent OsRuleset injection interface, macOsRules/createMacOsRules and unconstrainedOsRules implementations, and simulator enforcement before observations on both external geometry changes and adapter component writes. Enabled macOS in the landing hero and new playground scenes, including before WM startup. Added portable simulation descriptors, a playground selector, schema validation, export/share/replay persistence, and documented exact probe evidence versus modeling assumptions in SCENARIOS.md. Existing imported scenarios without a selection preserve shipped behavior. No layout-engine policy changes or native OS probing were required.

Validation: all workspace tests passed (831 TypeScript tests and 16 Swift tests); workspace lint, typecheck, and build passed; layout-browser and site formatter checks passed. Headless Chrome verified stopped-WM top/side snap on drag/resize, unconstrained offscreen moves, JSON export, override restoration across toggles, distinct-document reset, and pre-WM landing interaction, with no browser errors. Browser artifact: /var/folders/km/jth9jsgn24lfrsvvp9sjzrqr0000gn/T/opencode/os-rules-validation.json.
