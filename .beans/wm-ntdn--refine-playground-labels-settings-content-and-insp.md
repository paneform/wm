---
# wm-ntdn
title: Refine playground labels, Settings content, and inspector visibility
status: completed
type: feature
priority: normal
created_at: 2026-09-16T21:55:24Z
updated_at: 2026-09-16T22:10:05Z
---

## Plan

- [x] Default linked simulation labels/subtexts to empty, keep authored values and OS rules in shared scenarios, and avoid empty headings.
- [x] Render the shared hotkey content in playground Settings windows, including configured bindings.
- [x] Add persistent show/hide presentation control for selected-window settings; selecting or moving windows must not reopen a hidden inspector.
- [x] Add regression coverage and validate browser behavior, tests, lint, typecheck, and builds.

Preserve existing uncommitted linked-simulation work and unrelated signing/assets changes.

Browser validation passed from a blank playground: empty labels/subtexts and hidden empty headings; authored captions and per-side OS rules roundtrip; Settings default/custom/empty bindings and renamed bundle identification; inspector close retains selection and hidden preference across both-pane focus/move/resize, dropdown, reset, and share URL reload. Mobile at 390px has no horizontal overflow; no runtime errors.

## Summary of Changes

New linked environments start with empty labels/subtexts; empty headings are omitted and accessible names use left/right fallbacks. Authored text and per-side OS descriptors remain in shared scenarios. Existing legacy shared comparisons retain their authored branding. Settings windows now reuse the hero hotkey reference in the playground, including the next-display shortcut, custom configured bindings, explicit empty configurations, unsupported-binding notes, and bundle-based identification. Added Show/Hide window settings, backed by presentation.showWindowSettings: closing hides the inspector without clearing selection, and normal interaction never overrides that preference. Updated schema, generated schema, documentation, and regression tests.

Validation: 863 TypeScript tests plus 16 Swift tests passed across the workspace. Lint, typecheck, production builds, both format checks, and desktop/mobile browser checks passed. No console/runtime errors. Browser report: /var/folders/km/jth9jsgn24lfrsvvp9sjzrqr0000gn/T/opencode/inspector-refinement-validation/report.json. No commits or pushes performed.
