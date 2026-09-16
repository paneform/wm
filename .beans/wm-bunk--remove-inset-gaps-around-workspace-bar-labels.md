---
# wm-bunk
title: Remove inset gaps around workspace bar labels
status: completed
type: bug
priority: normal
created_at: 2026-09-16T04:15:16Z
updated_at: 2026-09-16T04:42:59Z
---

- [x] Make colored workspace labels meet their group borders without nested corner gaps.
- [x] Validate site checks and inspect browser rendering at multiple scales.

## Summary of Changes

Removed independent left corner rounding from DesktopTopBar workspace labels. The outer button now clips the colored fill to its own border curve; label right corners remain rounded.

Verified desktop and mobile Chrome screenshots at DPR 4: no dark slivers along the left edge, and symmetric top/bottom alignment. All 204 site tests, lint, production build, and Svelte typecheck passed.

## Reopened: Animated Seam

The user still sees a one-pixel seam during moving/zooming, including after negative label margins. Static high-density screenshots were not sufficient validation.

- [x] Replace the separately clipped border/fill junction with a shared outer clipping edge.
- [x] Compare browser rendering at fractional scales and low pixel density, then rerun site checks.

## Final Fix

Replaced the real border with an inset box-shadow and equivalent padding. Negative label margins extend to the shared outer clipping edge, with zero left corner radii. Browser comparisons reproduced the original seam and showed the fix removes it at zoom 0.83, 1.17, and 1.5 on desktop/mobile at DPR 1 and 2. All 204 site tests, lint, production build, and Svelte typecheck passed.
