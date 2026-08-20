---
# wm-wddy
title: Preflight new windows before layout insertion
status: todo
type: feature
priority: high
created_at: 2026-08-20T17:10:24Z
updated_at: 2026-08-20T17:10:24Z
---

Stage and verify a newly detected window at its intended workspace target before committing workspace membership or rearranging existing windows. This provides a generic quarantine boundary for reported or behaviorally uncertain geometry capabilities.

## Rules

- Determine placement using the documented restored membership, configured affinity, focused workspace, then fallback precedence.
- Compute the prospective layout and new window target without mutating committed workspace state.
- Apply and verify the new window target before inserting it into workspace membership or BSP state.
- Commit insertion and rearrange existing workspace windows only after preflight succeeds.
- On failure, preserve committed membership/layout and leave the window outside management for deterministic capability rules or retry.
- Cancel preflight when the window lifetime disappears or changes.
- Record rule evaluation, target, geometry evidence, outcome, and commit decision for tracing.

## Plan

- [ ] Model staged new-window placement and prospective layout targets
- [ ] Add geometry preflight with identity/generation cancellation
- [ ] Commit membership and existing-window effects only after verified success
- [ ] Preserve state and quarantine the window on failure
- [ ] Add deterministic rule trace output
- [ ] Add unit, daemon, and live regression coverage
- [ ] Run full validation and record summary
