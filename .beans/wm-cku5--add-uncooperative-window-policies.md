---
# wm-cku5
title: Add uncooperative window policies
status: completed
type: feature
priority: normal
created_at: 2026-08-15T21:12:51Z
updated_at: 2026-08-15T21:17:08Z
---

Implement greedy, stack, overlap, and reject handling for uncooperative windows; global defaults with per-workspace overrides; example/schema/docs; and global/per-workspace runtime commands.

## Plan

- [x] Add policy model and configuration precedence.
- [x] Implement greedy, stack, overlap, and reject layout behavior.
- [x] Add example config comments, schema, and documentation.
- [x] Add runtime global and workspace policy commands.
- [x] Add focused behavior, parser, protocol, and daemon tests.
- [x] Expose cooperation/minimum-size integration points without durable profile storage; run focused validation.

## Summary of Changes

Added greedy, stack, overlap, and reject policy models across configuration, workspace, protocol, API, and CLI layers. Configuration defaults to greedy with workspace overrides; runtime global and workspace overrides are session-only. Layout planning now accepts explicit minimum-size/cooperation data and daemon reconciliation uses the existing in-memory minimum-size observations. Added deterministic policy, configuration, protocol, CLI, and daemon-focused validation. Durable profile storage was intentionally not implemented.

## Limitations

Stack uses focused-window ordering in the plan and full-frame overlap; final macOS front ordering still depends on the existing focus path. Directional swap/front commands do not exist in the current architecture, so no new directional action surface was invented. Reject is enforced through existing verified reconciliation rollback; observer reconciliation skips rejected plans because it has no request failure channel.
