---
# wm-84qn
title: Use semantic window references in demos
status: completed
type: task
priority: normal
created_at: 2026-09-30T00:25:29Z
updated_at: 2026-09-30T00:39:03Z
---

Make docs scenarios glanceable without displayed window names.

- [x] Replace app-specific titles, captions and manifest descriptions with focus/neighbor/target roles.
- [x] Use role-based sample IDs in explicit-window command examples and keep expectations consistent.
- [x] Format and validate scenarios, lint, typechecks, build and browser previews.

## Summary of Changes

Replaced app-specific scenario titles, captions, and manifest introductions with visible focus, neighbor, destination and parked-window roles. All scenario IDs and expectation references now use stable role-based names; explicit-ID example commands no longer reference unexplained editor/mail names. Added authoring guidance clarifying these are scenario IDs, not special live CLI selectors. Confirmed no legacy app-name references remain in docs scenario/manifest JSON or TypeScript.

Validation: all 35 scenarios and 261 site tests pass; lint, typechecks including manifest contracts, production build, focused Chrome preview/timing checks and git diff --check passed.
