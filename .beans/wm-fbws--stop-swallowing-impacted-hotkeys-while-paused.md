---
# wm-fbws
title: Stop swallowing impacted hotkeys while paused
status: completed
type: bug
priority: high
created_at: 2026-09-02T21:56:01Z
updated_at: 2026-09-02T22:11:32Z
---

Adjust native hotkey handling so paused wm releases every configured hotkey except the unpause/toggle-pause binding, which must continue to execute and be swallowed.

Plan:
- [x] Inspect native key monitor, hotkey configuration, and pause-state synchronization.
- [x] Define paused hotkey swallow policy and add regression tests.
- [x] Implement the smallest correct change.
- [x] Run focused tests, then full project validation.
- [x] Record the result and close the bean.


Architecture decision:
- The layout engine remains the source of truth for paused state.
- The macOS adapter exposes an explicit hotkey-swallowing control to the native host.
- While paused, the native host forwards all configured hotkeys without swallowing them except the configured pause-toggle/unpause action, which remains forwarded and swallowed.
- [x] Add the adapter/native control and synchronize it from pause events.
- [x] Add pause behavior documentation and a design-decision entry.

## Summary of Changes

- Added an engine-to-native `setHotkeySwallowing` control and synchronized it at startup and pause transitions.
- Kept all matched keybind actions flowing to the engine; only configured `togglePause` and `resume` chords remain swallowed while paused.
- Added Swift, adapter, and engine regression coverage plus pause and design-decision documentation.
- Validation passed: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, and Swift sidecar tests.
