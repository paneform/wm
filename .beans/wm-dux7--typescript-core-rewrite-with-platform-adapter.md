---
# wm-dux7
title: TypeScript core rewrite with platform adapter
status: in-progress
type: milestone
priority: normal
created_at: 2026-08-23T11:24:01Z
updated_at: 2026-08-28T19:18:56Z
---

Rebuild wm on a new architecture: portable TypeScript layout engine core using Effect.ts rules + probes, validated with Effect Schema; dumb macOS-specific adapter translating observations/events and commands; headless test suite covering known platform edge cases; TS CLI + WebSocket as thin wrappers over one command execution layer; web-based renderer for visualization/debugging of edge cases across multiple pseudo-displays.

- [x] Extract ground truth from Swift implementation and beans history
- [x] Write shared design docs (docs/rewrite/)
- [x] Scaffold pnpm workspace + package skeletons
- [x] Delegate: engine buildout agent
- [x] Delegate: test suite buildout agent
- [x] Delegate: macOS platform adapter agent
- [x] Delegate: web renderer agent
- [x] Integrate and validate full suite

## Summary of Changes

Rebuilt wm on branch rewrite/typescript-core as a pnpm workspace:
- docs/rewrite/*: six canonical design documents used by all build agents.
- packages/engine: full portable core implemented; 143 headless tests
  (139 passing; 4 skipped pending bean wm-n433 reconcile-hang fix).
- packages/platform-macos: Swift sidecar (swift build green, smoke script)
  plus Schema-validated TS host implementing the frozen PlatformAdapter.
- packages/node-host: JSONC config source with watcher, WebSocket server,
  Node clock, thin CLI (client verbs + serve mode); 10 tests green.
- packages/renderer: Vite web renderer running the real engine against a
  deterministic simulated multi-display platform; 23 tests green, vite
  production build clean.

Supervisor contract layer (schema/platform/world) frozen before parallel
buildout; integration fixes applied to parking discovery (sub-point
rejection thresholds, basis escalation, verify-with-nudge) and fake
platforms (per-axis continuous clamp model).

## Final merge checklist

- [x] Run full workspace tests
- [x] Run workspace lint and formatting checks
- [x] Run workspace typechecks and builds
- [ ] Fast-forward main to the validated TypeScript rewrite
- [ ] Confirm main points at the validated commit

## Final Validation

Validated on 2026-08-28 with pnpm test, pnpm lint, pnpm typecheck, pnpm build, and the engine formatting check. Fixed stale ESLint scripts by standardizing the remaining TypeScript packages on Oxlint and cleared all reported warnings before merge.
