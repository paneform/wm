---
# wm-mmdz
title: Minimize carousel chrome and bound captions
status: completed
type: feature
priority: normal
created_at: 2026-09-30T16:57:00Z
updated_at: 2026-09-30T18:07:57Z
---

Remove carousel backgrounds/progress/footer controls in favor of subtle dots, with a wider active marker. Give captions a fixed two-line monospace area and enforce a maximum of twice the ch width on docs-only text.

- [x] Add shared caption width/limit and two-line wrapping validation; shorten current intros and captions to fit.
- [x] Simplify carousel chrome to dots and wire fixed caption layout to the shared width.
- [x] Validate content enforcement, desktop/mobile layout, dot navigation/autoplay, tests, lint, typecheck and build.

## Refinement

User feedback: restore per-item progress bars and visual treatment closer to the reference; tighten gaps/card widths and restore reliable autoplay. Pips should select/play rather than implicitly toggling autoplay.

- [x] Restore reference-like card surfaces/progress, tighten fixed card dimensions, and remove hover/focus autoplay suppression.
- [x] Verify active pips, all caption limits, desktop/mobile sizing and continuous autoplay before completion.

## Refined implementation

Cards now use the reference sunken/raised surfaces and 3px per-item progress bars. Their fixed width derives from 32ch caption width plus padding (~254px), with 4px gaps. The outer stage has no toolbar or background. Pips always select/play; hover and focus no longer inhibit autoplay. Escape is an explicit keyboard pause, and selecting an example resumes playback. Narrow browser checks verify actual progress filling, captions fitting, active pips and autoplay continuing with mouse/focus on the pips.

## Summary of Changes

Implemented a reference-like compact snapping carousel with fixed 240px-high cards, caption-derived width (~254px), 4px gaps, subtle theme-token surfaces, per-item progress bars and navigation pips. Removed the footer toolbar and outer background. Corrected autoplay so hover/focus and pip clicks do not stop the sequence; manual selection plays immediately and autoplay retains its one-second hold.

Captions now occupy a fixed two-line 32ch monospace area. One shared constant derives the 64-character budget; docs-specific loading and tests reject long text and text that would wrap to a third line. Current intros/results were shortened without clipping, and the authoring/design docs were updated.

Validation: all 35 scenarios and 269 site tests pass; lint, typechecks including manifest contracts, production build and git diff --check passed. Chrome checks cover 1–5 examples at desktop/375px/320px, fixed captions, active pips, animated progress fill, touch snapping, autoplay with hover/focus and manual/autoplay timing. Screenshots reviewed.
