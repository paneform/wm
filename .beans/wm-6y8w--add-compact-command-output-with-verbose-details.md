---
# wm-6y8w
title: Add compact command output with verbose details
status: completed
type: feature
priority: normal
created_at: 2026-10-01T18:41:11Z
updated_at: 2026-10-01T19:20:33Z
---

Simplify default CLI command output and add --verbose to preserve the full current output.

## Plan

- [x] Identify authoritative app names, current/assigned workspaces and current/assigned displays.
- [x] Add shared verbose parsing and typed compact output projections for query, mutation and permissions results.
- [x] Integrate CLI output, authoritative metadata and documentation.
- [x] Verify compact/verbose outputs, field semantics and CLI integration; format and run relevant tests, lint, typechecks and builds.

## Output decisions

Keep JSON output. Window lists show currentWorkspace once (focused workspace), plus id/title/appName/assignedWorkspace per window. Workspace lists show name, assignedDisplay (pinned override then preferred display), currentDisplay (visibleOnDisplay), and member windows as title/appName. Native appName exists in RawAXWindow but must be propagated through WindowValue, WindowObservation and snapshots. Listing metadata will be projected from the same committed world without extra native calls or additional RPC requests. Compact CLI output removes transport envelopes and diagnostics; --verbose keeps the full response/report. Errors retain actionable code/message. Permission summaries retain readiness and remediation guidance.

## Progress

Implemented compact JSON output and global --verbose parsing. Native app names now survive inventory normalization and live readback, and listing results include committed membership/current-workspace metadata and workspace window identities. Client-side formatting preserves full verbose responses and actionable errors. CLI permissions/service output and docs are updated. New output/real-WebSocket tests and engine listing metadata tests pass; native tests, typechecks, package lint and shell syntax checks pass. Full verification passed; see Validation below.

## Summary of Changes

Added compact default JSON output and a shared global --verbose presentation flag. Window lists expose the current focused workspace once, plus each window ID, title, app name and assigned workspace. Workspace lists expose name, assigned/current display and member title/app-name pairs, including floating members. State/display queries, mutations, validation and permission results now have useful summaries; errors retain actionable details. Verbose preserves complete response envelopes and reports. Service status hides launchd details by default and restores them with --verbose.

Propagated existing native app names through normalization, live readback and portable schemas. Listing membership and identity metadata is projected from one committed world, without extra RPC/native reads. Added a reusable client request/output boundary and migrated CLI printing. Updated command-interface documentation, command-page notes and the permissions example.

## Validation

All root tests passed: 484 layout, 150 layout-browser, 17 macOS TypeScript, 64 wm, 279 site and 17 Swift tests (1,011 total). pnpm lint, pnpm typecheck and pnpm build passed. Changed-file formatter checks, git diff --check and bash -n scripts/wm-service.sh passed. New tests cover requested output fields, unknown/unassigned values, display precedence/visibility, full verbose preservation, useful errors/remediation, global flag parsing, one-request WebSocket behavior and authoritative app-name/workspace metadata for tiled and floating windows.
