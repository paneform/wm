---
# wm-2zza
title: Establish docs mockup font-size tokens
status: completed
type: task
priority: normal
created_at: 2026-09-24T23:28:38Z
updated_at: 2026-09-24T23:43:06Z
parent: wm-fgbj
---

Plan: compare a blind six-step scale with the docs mockup, implement a small shared font-size scale, and validate the result.

- [x] Inventory docs typography and compare it with the blind proposal
- [x] Define size tokens and migrate docs font-size declarations
- [x] Run relevant checks and review the resulting diff

## Findings

Record observed sizes, impact, locations, and recommended adjustments here.

## Findings (inventory)

- `docs/mockups/docs-experience.html:110-246,433-497`: navigational, tabular, code, and even guide prose text are currently scattered across roughly 0.6–0.95rem (10–15px) with no stable roles. Impact: inconsistent hierarchy and small reading text. Mitigation: a docs-specific five-step scale (12/14/16/20/28px), with navigation/code/table text at 14px and prose at 16px.
- `docs/mockups/docs-experience.html:195-200,466-468`: title is about 27px, uppercase sections about 14px, and authored prose about 14px. Impact: the blind 24/32 heading steps would overstate the hierarchy; sections currently underserve scanning. Mitigation: 28px page title, 20px section heading, 16px guide subhead and copy.
- `docs/mockups/docs-experience.html:376-417`: 0.55–0.56rem labels are part of a miniature simulated desktop. Impact: enlarging them to reading sizes would distort the illustration. Mitigation: keep a dedicated illustration size outside the docs text scale.
- `docs/mockups/docs-experience.html:716,732,970`: inline font sizes bypass shared styles. Impact: hard to tune typography consistently. Mitigation: use a shared quiet-note class backed by the scale.

## Summary of Changes

Defined docs-specific 12/14/16/20/28px font-size tokens in `docs/mockups/docs-experience.html` and applied them to navigation, controls, prose, tables, code, and headings. Kept simulated desktop labels on a separate illustration token. Consolidated three inline note sizes into `.quiet-note` and recorded the scale in `docs/docs-experience-design.md`. Added a narrow-screen header adjustment and allowed the parameter bar to wrap. Verified all mockup font-size declarations reference tokens and checked computed layout at 375px, 500px, and 1280px in Chrome with no document-level horizontal overflow.
