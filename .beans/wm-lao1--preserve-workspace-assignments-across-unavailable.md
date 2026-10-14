---
# wm-lao1
title: Preserve workspace assignments across unavailable observation
status: completed
type: bug
priority: high
created_at: 2026-10-13T00:23:58Z
updated_at: 2026-10-13T23:30:32Z
---

Implement the agreed model: distinguish unavailable observation from closure, remove five-minute membership expiry, restore only matching pre-existing window/process instances, and assign/follow genuinely new focused windows by config then current workspace.

## Plan
- [x] Inspect current engine/native observation and identity boundaries and choose a minimal portable contract.
- [x] Implement availability and identity-safe retained assignments across native/protocol/engine layers.
- [x] Add regressions for long gaps, partial failures, closure/replacement and new-window focus behavior; update contract docs.
- [x] Run relevant focused checks, formatter, full tests/lint/typecheck/build and record results.

## Implementation approach

Keep current window facts separate from remembered placement; unavailable windows must not receive writes using stale geometry. Add an optional portable inventory read carrying current windows, unavailable known IDs, and confirmed closed IDs. Existing adapters remain compatible. Retain assignments without a time limit and match by window ID/PID plus an opaque platform instance token where available. Native lifecycle tracking keeps AX references and process start identity across observation gaps and retires instances only on positive closure evidence. No broad host-state framework is needed for this fix.

## Progress

Removed time-based expiry. Portable inventory carries current windows, unavailable IDs and positively closed IDs; confirmed close events are separate from diff absence. Restoration checks window/process instance identity and retires mismatches. Native lifecycle tracking survives AX/CG normalization changes and rebuilt AX handles when the CG handle and process start identity still match; unavailable instances never supply stale geometry to plans. Added engine, transport and native lifecycle regressions and updated platform contract. Focused engine tests (9 cases) and native source/lifecycle initial checks pass; final formatting and integrated checks remain.

## Validation

- Full pnpm test passed: 1,097 tests (522 layout,150 browser,44 Swift,21 macOS transport,66 CLI,294 site).
- pnpm lint, pnpm typecheck and pnpm build all passed, including Swift build and Svelte checks (zero errors/warnings).
- Applied oxfmt to intended TS/docs files and swift-format with indentation matching the existing Swift files. git diff --check passed.
- Ten new engine regressions cover startup unavailability, week-long gaps, whole-read failure/no writes, changed PID, changed instance token, positive closure, replacement without an absence snapshot, configured focus following, explicit close events and focused returning windows. Five native lifecycle tests cover process-start sampling, failed/stalled observation, positive retirement, PID/reference reuse, surviving CG surfaces and normalization/AX-handle rebuilds. A transport regression covers availability/closure metadata, instance-token preservation and unavailable errors.
- Existing recovery tests now simulate observation loss while keeping the native fake instance alive; fake/web destruction emits positive closure. The existing failed-focus insertion test isolates failure without a changed process identity; changed-PID retirement is independently covered.

## Summary of Changes

Removed five-minute placement expiry entirely. Retained placements are restored only to matching window/process instances, with an opaque native lifetime token when available. Unavailable observations and confirmed closure are distinct portable facts; confirmed close events and identity replacements retire remembered assignments. New windows retain config-then-current assignment and authoritative focus-following behavior.

Added native lifecycle tracking using process start times, retained AX references and CG ownership, preserving the public ID across matching normalization changes. Current actionable observations exclude unreadable windows, preventing stale-geometry layout plans. Entire inventory requests fail unavailable during sleep, permission/read failure and initial recovery; pass generation checks discard sleep/wake-spanning observations. Startup retries temporarily unavailable inventory. Updated platform contract and regression coverage.

Source/build verification is complete. No installation, daemon restart, live window movement, application activation or project changes were performed. A coordinated installation and user-assisted real sleep/wake cycle with OpenSCAD/Bambu is the remaining live validation step; the currently installed daemon still uses the previous build.

## User live feedback

After deployment wm-qnt5, user reports the fix seems to be working and requests a commit. This is user-reported success, not an instrumented sleep/wake capture.
