---
# wm-b8ku
title: Build live docs site foundation
status: completed
type: feature
priority: normal
created_at: 2026-09-27T21:50:04Z
updated_at: 2026-09-27T22:06:43Z
---

Implement /wm/docs from the approved reference.

## Plan

- [x] Establish layout-owned command metadata and generated command catalog with drift checks.
- [x] Add mdsvex guide pipeline and responsive docs shell/navigation.
- [x] Implement generated command pages and representative live demos using existing playground components.
- [x] Validate site and layout tests, lint, typecheck and build; document outcomes.

## Notes

The existing playground is gated in production. Docs demos run on public pages; playground links appear only when the playground is enabled. Guide content is intentionally minimal.

## Summary of Changes

Added `/wm/docs/` to the SvelteKit site with responsive navigation, search, section TOC, mdsvex/Shiki guides, a schema-backed configuration outline, and command index/reference routes. Command syntax and descriptions are joined from the layout package grammar; invocation examples derive from parsed engine commands. The overview and move-command pages play committed one-step scenarios through the actual scenario runner and desktop stage; doctor has an illustrative local transcript. Added coverage checks for grammar forms, documented error codes and runnable demos. Site and layout typechecks, linters and full tests passed (site 214; layout 435), and the site production build passed. The playground remains gated in production; docs share links are shown only when it is enabled.
