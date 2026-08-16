---
# wm-qc7x
title: Complete BSP commands
status: in-progress
type: feature
priority: high
created_at: 2026-08-14T18:59:07Z
updated_at: 2026-08-16T06:51:09Z
---

Scope: remaining BSP algorithms and command surface.

Acceptance:
- Implement cycle and directional focus.
- Prototype/fix directional move semantics.
- Implement keyboard resize at nearest controlling split with ratio clamping.
- Split new leaves along the target tile longest dimension.
- Float newest infeasible window and emit degradation instead of stacking fallback.
- Add focus/move/resize/tree/property tests.

## Directional focus and move plan

- [x] Specify directional protocol, CLI, errors, focus verification, and deterministic BSP movement semantics.
- [x] Implement workspace-domain directional target selection and atomic BSP rearrangement.
- [x] Integrate transactional daemon focus/raise verification, retile, persistence, and events.
- [x] Add protocol, parser/help, domain, daemon, and failure-atomicity tests.
- [x] Update API/user docs and feature spec.
- [x] Run focused tests.
- [x] Full validation.

## Implementation status

Implemented `wm window focus DIRECTION` and `wm window move DIRECTION` with protocol DTOs, spatial BSP domain mutations, verified daemon effects, atomic persistence/events, explicit edge/floating/focus errors, tests, and docs. Focused WMWorkspace, WMProtocol, WMCLI, and WMDaemon suites pass. Full validation remains intentionally unchecked for user review.

## Directional Commands Validation

- `swift test`: 69 XCTest and 156 Swift Testing cases passed.
- `swift build` and `git diff --check` passed.
- Restarted the final daemon binary and reloaded SKHD.
- Live `M` workspace focus left/right and move left/right commands all committed with `effect_status: verified`; paired moves restored the original BSP arrangement.
- Added SKHD bindings in `~/.config/skhd/skhdrc`: `rshift-hjkl` focuses and `lshift+rshift-hjkl` moves.

Directional focus and move are complete. This broader bean remains in progress because keyboard resize, longest-dimension insertion, and infeasible-window degradation acceptance items are still outstanding.
