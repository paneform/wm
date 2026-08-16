---
# wm-hxk9
title: Clear stale workspace fallback health
status: completed
type: bug
priority: high
created_at: 2026-08-16T18:42:10Z
updated_at: 2026-08-16T18:43:15Z
---

Fix stale workspace layout fallback diagnostics after a constrained window moves back to a simple workspace.\n\n## Acceptance\n\n- [x] A successful current layout replaces prior fallback diagnostics.\n- [x] Single-window C reports healthy; fallback layout metadata remains informational until C is retiled.\n- [x] Successful fallback is not classified as unhealthy.\n- [x] Add deterministic regression coverage.\n- [x] Restart and verify live C and M diagnostics.

## Summary of Changes

Successful policy fallback is now treated as usable layout metadata rather than an unhealthy state. Workspace health reports unhealthy only for a rejected plan, and daemon health no longer promotes successful fallback history to unhealthy. Added daemon regression coverage asserting a verified workspace remains healthy.

Validated with `swift test` (70 XCTest and 164 Swift Testing tests), `swift build`, and `git diff --check`. Restarted live daemon as PID 6919. C reports healthy with its prior greedy->stack metadata retained informationally; M reports healthy; daemon health reflects only the pre-existing degraded AX scan issues.
