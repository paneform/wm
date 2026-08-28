---
# wm-xqwt
title: Bridge actual workspace display state
status: completed
type: bug
priority: high
created_at: 2026-08-28T04:47:42Z
updated_at: 2026-08-28T04:51:04Z
---

Change only the SketchyBar projection so workspace grouping reflects operational state, never preferred or pinned display policy. Resolve hidden workspaces from observed member frames against connected displays and use primary only when no physical placement is observable.

## Todo

- [x] Add failing bridge projection coverage for stale affinity and parked actual placement
- [x] Implement frame-based actual display resolution in the bridge only
- [x] Run focused and full relevant validation
- [x] Record behavior and complete the bean

## Behavior

`packages/node-host/src/sketchybar.ts` no longer reads `preferredDisplay` or `pinnedDisplayOverride` when grouping workspaces. It uses a connected `visibleOnDisplay` as authoritative current state. For hidden workspaces, it sums each member window frame intersection with each connected display and selects the largest observed area; this includes the visible strip of parked windows. A workspace with no observable member placement falls back to primary only so SketchyBar can render it.

## Validation

The new regression first failed because stale display policy placed T on Dell. It passes with the bridge-only implementation. Full `pnpm test` passed 291 engine, 23 renderer, 9 Swift sidecar, 14 platform-macos, and 46 node-host tests. Full `pnpm typecheck`, `pnpm build`, focused node-host tests/typecheck, and `git diff --check` passed. `pnpm lint` could not run because the workspace eslint executable is not installed.

Live projection of the current hidden T maps it to native display 1. The LaunchAgent was restarted to load the bridge, B was restored after startup selected workspace 1, wm is healthy, and the published bridge state retains T on display 1 while T is unfocused.

## Summary of Changes

Changed only the SketchyBar bridge projection and its node-host regression test. Workspace display output now represents visible or physically observed state and never display preference or pin policy.
