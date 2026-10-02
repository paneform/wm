---
# wm-2h93
title: 'Directional move: full-extent window swaps with the target stack'
status: completed
type: feature
priority: normal
created_at: 2026-09-30T22:51:21Z
updated_at: 2026-09-30T22:53:20Z
---

Revises one geometric-move semantic (supersedes the flipped-roles line recorded in wm-opwp). Live use showed the splice is awkward when the moved window is the LARGE one: in A-over-B | C, moving C left spliced C into the stack as a 0.25 bottom pane (B-over-C | A), shrinking the moved window. Visually, a full-height window moving toward a stack should trade places with the whole stack.

New rule: in moveDirect's perpendicular-target T-junction branch, when the moved pane's orthogonal extent covers the target subtree region's orthogonal extent (equal lengths, tolerance-covered), exchange the moved leaf with the target stack subtree in one pass (internal stack ratios untouched, root ratio untouched). Result for A-over-B | C, C left => C | A-over-B.

Smaller-toward-larger moves keep the existing splice semantics (bean wm-opwp cases unchanged: 'B left carries its horizontal divider', 'C left becomes the lower pane beside full-height B').

Consequences: the mirrored pinned case 'A right' (geometric-move.spec.ts:94) changes expectation from 'full-height B beside C over A' to 'B-over-C beside full-height A' - same class, same rule. Add the live-observed orientation as an explicit regression test. Tie-break ambiguity disappears for subtree swaps: either ranked stack pane yields the same whole-region exchange.

## Summary of Changes

- layout/geometric-move.ts: moveDirect's perpendicular-target T-junction branch now compares the moved pane's orthogonal extent against the target stack's region extent; when it covers the stack (full-height/full-width moved window), the moved leaf is exchanged with the whole stack subtree in a single pass (new exchangeNodes helper). Stack-internal and enclosing divider ratios are untouched, so areas carry over exactly. Smaller panes keep the existing splice.
- geometric-move.spec.ts: new test 'full-height C left swaps with the whole left stack' (the live-observed orientation, C | A-over-B); 'A right' revised to 'A right swaps with the whole right stack' (B-over-C beside full-height A) — same rule, mirrored. All other confirmed semantics unchanged and passing.

Validation: 437 layout tests, typecheck, lint, format green. Not yet packaged/deployed (daemon runs the previous build until the next package + restart).
