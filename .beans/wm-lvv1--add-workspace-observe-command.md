---
# wm-lvv1
title: Add workspace observe command
status: completed
type: feature
priority: normal
created_at: 2026-08-14T19:03:52Z
updated_at: 2026-08-14T19:06:53Z
---

Add `wm observe workspace NAME` and its daemon handler.

- [x] Trace existing command and handler conventions
- [x] Implement workspace observation command and handler
- [x] Add or update tests
- [x] Run relevant validation

## Summary of Changes

Added `wm observe workspace NAME`, the `observe.workspace` protocol method and daemon handler, workspace diagnostics output, unknown-workspace errors, and parser/protocol coverage. Verified with `swift test` and `git diff --check`.
