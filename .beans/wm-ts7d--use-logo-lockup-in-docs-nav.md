---
# wm-ts7d
title: Use logo lockup in docs nav
status: completed
type: task
priority: normal
created_at: 2026-09-27T20:05:17Z
updated_at: 2026-09-27T20:08:08Z
parent: wm-fgbj
---

Plan: replace the improvised top-left wordmark with the existing theme-aware Paneform WM lockup image, keep the docs breadcrumb, and check desktop/mobile sizing.

- [x] Replace nav wordmark with the existing lockup asset
- [x] Verify light/dark asset behavior and narrow-screen header layout

## Summary of Changes

Replaced the improvised header wordmark with assets/paneform-wm-lockup.svg in the docs mockup. The SVG contains its own light/dark palette. Kept the / docs suffix on wider screens; on mobile, hide that suffix and let search use the remaining header width. Verified in Chrome that the SVG loads and the header has no overlap or horizontal overflow at 320px, 375px, and 1280px in both light and dark modes.
