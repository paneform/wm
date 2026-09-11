---
# wm-tka6
title: Exclude separator gaps from BSP split ratios
status: completed
type: bug
priority: normal
created_at: 2026-09-11T20:48:12Z
updated_at: 2026-09-11T20:57:33Z
---

## Plan

- [x] Update solver and geometry-derived ratios to use gap-exclusive space.
- [x] Update browser dividers and document ratio semantics.
- [x] Add regressions and update affected frame expectations.
- [x] Run focused tests, full tests, lint, typecheck, build, and diff checks.

Do not deploy or restart the installed app.

## Browser mirror progress

Updated divider rendering to use gap-exclusive ratio space, refreshed browser expectations, and added nonzero-gap odd-split parity coverage. Browser tests and scoped formatting pass.

## Layout inference and insertion progress

- Updated initial-layout ratio inference and realization to use extent minus gap while preserving divider centers.
- Updated retained-divider comparison and inversion to exclude the current gap while retaining physical subtree extents.
- Added nonzero-gap roundtrip, overlap fallback, and retained-divider regressions.
- Targeted formatter and TypeScript checks pass. Targeted tests currently depend on the concurrent solver change from `floor(available * ratio)` to `floor((available - gap) * ratio)`.

## Scoped solver validation

- Updated remaining insertion expectations for gap-exclusive frames.
- Verified initial-layout roundtrip regressions, insertion planner, and window insertion: 34 tests passed.
- Verified formatting for the five owned source and test files.

## Hotkeys expectations progress

Updated balanced gap-exclusive ratio, frame, and wait expectations in `packages/layout/test/hotkeys.spec.ts`. Scoped formatting passes; narrow test passes (66 tests).

## Review Finding

P2: initial-layout.ts ratio inference and geometric-move.ts inverse ratios can lose a pixel because floor(space * (first / space)) sometimes rounds below first. Impact: inferred borders and swapped widths drift (15/22 and 115/900 reproduce). Mitigation implemented: shared ratioForLength retains exact ratios when they round-trip and otherwise chooses a value inside the intended rounding interval. Added inference and swap/inverse-swap regressions; all 43 focused tests pass. Full validation follows.

## Summary of Changes

Split ratios now apply to available space after reserving the current separator gap. Updated inferred ratios, retained insertion dividers, geometric move reconstruction, browser divider rendering, and contract documentation. Added balanced T-layout, unequal/zero-gap, nonzero-gap reconstruction, and rounding-sensitive inference/swap regressions. Added a shared floor-safe inverse ratio helper to prevent pixel drift. Imported observed frames remain observations; no forced equalization or migration was added.

## Final Validation

- pnpm test: passed, 588 TypeScript tests and 16 Swift tests.
- pnpm lint: passed.
- pnpm typecheck: passed.
- pnpm build: passed.
- Layout and layout-browser format:check: passed.
- git diff --check: passed.

No installed-app deployment, restart, or native live validation performed.
