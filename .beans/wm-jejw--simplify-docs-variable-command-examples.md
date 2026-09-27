---
# wm-jejw
title: Simplify docs variable command examples
status: completed
type: task
priority: normal
created_at: 2026-09-26T00:30:58Z
updated_at: 2026-09-27T18:53:42Z
parent: wm-fgbj
---

Plan: show command placeholders as stable reference syntax and let demos run fixed, labeled examples without page-wide variable controls.

- [x] Inventory parameter-dependent markup, styles, and demo logic
- [x] Replace variable tabs/buttons with clear static syntax and example labels; remove unused state code
- [x] Update the docs design spec to match the simplified behavior
- [x] Validate mockup interactions and review changes

## Findings

Record any behavior or documentation mismatch discovered during the change.

## Findings (inventory)

`docs/mockups/docs-experience.html:183-205,595-607,697-730,761-768,832-863` has two page-wide tab strips and duplicate clickable argument values. `:1018-1048,1094-1152,1210-1266,1283-1469,1493-1503` couples all invocation syntax, captions, previews, and session creation to a mutable parameter state. Impact: open-ended workspace names look like a closed enum, and reference syntax changes when exploring demos. Mitigation: keep static placeholders in the table, put one clearly labeled command example above each stage, retain situation selection, and run fixed `left`/`writing` demo scenarios. `docs/docs-experience-design.md:154-159,214-223,291-364` describes the old behavior and must be revised.

## Summary of Changes

In `docs/mockups/docs-experience.html`, removed the sticky value tabs, duplicate argument buttons, invocation-template rewrites, geometry transforms, and parameter state. Invocation rows now show stable `<direction>` / `<workspace>` placeholders; the Arguments tables list values or explain open-ended names. The demo sections label one fixed example command (`left` or `writing`) while the situation previews remain the only demo selector. Updated `docs/docs-experience-design.md` to describe fixed examples, stable reference syntax, and URL selection by situation only. Browser-checked engine loading, static placeholders, no parameter controls, rendered previews, left-direction playback, workspace situation switching and playback; all passed. Searched for removed parameter wiring and ran `git diff --check`.
