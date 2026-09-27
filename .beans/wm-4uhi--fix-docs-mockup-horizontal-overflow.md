---
# wm-4uhi
title: Fix docs mockup horizontal overflow
status: completed
type: bug
priority: normal
created_at: 2026-09-27T19:01:02Z
updated_at: 2026-09-27T19:03:26Z
parent: wm-fgbj
---

Plan: reproduce horizontal scrolling at narrow and desktop widths, find the overflowing element, make a focused layout fix, and verify representative docs views.

- [x] Reproduce and locate horizontal overflow
- [x] Fix the responsible layout or content sizing
- [x] Recheck key viewport sizes and document the result

## Findings

Record source location, impact, and mitigation here.

## Finding

- `docs/mockups/docs-experience.html:221-246` (`td code.snippet` with `white-space: nowrap`, and `table.invocations` at 100% width): the workspace invocation table expands to about 674px while its content column is 537px at an 833px viewport; the table reaches x=946px and causes document scrolling. The WebSocket example is 561px wide by itself. Impact: readers see a horizontal scrollbar at widths around 833–945px, and the table can crowd adjacent navigation at other widths. Mitigation: allow long invocation snippets to wrap within their cells with `overflow-wrap: anywhere` while retaining their inline code styling.

## Summary of Changes

Allowed invocation code snippets to wrap at any point inside table cells instead of forcing their full width onto one line. Removed the redundant narrow-screen invocation override. Confirmed the workspace table now stays inside its column and all four mockup views have no page-level horizontal overflow at 375, 500, 672, 833, 900, 945, 1024, 1121, 1150, and 1280px in Chrome.
