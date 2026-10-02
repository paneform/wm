---
# wm-6fhw
title: Fix per-display workspace window indicators
status: completed
type: bug
priority: normal
created_at: 2026-09-30T21:05:50Z
updated_at: 2026-09-30T21:24:42Z
---

Each workspace-app must represent a real scenario window exactly once across display bars. Display moves must transfer that indicator between bars even if the workspace name stays the same.

- [x] Project window indicator ownership to one display using live workspace assignments and deterministic hidden/stopped fallbacks.
- [x] Correct animation lookup for cross-display moves and remove unassociated workspace-app placeholders.
- [x] Test real scenario before/after ownership, DOM counts during animation and display-move playback; run relevant checks.

## Summary of Changes

Workspace app indicators are now projected from real windows to exactly one display. Live workspace assignments drive running-state ownership, with deterministic hidden-workspace and stopped-state fallbacks. Cross-display moves animate even when workspace membership is unchanged, and explicit-ID moves animate the actual target rather than only the focused window. Animation spacers use a separate placeholder class; moving markers carry the associated window ID.

Validation: six ownership tests cover real display-move scenarios and fallback behavior. Chrome checks verify counts and IDs before, during and after animation for next-display, named-display, focused-workspace and explicit-ID workspace moves. All 275 site tests, lint, typecheck, production build and git diff --check passed.
