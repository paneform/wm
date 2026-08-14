---
# wm-xq1q
title: Recover startup from geometry clamps
status: completed
type: bug
priority: critical
created_at: 2026-08-14T23:23:04Z
updated_at: 2026-08-14T23:23:51Z
---

Startup committed-intent reconciliation aborts when an application clamps a requested tile frame. Startup should retain verified observed geometry, report the clamp, continue reconciling other effects, and become ready.

## Plan

- [x] Trace existing observer clamp tolerance and startup retile behavior.
- [x] Apply the established clamp tolerance to startup/resume committed-intent audits without weakening explicit geometry commands.
- [x] Add regression coverage for startup audit policy.
- [x] Run targeted and full validation.
- [x] Summarize the fix.

## Summary of Changes

Startup and resume committed-intent recovery now treat visible BSP retiling as best-effort observer reconciliation. Application frame clamps are recorded as observed minimum sizes and reported once, but no longer abort daemon readiness. Required visibility effects, restoring visible parked windows and parking hidden windows, remain strict. Explicit geometry and workspace commands retain transactional failure behavior. Added a recovery-policy regression test. Validation passed: targeted WMDaemonTests (15 tests), full swift test (46 XCTest and 89 Swift Testing tests), swift build, and git diff --check.
