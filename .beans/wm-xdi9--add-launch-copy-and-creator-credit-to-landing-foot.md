---
# wm-xdi9
title: Add launch copy and creator credit to landing footer
status: completed
type: task
priority: normal
created_at: 2026-09-16T03:51:21Z
updated_at: 2026-09-16T04:42:59Z
---

- [x] Show concise launch notification copy and add linked creator credit with Bluesky profile.
- [x] Run site checks and verify footer rendering.

Use the existing footer styling and preserve responsive behavior. Bluesky profile verified from allandeutsch.com: https://bsky.app/profile/allandeutsch.com.

## Footer Layout Refinement

- [x] Group the tagline and credit, reduce footer height, and keep compact email controls on one row.
- [x] Verify desktop, tablet, narrow mobile, and short landscape layouts in a browser.

## Summary of Changes

Added visible launch notification copy and creator credit linking to Allan Deutsch and Bluesky. Grouped tagline and credit into a compact block alongside the signup on wider screens; mobile places signup first. Kept email and submit controls on one row and reduced unnecessary footer height.

Validation: 204 site tests passed; lint, production build, and Svelte typecheck passed with no diagnostics. Browser checks passed at 1920x1080, 1280x800, 768x1024, 673x700, 390x844, 320x568, and 844x390, including dark mode and a mocked submitted state. No overflow or overlapping controls. Oxfmt does not process the Svelte files in the current project configuration.

Final credit copy: Crafted with care by Allan Deutsch, with website and Bluesky links.
