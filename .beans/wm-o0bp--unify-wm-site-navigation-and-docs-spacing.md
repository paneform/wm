---
# wm-o0bp
title: Unify WM site navigation and docs spacing
status: completed
type: task
priority: normal
created_at: 2026-10-05T21:57:12Z
updated_at: 2026-10-07T17:28:16Z
---

## Plan

- [x] Inspect route layouts and identify excess docs spacing.
- [x] Share a responsive header and footer between /wm and /wm/docs.
- [x] Validate desktop/mobile navigation, spacing, and site checks.

## Scope

Keep navigation simple and cohesive on desktop and mobile.

## Summary of Changes

- Added shared SiteHeader and SiteFooter components to the WM landing page and every docs page.
- Added consistent Home/Docs navigation and active-page indicators; kept docs search and optional playground access.
- Reduced docs bottom padding from 5–6rem to 2rem and adjusted sticky heading offsets.
- Preserved landing demo controls, signup behavior, and creator credit.

## Validation

- Site typecheck: passed, no errors or warnings.
- Site tests: 293 passed across 37 files.
- Site lint and production build: passed.
- CSS formatter check and git diff whitespace check: passed.
- Chrome browser checks at 320, 375, 768, and 1440px: no horizontal overflow; Home/Docs navigation, search, and mobile docs menu work.
- Reviewed desktop/mobile screenshots; checked dark mode and 844×390 landscape with landing footer visible.

## Follow-up

- [x] Remove vertical auto margins from .docs-shell and validate CSS.

### Follow-up summary

Changed .docs-shell margin from auto to 0 auto, removing vertical margins while keeping horizontal centering. Formatter and git diff whitespace checks passed.

## Content padding adjustment

- [x] Restore shell auto margins and move bottom padding to docs main/sidebar.
- [x] Validate responsive padding and formatting.

### Content padding summary

Restored .docs-shell margin: auto and removed its bottom padding on desktop/mobile. Added .docs-main class and 2rem bottom padding to main/sidebar, including the open mobile sidebar. Chrome computed-style checks passed at 375px and 1440px; formatter and whitespace checks passed.

## Sidebar divider

- [x] Add and validate a faint inline-end sidebar border.

### Sidebar divider summary

Added a 1px border-inline-end using the existing faint docs-line color token. CSS formatter and whitespace checks passed.

## Section-owned spacing

- [x] Remove shell padding and let sidebar, main, TOC, and mobile navigation own spacing.
- [x] Validate responsive layout and CSS formatting.

### Section-owned spacing summary

Removed shell padding and grid gaps; sidebar, main, and TOC now own 2rem block/1.5rem inline padding. Mobile main uses 1rem top/1.25rem inline/2rem bottom padding; menu/sidebar own their gutters. Adjusted sticky sidebar/TOC offsets for section top padding. Verified zero shell padding and no horizontal overflow in Chrome at 320, 375, 768, 960, 1120, and 1440px, plus working mobile navigation. Reviewed desktop screenshot. Formatter and whitespace checks passed.

## Header simplification

- [x] Remove Home link, place Docs next to the home logo, and validate responsive navigation.

### Header simplification summary

Removed the redundant Home link and placed Docs beside the home-linked logo. Kept desktop docs search aligned at inline-end. Typecheck passed without errors/warnings; Chrome checks at 320, 375, and 1440px confirmed adjacent navigation, no overflow, and working logo-home/Docs links. Whitespace check passed.

## Docs scrolling

- [x] Add docs-only smooth scrolling that respects reduced motion and validate CSS.

### Docs scrolling summary

Added native CSS smooth scrolling to the document root when a docs page is present and reduced motion is not requested. Chrome checks confirmed smooth for normal motion, auto for reduced motion, and auto on the landing page. Formatter and whitespace checks passed.
