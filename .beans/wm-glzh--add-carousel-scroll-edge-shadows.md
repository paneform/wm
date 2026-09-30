---
# wm-glzh
title: Add carousel scroll-edge shadows
status: completed
type: task
priority: normal
created_at: 2026-09-30T19:08:57Z
updated_at: 2026-09-30T19:25:58Z
---

Add subtle inset shadows to carousel inline edges only when more content exists in that direction.

- [x] Track edge availability on scroll and resize and render non-interactive shadows.
- [x] Verify start/middle/end and non-overflow behavior, lint and typecheck.

## Summary of Changes

Added subtle inset shadows on the scroller’s inline edges. Scroll and ResizeObserver measurements enable each shadow only when content remains in that direction, clamp overscroll, and clear both for non-overflowing tracks. Shadows overlay the cards without blocking pointer input and respect reduced motion.

Validation: Chrome checks passed for start/middle/end and resizing between overflow/non-overflow. All 269 site tests, lint, typecheck and production build passed.
