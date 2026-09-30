---
# wm-xseh
title: Use workspace 1 in docs scenarios
status: completed
type: task
priority: normal
created_at: 2026-09-30T00:14:34Z
updated_at: 2026-09-30T00:21:36Z
---

Rename the default workspace from code to 1 in docs scenario state, commands, expectations and accompanying descriptions.

- [x] Update scenario files and manifest copy consistently.
- [x] Format and validate all scenario expectations, typecheck and lint.

- [x] Apply the one-second start hold to autoplay only; manual selection starts immediately, and verify browser timing.

## Summary of Changes

Changed the default docs workspace from code to the string 1 across scenario state, commands, expectations, captions and manifest introductions. Autoplay retains the one-second pre-play hold; clicking a situation bypasses it. Updated browser checks to verify both manual start and the autoplay pause. All 35 scenario expectations and 261 site tests pass, along with lint, typecheck, production build, Chrome timing checks and git diff --check.
