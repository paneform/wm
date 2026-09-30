---
# wm-fjnu
title: Add scenario playback start boundary
status: completed
type: feature
priority: normal
created_at: 2026-09-29T22:10:16Z
updated_at: 2026-09-29T22:25:04Z
---

Support optional playback:start on a scenario step. Earlier steps execute and validate before a session is ready; absent marker starts at step zero.

## Plan

- [x] Add schema validation, shared playback helpers, and runner preparation with expectation failures and cleanup.
- [x] Update playground/editor and docs consumers to preserve preparation during playback, reset, editing, and sharing.
- [x] Move docs reconciliation and starting-state expectations into scenario files.
- [x] Add regression tests, regenerate schema, update format docs, and run relevant tests, lint, typechecks, and builds.

## Summary of Changes

Added optional playback:start metadata on command/event steps, rejecting duplicate markers. Session creation executes and validates the preparation prefix and disposes the session on failure; unmarked documents retain their initial behavior. Shared helpers expose the original start index and playable suffix. Playground counts, rail, seek/reset, recording, editor boundaries and hero playback now use that suffix while preserving the full document for export and sharing. Docs reconciliation now lives in each scenario with before/after expectations, and individual automated tests run complete demos. Regenerated JSON Schema and documented the contract.

## Validation

- Layout-browser: 150 tests, lint, typecheck and production build passed.
- Site: 223 tests, lint, svelte-check (no errors/warnings) and production build passed.
- Focused Chrome check passed: prepared state on load, one-step rail, seek, reset, playback, recording after preparation with boundary transfer, and boundary editing/reinitialization.
- git diff --check passed.
