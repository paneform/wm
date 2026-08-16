---
# wm-cndm
title: Optimize Zen AX transaction sequence
status: todo
type: task
priority: high
created_at: 2026-08-15T21:36:20Z
updated_at: 2026-08-15T21:36:20Z
---

Investigate whether Zen cross-display placement can replace two full size-position-size transactions with a shorter, faster, equally reliable AX component sequence. Current repeatable behavior reaches exact geometry after two size-position-size transactions, with an intermediate hybrid frame using Dell position and built-in size.

## Questions

- Is the effective sequence size-position-size-size-position-size, or does settlement/application coalescing change that interpretation?
- Can redundant adjacent size writes be removed?
- Does destination direction require a different sequence?
- Which sequence minimizes AX writes and latency while preserving exact placement?

## Plan

- [ ] Add raw debug support for arbitrary AX component sequences without geometry-engine retries.
- [ ] Test baseline size-position-size twice in both directions across repeated clean-reset cycles.
- [ ] Test condensed/reordered candidates including size-position-size-position-size, size-size-position-size, position-size-position-size, position-size-size-position-size, and single-component staging variants.
- [ ] Record immediate/settled frames, success rate, AX write count, and total latency.
- [ ] Select the shortest 100% reliable sequence or retain the baseline if no candidate matches it.
- [ ] Add deterministic regression coverage and integrate the chosen sequence into geometry strategy ordering.
- [ ] Run focused/full validation and repeat live bidirectional cycles.
