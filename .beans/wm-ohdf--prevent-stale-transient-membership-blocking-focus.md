---
# wm-ohdf
title: Prevent stale transient membership blocking focus
status: in-progress
type: bug
priority: critical
created_at: 2026-08-20T02:27:11Z
updated_at: 2026-08-20T17:17:11Z
---

A stale or unhealthy window identity retained in workspace membership must not block all workspace focus operations. Reproduce from the AutoFillPanelService CG-to-AX identity transition, prune ineligible replacement membership, and ensure effect execution skips non-controllable stale members safely.

- [x] Commit generalized transient and placement solution without ignored-window configuration
- [ ] Trace stale CG/AX replacement lifecycle and workspace reconciliation
- [ ] Add regression coverage for focus operations with stale transient membership
- [x] Implement minimal lifecycle/effect fix
- [x] Run focused and full validation
- [ ] Restart daemon and verify workspace switching
- [ ] Record summary and complete

## Progress

Committed generalized handling as 0d149d8 (`fix(wm): keep transient windows out of workspace effects`). The ignored-window configuration and its bean were excluded.

## Design Direction

Move window decisions toward deterministic, ordered rules with traceable evidence and outcomes. Represent geometry capabilities as generic position/size controllability with separate reported and behaviorally confirmed evidence. Platform adapters project host-specific signals such as AX attribute settability into generic reported capabilities. Reported fixed geometry quarantines a window before membership; bounded probes attempt movement/resize and restore the original frame, then confirm support/fixed status or leave evidence indeterminate. Retest on relevant lifecycle changes such as focus regain, child changes, changed platform reports, or explicit assignment. Persist confirmed profiles with invalidation and identity safeguards.

New-window preflight and commit-on-success is tracked separately in wm-wddy.

## Safeguards Implemented

Replacement inference now excludes transient and unmanaged candidates. Workspace focus, parking, restoration, and tiling skip currently observed transient members. Session reconstruction applies authoritative stale-member pruning before geometry effects. Full tests and build pass. Live AutoFillPanelService remains represented as a current normal CG-backed surface, so capability discovery and behavioral probing are the remaining work.
