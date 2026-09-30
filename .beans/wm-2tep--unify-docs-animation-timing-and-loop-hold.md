---
# wm-2tep
title: Unify docs animation timing and loop hold
status: completed
type: task
priority: normal
created_at: 2026-09-30T21:43:50Z
updated_at: 2026-09-30T22:20:22Z
---

Use the requested cadence: prepare 0, playback/progress 1000ms, command 1300ms, completion/result 1800ms, next example 2800ms. After the final item, hold another 1200ms and reset at 4000ms for a single example.

- [x] Centralize presentation timings and synchronize command, transitions, progress, captions and result holds.
- [x] Delay final sequence reset and restore prepared starting snapshots without intermediate animation.
- [x] Verify timeline and cancellation behavior in browser, then tests/lint/typecheck/build.

## Summary of Changes

Centralized docs timing in demo-timing.ts: 1000ms prepare hold, 300ms command lead, 500ms transitions, 800ms playback/progress duration, 1000ms result hold and 1200ms final sequence hold. CSS progress/window/flash timing and workspace indicator travel use the shared values. Completion and result captions now occur at the nominal 1800ms point; the next item advances at 2800ms and a single-item sequence resets at 4000ms. Cached prepared snapshots restore every preview accurately on reset.

Validation: Chrome measured single-item reset ~4006ms and two-item reset ~6813ms, with playback ~1001ms, command ~1303ms and completion ~1803ms. Confirmed progress completion/result caption alignment and cancellation of an old reset when manually replaying during the final hold. Existing indicator and manual/autoplay checks passed, along with all 275 site tests, lint, typecheck, production build and git diff --check.

Timing-only commit validation: exported the staged index to an isolated checkout. All 269 tests in that snapshot, lint, typecheck, and production build passed. Chrome timing checks also passed: playback ~1001ms, command ~1302ms, completion ~1802ms, single-example reset ~4004ms, and two-example reset ~6811ms; manual replay cancelled the obsolete reset timer.
