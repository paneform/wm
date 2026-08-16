---
# wm-v8sb
title: Investigate System Settings move
status: completed
type: bug
priority: high
created_at: 2026-08-16T18:37:18Z
updated_at: 2026-08-16T18:39:13Z
---

Reproduce and diagnose moving the live System Settings window from workspace C to M. Capture transaction, workspace state, effective geometry policy, and live AX frames; restore the original arrangement after reproduction.\n\n## Checklist\n\n- [x] Capture C and M state and System Settings frame.\n- [x] Reproduce workspace move-window C to M.\n- [x] Identify the failed behavior and root cause.\n- [x] Restore original workspace arrangement.\n- [x] Record findings and remediation.

## Summary of Changes

Reproduced transaction `9A253B8C-3139-4538-9E11-D39258553864` failing at tile_incoming with `workspace policy produced an infeasible frame`; rollback preserved C, M, and all live frames. Root cause was greedy policy accepting a complete but invalid nested BSP frame plan under learned minimum/maximum constraints, including a non-positive leaf, so the daemon failed later instead of advancing the policy chain.

Added policy-frame feasibility validation for complete coverage, finite positive dimensions, and learned minimum/maximum compliance. Invalid greedy output now advances to stack/overflow. Added a deterministic three-window 712/800/723 regression. `swift test` passed 70 XCTest and 164 Swift Testing tests; `swift build` and `git diff --check` passed. Restarted live daemon as PID 50343. Retest transaction `8E8F1BF4-5853-4D23-BE76-686C0F2F36CD` committed with verified effects and `greedy->stack`; System Settings used `(0,32,723,950)`, Messages and Discord used `(0,32,1512,950)`. Restored System Settings to C and M to its original two-window membership; daemon remains ready.
