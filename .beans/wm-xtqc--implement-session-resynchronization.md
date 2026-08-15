---
# wm-xtqc
title: Implement session resynchronization
status: completed
type: feature
priority: high
created_at: 2026-08-14T18:58:47Z
updated_at: 2026-08-15T00:01:57Z
---

Scope: sleep, wake, unlock, active-session, and clamshell transition epochs.

Acceptance:
- Pause mutations during transitions.
- Wait for stable displays and revalidate permissions.
- Recreate AX observers, discard stale handles, rebuild inventory, and reconstruct observed state.
- Audit parked/lost/drifted windows and reconcile committed workspace intent.
- Resume processing and emit typed resynchronized/health events.


## Plan

- [x] Inspect transition requirements and existing lifecycle/inventory architecture.
- [x] Implement session transition resynchronization behavior and typed events.
- [x] Add focused tests.
- [x] Run focused and full validation.
- [x] Commit implementation and bean updates.

## Summary of Changes

- Added serialized session transition epochs for sleep, wake, unlock, active-session, and clamshell notifications.
- Paused and queued mutations while waiting for stable display snapshots and revalidating Accessibility and Screen Recording permissions.
- Rolled observer generations, discarded stale handle-derived caches, rebuilt inventory and observed lifecycle state, audited committed intent, and reconciled workspace state before resume.
- Added typed daemon.paused, daemon.resumed, session.resynchronized, and health.changed publication with transition metadata.
- Added deterministic tests for transition ordering, generation rollover, unlock classification, permission failure, bounded display fallback, and protocol topic names.
- Validated with focused daemon tests, the full Swift package test suite, swift build, and git diff --check.
