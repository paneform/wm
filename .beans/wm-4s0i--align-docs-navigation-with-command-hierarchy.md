---
# wm-4s0i
title: Align docs navigation with command hierarchy
status: completed
type: task
priority: normal
created_at: 2026-10-01T21:36:41Z
updated_at: 2026-10-02T00:26:01Z
---

Generate the docs navigation from the current command vocabulary so labels and nesting match Commands → Window → List rather than plural domains and descriptive page titles.

## Plan

- [x] Derive a singular, concise command tree from the shared command catalog and host paths.
- [x] Update sidebar, command index, breadcrumbs and search labels to use the hierarchy.
- [x] Verify nested paths, link coverage and active-link behavior; format and run site tests, lint, typecheck and build.

## Progress

Navigation now derives literal command prefixes from the layout-owned catalog, with concise singular namespaces, nested operations and separate directional references. A shared recursive component renders the sidebar and command index. Breadcrumbs and qualified search labels use the same paths; search retains all command spellings. Manager-wide commands are at the command root, and permissions/request and serve have navigable destinations. All five focused navigation checks and the first site typecheck pass; full site verification passed.

## Summary of Changes

Replaced plural domain headings and descriptive action labels with a grammar-derived command tree: Commands → Window → List, Window → Move → Position, Workspace → Move → Display → Next, Config → Validate, and other current commands. A shared recursive component renders both the sidebar and command index. Command-page breadcrumbs and qualified search labels use the same hierarchy, with all grammar forms retained as search keywords. Manager-wide commands live directly under Commands; Permissions → Request and Serve have documented destinations.

## Validation

All 284 site tests passed, including five navigation checks for singular labels, nested operations, exactly-once page coverage, flags excluded from labels, host destinations, active parent/anchor links, breadcrumbs and search. Site lint, typecheck, production build, formatter checks and git diff --check passed.
