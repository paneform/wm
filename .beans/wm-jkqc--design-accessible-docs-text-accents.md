---
# wm-jkqc
title: Design accessible docs text accents
status: completed
type: task
priority: normal
created_at: 2026-09-24T23:47:58Z
updated_at: 2026-09-26T00:13:48Z
parent: wm-fgbj
---

Plan: choose a small set of docs text-accent roles from the existing palette; measure WCAG contrast against the backgrounds used in the mockup in both color schemes; add usable tokens and apply them to representative docs elements.

- [x] Inventory relevant text/background colors and choose restrained accent roles
- [x] Calculate and record contrast for both themes and surfaces
- [x] Add docs-only text accent tokens and use them in the mockup
- [x] Validate tokens and usage, then record a concise summary

## Findings

Record contrast pairs, impact, and mitigation here.

## Findings (color audit)

- `docs/mockups/docs-experience.html:13-25,60-83`: `--rp-muted` yields dark 3.42:1 and light 2.73:1 on the page, and dark `--rp-pine` / light `--rp-iris` also fall below 4.5:1 on the page. Impact: small notes, labels, and heading markers can be hard to read. Mitigation: introduce docs-specific text roles instead of using decorative palette values directly.
- `docs/mockups/docs-experience.html:143-148,203-245,439-488`: headings, table headers, and quiet notes lack shared color roles. Impact: theme variants and surfaces require one-off tuning. Mitigation: reserve violet for headings, with two neutral violet-grays for labels and quieter notes.
- Proposed foregrounds (page / surface / raised-overlay WCAG ratios): dark heading #aa9ac9 = 6.87 / 6.42 / 5.91, label #a09cb9 = 6.68 / 6.24 / 5.75, quiet #908caa = 5.48 / 5.12 / 4.71; light heading #675b81 = 5.67 / 5.96 / 5.17, label #5a5675 = 6.36 / 6.69 / 5.80, quiet #65617f = 5.39 / 5.66 / 4.91. Ratios computed from sRGB WCAG relative luminance against the three opaque palette backgrounds.

## Summary of Changes

Added three docs-only text roles to `docs/mockups/docs-experience.html`: section heading using rp-subtle, neutral label, and quieter neutral metadata/notes. Applied them to section and guide subheadings, table headers (including mobile labels), navigation group labels, breadcrumbs, notes, and terminal punctuation. Recorded color values, use cases, and the minimum WCAG ratio in `docs/docs-experience-design.md`. The label and quiet roles remain at or above 4.5:1; the revised large-heading role remains at or above 3:1 in both themes. `git diff --check` passed.

## Follow-up: try `--rp-subtle` headings

`docs/mockups/docs-experience.html:26,209-213` now uses `--rp-subtle` on the 20px semibold section headings. Impact: the light value reaches 3.67:1 against the raised overlay (4.02:1 on the page), which passes WCAG AA for large text but not normal text. Mitigation: the 16px guide subheadings at `docs/mockups/docs-experience.html:479` use the darker `--docs-text-quiet` instead (4.91:1 minimum on the raised overlay). `docs/docs-experience-design.md:98-125` records this distinction. Checked ratios and `git diff --check`.
