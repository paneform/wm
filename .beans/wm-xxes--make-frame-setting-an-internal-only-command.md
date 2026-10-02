---
# wm-xxes
title: Make frame setting an internal-only command
status: completed
type: task
priority: normal
created_at: 2026-10-02T00:29:46Z
updated_at: 2026-10-02T00:52:49Z
---

Keep setWindowFrame available internally while removing it from the public command surface, like probeWindowLimits.

- [x] Remove public parsing, command docs/nav/demo and authoring references.
- [x] Reject frame-setting WebSocket requests while retaining engine support.
- [x] Verify CLI/keybind/scenario rejection and public catalog coverage; format and run relevant tests, lint, typechecks and builds.

## Progress

Removed frame setting from the shared public grammar, generated docs/navigation and scenario inventory; kept the internal engine command. Public WebSocket decoding now rejects both frame setting and limit probing. Focused parser/schema, host/wire, scenario and docs/navigation checks pass.

## Requested local deployment

User explicitly delegated build/restart/config migration to a subagent. Deployment bean wm-1gin completed: pnpm build, release Swift build and Developer ID-signed app packaging succeeded. com.paneform.wm restarted from /Users/allan/.local/libexec/wm/wm.app/Contents/MacOS/wm with PID 82139. Migrated 28 config command strings; all 61 keybindings parse, config validates, and service is healthy/running/unpaused. Backup: ~/.config/paneform/wm/config.jsonc.backup-20261002T0039Z.

## Summary of Changes

Made setWindowFrame internal-only alongside limit probing. Removed its public text grammar, generated documentation/navigation entry, demo registration and scenario file. The public WebSocket schema rejects frame-setting commands, while the internal command schema and engine operation remain available. Updated authoring/reference docs and regression expectations.

## Validation

All 1,019 TypeScript/Swift tests pass (486 layout, 150 layout-browser, 17 macOS TypeScript, 65 wm, 284 site, 17 Swift), along with root lint/typechecks, changed-file formatting and git diff --check. Production and release-native builds, signed packaging and live service/config validation passed under delegated deployment bean wm-1gin. Tests verify public text/keybind/scenario rejection, missing public nav entries and internal schema acceptance with public wire rejection.
