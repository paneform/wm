---
# wm-k8e0
title: Build docs section rail
status: completed
type: task
priority: normal
created_at: 2026-09-27T22:20:42Z
updated_at: 2026-09-27T22:25:30Z
---

Implement the design reference’s on-this-page TOC for live docs routes.

## Plan

- [x] Render a connected rail aligned with H2/H3 entries, with active and scroll-progress strokes.
- [x] Keep headings and active state accurate across route changes, scroll, and resize; respect reduced motion.
- [x] Make the rail visible at desktop/laptop widths and validate typecheck, lint, and build.

## Summary of Changes

Replaced the placeholder TOC line with a connected SVG rail that follows rendered H2/H3 rows, bends toward nested headings, tracks document scroll, and highlights only the straight segment for the current heading. The TOC refreshes when docs pages change and remeasures on resize; reduced motion disables animations. Kept it visible down to 60rem instead of 70rem. Added rail geometry tests. Verified 216 site tests, svelte-check, oxlint and production build; browser visual alignment still benefits from review.
