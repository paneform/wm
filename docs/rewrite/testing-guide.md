# Testing Guide

Portable package tests run headlessly in Vitest. `pnpm -r test` also builds and tests the
thin Swift native host; those tests require macOS but do not mutate managed windows.
Engine platform behavior is emulated by fakes implementing
`docs/rewrite/platform-contract.md`.

## Fake platform (`packages/layout/test/helpers/fake-platform.ts`)

A deterministic simulator with scripted per-window "app personalities". Owned by the
TEST agent. It must emulate these documented macOS behaviors (from ground truth +
beans history):

1. **Min/max rejection:** window refuses sizes below min / above max by clamping to the
   bound and reporting the clamped frame as `observed` (not an error).
2. **Work-area clamping:** OS pulls frames back inside the display's work area when
   requested position would push them out; observed frame reports the clamp.
3. **Offscreen refusal:** a window moved fully offscreen clamps to leave ~1 pt visible
   horizontally, ~52 pt vertically at the nearest corner (per-display configurable).
4. **Reanchoring apps:** some personalities move their origin when resized — a
   size-then-position write ends with position wrong unless size is re-applied after
   (validates the convergedSizePositionSize ladder).
5. **Animated settling:** personality that interpolates over several polls toward its
   target (validates `progressing` classification and settle polling; never clobbered).
6. **Fixed-size windows** (e.g. System Settings-like): all four size nudges rejected,
   position honored ⇒ engine must conclude resizable=fixed and float it.
7. **Unmovable windows:** AX reports movable=false AND behavioral nudges do nothing ⇒
   unmanaged/inconclusive handling.
8. **Identity replacement:** mid-transaction the fake swaps the backing element behind
   the same handle; writes must abort with stale rather than mutate the replacement.
9. **Topology churn:** scripted display connect/disconnect sequences with intermediate
   contradictory snapshots; work areas shift; parked corners change feasibility.
10. **Stale constraint contradiction:** learned min becomes false (simulated app update);
    exact observations must replace the learned bound.

The fake is deterministic: seeded RNG only, time via injected Clock, no real timers.

## Test matrix

The current suites cover these behaviors:

### Geometry (`test/geometry.spec.ts`)
- Exact write within tolerance succeeds; beyond tolerance fails with observed frame.
- Position-only write preserves size; verifies Δpos ≤1, Δsize ≤1; cross-component drift
  fails verification.
- Retry ladder escalation across attempts; profile-informed early skip when corrective
  attempts known >1.
- Constrained outcome accepted when it matches KNOWN learned bound; rejected otherwise.
- Progressing outcome reported (not failed) while animating toward target.
- Invalid input rejected before any platform call: NaN/negative dims, attempts outside
  1–5, tolerance outside 0–20.
- Fit-to-bounds: anchor fallback accepts contained-but-clamped results (tolerance 20).

### Constraint learning (`test/learning.spec.ts`)
- 3 consistent clamp samples promote to bound; 2 don't.
- Work-area-flushing clamps never learn (the wm-45sa bug): observation flush with any
  work-area edge ±2 pt is recorded but not promoted.
- Initial-frame-equal stable clamps don't learn.
- Learned bounds tighten monotonically (min takes max, max takes min).
- Exact observation contradicting a learned bound replaces it and resets pending.
- Topology-partitioned profiles: constraint from topology A doesn't verify under B.
- Viability margins: stale bounds ignored when live window contradicts them.

### BSP layout (`test/bsp.spec.ts`)
- Insertion splits most-recent-focused leaf along longest dimension (square ⇒ vertical);
  existing stays left/top; new goes right/bottom; ratio 0.5.
- Removal promotes sibling subtree wholesale preserving nested ratios.
- Preferred length = floor(available · ratio); second pane offset += gap; shared edges
  rounded once deterministically (no cumulative seams).
- Min-size-aware solve: 1512-wide content, gap 8, ratio 0.5, one window minWidth 800 ⇒
  exactly [704, 800] split at x=808.
- Surplus above a maximum flows to the peer (723/781 case).
- Subtree aggregates: minimums sum along axis (+gap); maximum sums only if BOTH sides
  bounded, else nil/unbounded.
- Policy chain greedy→overlap→stack→overflow; floating members excluded from feasibility;
  reject terminal policy yields rejected plan.
- Duplicate ids in tree resolve first-wins; NaN ratios rejected by validation.
- Mode switch never rebuilds tree; reconciliation moves externally-moved members to
  floating membership.

### Parking (`test/parking.spec.ts`)
- Corner target math for all four corners incl. negative-coordinate displays (display
  above/left of primary).
- Feasibility: zero-area intersection rule — edge touch OK, ≥1 pt overlap rejected;
  side-by-side displays allow outward corners only; surrounded display has none.
- Clamp discovery: fractional clamps round toward visible side; orthogonal-axis movement
  during search = rejection evidence (wm-ysdj lesson), not inconclusive.
- Binary-search budget respected; final joint point verified once.
- Parked-seed preference: already-parked off-display candidate is preferred seed;
  candidate iteration on failure (stale-probe starvation regression test, beans
  wm-fh5i/wm-6aea).
- Facts fingerprinted per display-local geometry; neighbor connect/disconnect does NOT
  invalidate; own-geometry change DOES.
- Probe restoration verified; restore failure falls back to work-area-center anchor then
  original retry.

### Transactions (`test/transactions.spec.ts`)
- Serialized FIFO execution; idempotent coalescing shares one execution+receipt.
- Suspicious repeat ≥3 escalates to reconciliation hook before executing.
- Recovery mode queues submissions FIFO, releases on success/fails structured.
- 15 s timeout cancels operate, subsequent work unaffected.
- Pending limit 256 → queue_full; batch ≤64 stops on first failure; rollback of
  already-applied steps in reverse order on multi-window failure.
- Internal errors sanitized to generic message; detail routed to diagnostics.

### Engine pipeline (`test/engine.spec.ts`)
- New-window placement precedence: affinity matcher > focused workspace > workspace 1;
  detection never changes focus.
- Preflight quarantine: fixed-size new window is NOT inserted into tree (verified-first
  ordering) and stays unmanaged pending retry.
- Transient windows follow parent workspace, stay stationary through park/reveal cycles.
- Workspace reveal parks previous workspace atomically; cross-display move keeps moved
  workspace focused; destination's previous workspace parked.
- Display disconnect migrates stranded workspaces to a connected display (bean wm-dm8l),
  retargets pinned assignments, reapplies destination display config overrides.
- Wake resync rebuilds observations and repairs drifted parked/visible state.
- Pause suppresses mutations but continues observation; resume triggers full rebuild.
- Lost-window recovery reinserts managed window via its assigned workspace layout.
- Drift reconciliation repairs unattributed divergence with bounded retries.

### Schema validation (`test/schema.spec.ts`)
- Every boundary type rejects invalid data: non-finite numbers, negative dims, unknown
  discriminators, malformed ids. Wire messages round-trip encode/decode.

### Config (`test/config.spec.ts`)
- JSONC parse, schema validation, unknown-field errors, field-by-field inheritance,
  delta hotload atomicity (invalid candidate keeps prior), full reload preserving runtime
  overlay, populated-workspace removal preserves runtime state.

### Command bus / wire (`test/commands.spec.ts`, `test/wire.spec.ts`)
- CLI verbs ↔ CommandBus parity; queries served from committed snapshots without I/O.
- WebSocket message schemas validate; snapshot-on-subscribe; replay buffer semantics.

## Standards

- Deterministic: injected Clock/RNG everywhere. No real sleeps in tests (fake settles in
  microtasks or virtual ticks).
- Property tests use randomized oracles (parking binary search vs exhaustive
  oracle; clamp discovery vs monotone boundary oracle) using fast-check with seeds.
- Every regression bug from beans history gets a named test referencing the bean id.
- Coverage target: every documented constant/threshold exercised by at least one test.
