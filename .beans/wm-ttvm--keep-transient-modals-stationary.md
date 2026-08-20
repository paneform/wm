---
# wm-ttvm
title: Keep transient modals stationary
status: completed
type: bug
priority: critical
created_at: 2026-08-19T21:44:45Z
updated_at: 2026-08-19T21:46:40Z
---

Transient and modal windows must never be assigned, tiled, parked, or explicitly moved. Their appearance must not park the active workspace, and a parent blocked by a transient modal must not be moved off-screen.

- [x] Trace transient lifecycle, focus activation, parking, and geometry effects
- [x] Add regression tests for stationary transient windows and blocked parents
- [x] Implement minimal lifecycle and geometry safeguards
- [x] Run focused tests
- [x] Run full test, lint, and build validation
- [x] Record summary and complete

## Summary of Changes

Made transient classification authoritative over manual management overrides. Added geometry-service rejection for all transient frame mutations and added workspace-effect filtering so unmanaged or non-normal stale members are never parked, restored, tiled, or moved during transitions and audits. Updated daemon and lifecycle regressions to verify an explicitly managed transient remains stationary.

This protects recognized transient windows and prevents their parent workspace membership from moving them. The FileVault authorization surface still requires generic AX modal/relationship detection because macOS currently reports it as `AXStandardWindow`; that classification work is separate.

Validation: `swift test`, `swift build`, and `git diff --check` pass. The package exposes no lint plugin or lint command.
