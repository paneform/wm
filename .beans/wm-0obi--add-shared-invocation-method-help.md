---
# wm-0obi
title: Add shared invocation method help
status: completed
type: task
priority: normal
created_at: 2026-09-27T19:09:12Z
updated_at: 2026-09-27T19:11:50Z
parent: wm-fgbj
---

Plan: add brief, reusable method-level guidance for keybind, WebSocket, and scenario rows on command reference pages and record how the real docs can source it.

- [x] Review invocation rows and decide shared copy/placement
- [x] Add method guidance to representative command pages
- [x] Update design spec and verify both pages show the guidance

## Findings

`docs/mockups/docs-experience.html:669-690,796-820` contains the two command-reference invocation tables. Directional Keybind already has a chord-specific note; workspace CLI has a command-specific note. Impact: replacing these with method help would erase useful context. Mitigation: keep the existing notes, add identical generic help to Keybind/WebSocket/Scenario rows on both pages, and place shared copy/link definitions at the method level in the design spec for generated pages. `docs/mockups/docs-experience.html:228` already styles block notes; stub links follow the mockup’s existing `data-stub` pattern.

## Summary of Changes

Added matching method-level notes and guide/reference links beneath Keybind, WebSocket, and Scenario invocation examples in both command pages (`docs/mockups/docs-experience.html`). Kept the directional chord note and workspace CLI note. Documented the shared-copy source for future generated reference pages in `docs/docs-experience-design.md`. Verified in Chrome that each method has the same readable note and link on both pages, and that none of the pages overflow at 375px, 833px, or 1121px. `git diff --check` passed.
