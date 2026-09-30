---
# wm-g4x0
title: Build compact snapping demo carousel
status: completed
type: feature
priority: normal
created_at: 2026-09-30T00:49:03Z
updated_at: 2026-09-30T01:20:06Z
---

Replace the responsive demo grid with a fixed-height horizontal carousel around 220–280px. Preserve scenario execution, immediate manual playback and autoplay start delay.

## Plan

- [x] Implement consistent card sizing, horizontal touch/trackpad scrolling and CSS snap alignment.
- [x] Follow autoplay with horizontal scrolling; add manual navigation and coordinate user scrolling with playback.
- [x] Validate desktop/mobile, single/many examples, reduced motion, timing, tests, lint, typechecks and build.

## Summary of Changes

Replaced the demo grid with fixed 240px cards in a native horizontal scroll/snap carousel, about 278px tall including controls. Single examples keep the same compact width; mobile never stacks cards. Autoplay reveals the active example with horizontal-only scrolling and retains the one-second starting hold. Manual navigation and selection start immediately. Added previous/next, count and pause/resume controls, keyboard navigation, hover/focus suspension, user-scroll selection and reduced-motion defaults. Updated the design spec.

## Validation

- Chrome matrix passed for 1–5 cards at 1440px, 375px and 320px: fixed height, bounded card widths, one horizontal row and no document overflow.
- Keyboard end navigation, manual snap selection, autoplay following and a real emulated touch swipe passed.
- Reduced-motion default and previous manual/autoplay timing checks passed. Screenshots reviewed.
- All 265 site tests, lint, typechecks including manifest contracts, production build and git diff --check passed.
