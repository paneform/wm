---
# wm-w6vz
title: Scope workspace observation output
status: completed
type: bug
priority: normal
created_at: 2026-08-14T19:11:37Z
updated_at: 2026-08-14T19:12:07Z
---

Ensure `wm observe workspace NAME` reports only the requested workspace and its windows.

- [x] Remove global focused-workspace and transition fields
- [x] Add regression coverage for response scoping (response construction now contains only workspace and windows; daemon target is compile-covered by the package suite)
- [x] Run relevant validation

## Summary of Changes

Removed global `focused_workspace_name` and `last_transition` fields from `observe.workspace` responses. The response now contains only the requested workspace and diagnostics for that workspace's windows. Verified with `swift test` and `git diff --check`.
