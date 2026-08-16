---
# wm-lbit
title: Add resilient policy fallback chain
status: scrapped
type: feature
priority: high
created_at: 2026-08-16T17:14:34Z
updated_at: 2026-08-16T18:08:05Z
---

Implement automatic uncooperative-window fallback without extra configuration: greedy -> overlap -> stack -> overflow. Reject remains explicit opt-in and never participates as an automatic fallback. Fallback layouts should commit successfully while surfacing degraded/unhealthy state and diagnostics.\n\n## Plan\n\n- [ ] Define overflow frame semantics and fallback result metadata.\n- [ ] Implement greedy, overlap, and stack fallback chaining; preserve explicit reject.\n- [ ] Propagate fallback degradation through transactions, state health, and diagnostics.\n- [ ] Add deterministic policy, daemon, protocol, and health tests.\n- [ ] Run full and live validation.

## Reasons for Scrapping

Superseded by wm-dsgf, which implements the same fallback chain as a configurable ordered `layout_policy`, including independent primitives, diagnostics, health degradation, tests, and live configuration validation.
