# Implementation Status

Updated: 2026-08-14

## Complete Prototype Capabilities

- One Swift `wm` binary with daemon and WebSocket client modes
- Loopback WebSocket transport, strict envelopes, Origin allowlist, subscriptions,
  bounded replay, resync, and deterministic inventory diffs
- AppKit display inventory and joined Accessibility/Core Graphics window inventory
- Classification, health, raw diagnostics, join confidence, and rejection reasons
- Verified frame get/set with retained AX handles and bounded convergence strategies
- Workspace domain, BSP trees, validated atomic persistence, lifecycle invariants,
  move/focus/mode protocol, and verified platform reconciliation
- Offscreen workspace parking with topology-aware corner selection and verified
  clamped-edge acceptance
- Atomic parked-workspace restore, safe onscreen fallback, and session-retained
  window identity through temporary inventory omissions
- Command-time and event-driven frontmost-window resolution, including Cmd-Tab
  workspace following with outgoing-workspace parking
- Automatic inventory observation with additive membership reconciliation and
  immediate NSWorkspace activation observation
- Minimum-size feedback and BSP ratio adaptation for feasible layouts
- `wm observe window` diagnostics with PID, executable, app, and ID filters plus
  observed/expected/session/workspace/transition state
- Dependency-free geometry and workspace-layout executable verifiers

## Partial Or Prototype Semantics

- Workspace and inventory event streams are separate; workspace replay and one
  global sequence/state version are not implemented (`wm-akqf`).
- Infeasible BSP layouts currently use a safe full-frame stack fallback rather
  than floating the newest resistant window.
- Window disappearance is treated conservatively as a temporary omission; verified
  close removal and definitive handle eviction remain incomplete.
- External focus follows frontmost PID and retained main-window identity, but
  same-application exact-window and empty-workspace native focus need prototypes.
- Display inventory and topology-aware parking exist, but topology epochs,
  disconnect/reconnect migration, and affinity restoration do not.
- Workspace state is persisted atomically, but the full desired/operation/committed
  model and release migration are not.
- Health exposes source capability issues, but typed issue transitions, logging,
  `wm doctor`, and diagnostic bundles are not implemented.

## Open Implementation Backlog

### High Priority

- `wm-akqf` - Unify workspace event sequencing
- `wm-rx0g` - Implement configuration and rules
- `wm-z0gm` - Implement topology recovery
- `wm-79ol` - Implement multi-monitor workspaces (blocked by `wm-z0gm`)
- `wm-xtqc` - Implement session resynchronization
- `wm-fhn2` - Implement drift recovery
- `wm-qc7x` - Complete BSP commands
- `wm-i0qc` - Implement floating window behavior
- `wm-tkrr` - Implement permission readiness

### Normal Priority

- `wm-8bnl` - Implement lifecycle service management
- `wm-yxz4` - Implement health, logging, and diagnostics
- `wm-q8oe` - Complete persistence migration
- `wm-wwo6` - Implement pointer focus behavior
- `wm-hy4i` - Prototype mouse window intent
- `wm-ks5m` - Prototype native Space behavior
- `wm-lgfs` - Prototype focus edge cases
- `wm-y2w1` - Benchmark command latency

### Deferred Release

- `wm-93jn` - Ship signed release distribution

## Validation

- Swift 6.3.3 / Xcode 26.6 on Apple Silicon
- Current full suite: 46 XCTest tests and 89 Swift Testing tests
- `wm-geometry-fake-verify`: passing
- `wm-workspace-layout-verify`: passing
- Live single-display verification: hotkey workspace focus/move, Cmd-Tab workspace
  following, verified outgoing parking, parked-window reveal, and immediate app
  activation response

## Known Environment Findings

- `AXWindowNumber` is unavailable for the tested apps; session reliability uses
  retained AX elements confirmed by PID/role and CG ID when available.
- Screen Recording preflight is unavailable in the unsigned debug daemon although
  CG inventory still exposes useful owner/frame metadata.
- Spotify enforces an approximately 800-point minimum width.
- Public AX offscreen placement is clamped by macOS; accepted parking may retain a
  narrow edge strip, and adjacent-display topology must be considered.
