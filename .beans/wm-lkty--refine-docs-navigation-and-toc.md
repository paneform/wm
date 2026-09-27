---
# wm-lkty
title: Refine docs navigation and TOC
status: completed
type: task
priority: normal
created_at: 2026-09-27T20:15:27Z
updated_at: 2026-09-27T21:17:27Z
parent: wm-fgbj
---

Plan: review Cloudflare reference and the mockup navigation; add a scroll-driven on-this-page progress indicator with heading-depth indentation; remove the active sidebar border; link the lockup and docs label to their destinations; verify behavior at multiple widths.

- [x] Inspect reference and current heading/TOC markup
- [x] Implement progress, heading hierarchy, sidebar and header navigation
- [x] Verify links, TOC nesting and scroll progress; update design spec

## Findings

- Cloudflare reference uses a narrow TOC track/progress stroke; the mockup currently has only a static `border-left` (`docs/mockups/docs-experience.html:172-176`). Impact: no reading-progress cue. Mitigation: add a CSS root-scroll-driven fill over the existing track, with a reduced-motion fallback.
- `docs/mockups/docs-experience.html:1146-1160,1401-1420`: TOC lists are hand-maintained and include only H2 IDs; guide headings are H3 without IDs, and the guide TOC is empty. Impact: nested indentation cannot show real hierarchy. Mitigation: render TOC from active view H2/H3 headings with IDs, indent H3, and give the guide a parent H2 and child H3 anchors.
- `docs/mockups/docs-experience.html:159-168,516-520`: active sidebar uses a colored left border, header lockup and docs text are non-links. Impact: mismatch with requested navigation. Mitigation: remove active left border; give logo and docs distinct hrefs. Mobile header previously hid the docs suffix to make room for search, so stack the docs link below the logo at narrow widths.

## Summary of Changes

`docs/mockups/docs-experience.html` now links the SVG lockup to `/wm` and its docs label to `/wm/docs` (stacked on mobile), removes the active sidebar left border, generates the TOC from active H2/H3 anchors, and indents nested guide headings. The TOC rail uses CSS `scroll(root block)` for a progress fill, with reduced-motion fallback. Added anchored guide sections to show nested navigation and documented this behavior in `docs/docs-experience-design.md`. In Chrome at 1280px/600px the progress indicator reached 0%, 50%, and 100% scale at the start, midpoint, and end of the document. Verified links, nesting, sidebar styling, and no horizontal overflow at 320px, 375px, and 1280px. `git diff --check` passed.

## Follow-up: visible current section

Plan: highlight the heading currently being read in the TOC, keep the CSS-driven progress rail, and verify active state while scrolling and switching views.

- [x] Add a clear current-heading treatment and track it through scrolling
- [x] Verify command and Installation guide TOCs, then update design notes

Finding: `docs/mockups/docs-experience.html:172-190,1418-1440` has scroll progress but no active-link emphasis; at the top the progress line is empty, so the reader sees no indication. Impact: unclear current location. Mitigation: mark the active heading in the rail with visible text/background emphasis and `aria-current="location"`.

### Follow-up result

The TOC now highlights the current section with a stronger label and 3px marker, and `aria-current="location"`, including at scroll position zero. A throttled scroll handler selects the last heading reaching the reading area; the progress line remains native CSS scroll-driven. Added this behavior to `docs/docs-experience-design.md`. Browser-verified the initial See it work state, Invocation after scrolling, and Setup steps / nested Grant permissions on the Installation guide page (linked under Getting started in the left sidebar). `git diff --check` passed.

### Follow-up: reduce rail emphasis

Removed the current-link background and its unused rounded corner from `docs/mockups/docs-experience.html`; the stronger text and position marker remain. Updated the matching description in `docs/docs-experience-design.md` and checked that the background rule is gone.

## Follow-up: connected nested TOC rail

Plan: replace the straight pseudo-element track and per-row marker with one shaped SVG path following H2/H3 offsets. Animate the active path segment along the track when the current section changes, keep the CSS scroll-driven progress stroke, and verify geometry/progress/movement on the Installation guide and command pages.

- [x] Build a connected indented rail matching heading depth
- [x] Animate active segment along the path while preserving scroll progress
- [x] Verify both views, responsive sizing, and reduced-motion behavior; update design spec

Finding: `docs/mockups/docs-experience.html:175-201` currently draws a straight progress pseudo-element and an independent active marker. Impact: nesting and active movement do not visually connect. Mitigation: reuse one SVG path for track, scroll-progress, and sliding active stroke.

### Connected rail result

Replaced the straight TOC border and detached active marker with an SVG track following a single path that jogs inward for H3 rows. Its progress stroke still uses a native root-scroll CSS timeline; a short active stroke shares the path and animates `stroke-dashoffset` between sections. TOC geometry is recomputed on view and width changes. The design spec now describes the connected rail. Chrome checks confirmed the command TOC path stays straight, the Installation guide path bends, the active dash travels from the parent into the nested path, the progress dash advances with scroll, resizing from hidden to visible regenerates the path, reduced motion turns off both animations, and no horizontal overflow appears at desktop width. `git diff --check` passed.

## Follow-up: vertical-only selected segment

Plan: keep the connected bent track/progress, but clamp each settled active segment to the straight portion beside its section. Verify the first nested entry and the last nested entry before an outdent; keep animation along the full path between selections.

- [x] Derive bend endpoints and clip selected segment to the current vertical run
- [x] Verify active segments, progress, transitions, and reduced-motion behavior

Finding: `docs/mockups/docs-experience.html:1450-1467` currently derives the active stroke from each `li` top/bottom. Those spans can overlap a bend at indentation changes, so the selected stroke colors the connecting diagonal. Impact: the rail reads as if the indentation change itself is selected. Mitigation: use bend endpoints as caps for the settled active stroke, leaving the track and progress stroke continuous.

### Vertical-only segment result

`docs/mockups/docs-experience.html` now shares one bend calculation between SVG path construction and active-segment clipping. The settled active dash is trimmed to the straight vertical span next to its TOC item, while the gray track and CSS scroll-progress stroke retain their diagonal connections. The active dash still transitions along the connected path to a new item. Updated `docs/docs-experience-design.md` to specify this treatment. In Chrome, checked start/end path coordinates for the parent and all nested Installation entries, plus a simulated nested-to-parent outdent; all selected segments have constant X at the expected indentation. Verified movement, scroll progress, reduced motion, command-page straight rail, and no overflow. `git diff --check` passed.
