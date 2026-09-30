---
# wm-9vep
title: Simplify docs previews and add pre-play pause
status: completed
type: task
priority: normal
created_at: 2026-09-29T23:53:42Z
updated_at: 2026-09-29T23:57:21Z
---

Remove redundant manager-state and example-command labels from previews; pause one second before every animation.

- [x] Remove labels and keep concrete commands above previews, including grouped command forms.
- [x] Add a cancellable one-second hold before each animation and update browser checks.
- [x] Validate typecheck, lint, tests, build, and browser timing.

## Summary of Changes

Removed manager-state and example-command markup/styles from preview cards. Single and grouped concrete commands are rendered above the preview UI. Added a cancellable one-second hold before each playback starts, applying to initial playback, situation changes and repeats. Updated the Chrome check to assert labels are absent, commands remain above the UI, and playback waits at least one second.

Validation: all 261 site tests, lint, typecheck (including manifest contracts), production build and focused Chrome checks passed.
