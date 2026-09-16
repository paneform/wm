---
# wm-lihw
title: Add linked OS comparison demo to playground
status: completed
type: feature
priority: normal
created_at: 2026-09-16T18:15:23Z
updated_at: 2026-09-16T21:48:17Z
---

## Plan

- [x] Inspect playground recording, rendering, workers, and OS injection.
- [x] Add two independent sessions driven by one recorded input stream, with safe paired lifecycle/error handling.
- [x] Add a portable comparison mode and authored CooperativeOS/MacOS demo within /wm/play.
- [x] Render labeled laptops and route interactions from either pane into shared recording.
- [x] Test paired input/replay, geometry divergence, failures, exports, and browser interactions across sizes.
- [x] Run tests, lint, typecheck, and build; document behavior.

Two independent OS environments are required, not two monitors of one OS. Both share portable window IDs and requested actions, but retain separate geometry and layout results. Keep a single editor, document, timeline, and export flow.

## Design and Review

Comparison is a portable presentation preset, expanded by a paired worker-client coordinator into independent CooperativeOS (none) and MacOS sessions. Shared absolute inputs are recorded once; both sessions must settle before advancing. Failures poison the pair until reset. Shared keyboard attachment and pane-scoped inspectors support either laptop.

Review found an inherited reset race: preserving input epochs could allow old queued gestures to mutate replacement sessions (ScenarioPlayer replaceSession/returnToStart). Fixed by incrementing inputEpoch and remounting stages on every replacement, rejecting input while busy. Tests needed one-sided apply failure coverage; added as follow-up verification. Documentation now explicitly describes full source frames, commit-on-release, shared expectations, profile overrides, and disabled rebase. Browser checks passed side-by-side/mobile layout, right-pane open/move/resize/close, separate frames, inspector selection, physical keyboard single dispatch, replay, and comparison toggle persistence.

User requested an encoded share URL. Production playground remains intentionally gated; provide a working local playground-enabled URL without altering that gate.

## Summary of Changes

Added a linked comparison mode inside /wm/play with independently simulated CooperativeOS and MacOS laptops, a shared recording/playback timeline, pane-aware input and inspector routing, and safe paired worker lifecycle/error handling. Added an editable seven-step OS boundary demo, a load-demo button, portable comparison metadata and share encoding, and documentation. Session resets now cancel stale queued inputs and gestures.

Validation: 846 TypeScript and 16 Swift tests passed, workspace lint/typecheck/build and both formatter checks passed. Browser verified desktop/mobile layouts, same-ID geometry divergence, input from either pane, keyboard exactly-once dispatch, inspector anchoring, export/toggle/replay, and reset during a drag or queued actions without stale-input leakage. Encoded demo roundtrips and is under 2 KB.

Started a playground-enabled local dev server at http://127.0.0.1:5174 (launcher PID 39609) for the requested working share URL; HTTP 200 confirmed. Existing local server and production playground gate left unchanged. No commit or push requested for this feature yet.

## Authoring Controls Revision

- [x] Replace the special preset button with configurable linked-simulation authoring controls (per-side OS, label, subtext).
- [x] Use default subtexts allows full window control / limits window controls and keep existing shared comparison documents loadable.
- [x] Validate control-built scenarios, shared replay, tests, lint, typecheck, and builds.

User wants to build the comparison through playground controls rather than a hard-coded demo action.

## Authoring Revision Summary

Removed the runtime preset import and special Load OS comparison demo button. Linked simulations are now ordinary authoring settings: each environment has a configurable label, subtext, and OS descriptor. The default subtexts are allows full window control and limits window controls. Existing literal-form shared documents remain loadable; new edits serialize explicit environment objects. Comparison can be disabled/re-enabled without losing settings, and settings changes preserve all recorded steps while resetting playback.

Browser validation started from plain /wm/play with no hash or fixture: enabled linking, edited both environments, swapped OS choices, recorded from both panes, and round-tripped a generated share URL. Left macOS clamped at y=44 while right unconstrained retained y=-74.55. Default subtexts, absence of preset button, legacy loading, desktop/mobile layouts, and no console errors verified. Full workspace passed 855 TypeScript tests and 16 Swift tests plus lint, typecheck, builds, and both formatter checks.
