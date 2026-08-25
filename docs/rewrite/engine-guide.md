# Engine Guide

The engine is a deterministic pipeline over a World snapshot. It assumes NOTHING about
the host system: every behavior emerges from observations, probes, and learned evidence.

## Pipeline

```
PlatformEvent ─┐
               ├─► reconcile(): re-query adapter snapshots
snapshot poll ─┘        │
                        ▼
              normalize/join → WindowObservations (adapter did identity; engine classifies)
                        │
                        ▼
                   World snapshot (immutable; observations + desired state + profiles)
                        │
                        ▼
        rules: ordered list of Rule = { name, applies(world, window)?, effect(world) → Action[] }
                        │  (rules that don't apply emit nothing — this is normal)
                        ▼
                  Action plan (deduped, ordered)
                        │
                        ▼
        transaction executor: apply via PlatformAdapter primitives,
        readback-verify, classify, learn constraints, retry ladder,
        rollback best-effort on failure
                        │
                        ▼
          commit new World epoch + emit domain events
```

Core loop stays simple: **apply deterministic rules that may or may not apply to a given
window based on its observed capabilities and attributes.** Complexity lives in rules and
probes, never in hidden global logic.

## Actions (engine → executor)

`SetFrame{ windowId, frame }`, `SetPosition`, `FocusWindow`, `InsertWindow{ windowId,
workspace, beside?, axis? }`, `RemoveWindow`, `FloatWindow{ windowId }`,
`TileWindow{ windowId }`, `ParkWorkspace{ workspace }`, `RevealWorkspace{ workspace,
displayId }`, `AssignWorkspaceDisplay`, `LearnConstraints{ ... }`,
`EmitDiagnostic{ code, detail }`. All Schema-validated.

## Rules catalog (each in own file, evaluated in this order)

1. `ignore-system-surfaces.ts` — windows classified transient/system/uncertain are never
   managed (no geometry actions ever target them). Emits nothing; gates everything else.
2. `respect-pause.ts` — when `paused`, suppress all geometry/parking/focus actions.
3. `prune-dead-membership.ts` — remove closed/destroyed windows from membership + BSP;
   collapse parent node promoting sibling subtree.
4. `restore-membership.ts` — known replacement identities restore prior workspace
   membership (sleep/wake/inventory loss). Highest placement precedence.
5. `assign-new-windows.ts` — placement precedence for unassigned managed windows:
   configured affinity matcher → focused workspace → workspace "1" only if nothing
   focused/visible. Detection alone must NOT change the focused workspace.
   Pre-insertion preflight: compute intended frame WITHOUT mutating committed state,
   apply+verify on the window first, insert into tree only after verification succeeds;
   on preflight failure keep window quarantined (unmanaged) for retry.
6. `transient-follows-parent.ts` — dialogs/sheets float in parent's workspace (else
   focused); stationary — never parked or tiled.
7. `tile-workspaces.ts` — for each visible workspace in BSP mode with members: compute
   constraint-aware BSP frames (see layout math), emit SetFrame per member.
8. `clamp-to-capabilities.ts` — before executing SetFrame: intersect request with known/
   viable learned min/max constraints. If no feasible frame exists for a tiled window,
   float it and emit degradation diagnostic instead.
9. `park-invisible-workspaces.ts` — windows of non-visible workspaces go to measured
   offscreen corner slots (see parking).
10. `reveal-focused-workspace.ts` — ensure focused workspace's display shows it; moving
    a workspace to another display parks the destination's previous workspace and keeps
    the moved one focused.
11. `recover-lost-windows.ts` — managed window whose frame doesn't sufficiently intersect
    any active work area (and isn't intended-parked) is recovered through its assigned
    workspace layout.
12. `reconcile-drift.ts` — observed frames disagreeing with committed intent (beyond
    attribution) trigger bounded repair via the same transaction path as commands.

## Probes

Probing = issuing primitive writes ±1 pt from current frame and observing outcomes.

**Capability probe** (per dimension: x−, x+, y−, y+, w−, w+, h−, h+):
validate identity → write component → readback settle at 0.25 pt tolerance → record
`changed / matchedRequest / crossChanged` (did the other component move?). Supported
requires all three true. Cross-change or changed-but-unmatched ⇒ inconclusive. All four
size dims rejected ⇒ resizable = `fixed` (confirmed). No observable change ⇒ inconclusive
both. Restore each touched component afterwards (verify restoration within 0.25 pt;
abort probing if restoration fails). Identity must be validated around EVERY write — a
replacement window behind the same handle aborts before mutating the replacement.

**Constraint probe / learning** (from ordinary writes AND dedicated probes):
- Learn only from `constrained` or `stableClamp` outcomes. Never from `progressing`.
- Direction: observed > requested ⇒ minimum candidate; < ⇒ maximum candidate (per axis).
- **Work-area flush guard:** observation edge within 2 pt of work-area edge is NOT
  learnable (that's the OS clamping into bounds, not an app limit). This was a real bug:
  bean wm-45sa.
- **Initial-frame guard:** stable clamp where observed equals the untouched initial frame
  (> tolerance difference required from BOTH requested and initial) is not learnable —
  "window didn't move" is not a minimum size.
- Promotion: 3 consistent samples within ±1 pt ⇒ learned bound. Learned min =
  max(existing, candidate); max = min(existing, candidate). Exact observation contradicting
  a learned bound replaces it (bounds can be wrong after OS updates).
- Context-partition profiles by app version + topology fingerprint; constraints learned
  under one topology do NOT verify under another.
- Viability check before layout use: min bound usable iff liveObserved + 1 < bound;
  max iff liveObserved − 1 > bound.

## Geometry transactions & retry ladder

Write strategies tried in order: `positionSize`, `sizeOnly`, `sizePositionSize`,
`convergedSizePositionSize` (the double size bookend exists because many apps re-anchor
their origin when resized — see Swift tests "window reanchors"). Default budget 3
attempts (config range 1–5). Escalate strategy on failure; skip ahead when profile says
the app needs corrective fallbacks (`correctiveAttemptCount > 1`). If mid-animation
(`progressing`) when budget exhausts, report progressing honestly — never clobber a
window animating toward target. On multi-window tiling failure, roll back already-moved
windows in reverse order best-effort, then surface the error.

Acceptance for tiling results: within content rect ±1 pt OR center inside content.
Constrained-but-contained results are success. Otherwise learn, mark cooperation, replan
(bounded by memberCount + 1 replans).

## Parking

macOS refuses fully-offscreen windows, so park at a display corner leaving a measured
sliver visible (~1 pt horizontal, ~52 pt vertical, probed per display+corner):

1. Corner priority: bottomLeft, bottomRight, topLeft, topRight. Target math:
   left corners `x = display.x − width + limits.horizontal`; right corners
   `x = display.maxX − limits.horizontal`; top `y = display.y − height +
   limits.vertical`; bottom `y = display.maxY − limits.vertical`.
2. Feasibility: target must have ZERO-area intersection (edge-touch allowed, ≥1 pt
   overlap rejected) with every OTHER display frame. Side-by-side displays allow only
   outward corners; a fully surrounded display has none.
3. Clamp discovery probe (when limits unknown): request the fully-offscreen endpoint;
   observe which axes clamp. Fractional clamps round toward the visible side. Refine the
   clamped axis ONLY (hold the other coordinate fixed at the accepted value — orthogonal
   movement during a search is rejection evidence, not inconclusive; bean wm-ysdj lesson).
   Binary-search boundary with budget `2·(⌈log2(maxDistance)⌉+3)+2` probes; verify final
   combined point jointly once. Persist facts per display+corner keyed by fingerprint of
   that display's own geometry (+OS version) — neighbor changes never invalidate them.
4. Probe discipline: any hidden position-capable window may serve; an already-parked
   off-display window is a PREFERRED seed (stale-probe starvation bug: beans wm-fh5i,
   wm-6aea). Iterate candidates on failure; never starve because the first candidate was
   already parked. Restore probes to their saved restore frame afterwards (fallback:
   anchor at work-area center, then retry original).
5. Parked intent is durable state (`workspace.parkedFrames[windowId]`), NEVER inferred
   from magic coordinates alone. Startup/audits compare intent vs observation and repair.
6. Tiled windows park via size→position→size; floating via position-only.

## Public API surface (`@wm/engine`)

Frozen contract — node-host, platform-macos, renderer, and tests compile against this.

```ts
// from schema.ts / platform.ts / world.ts (contract layer, written by the supervisor):
export * from "./schema.js";      // all domain schemas + inferred types
export * from "./platform.js";    // PlatformAdapter, PlatformEvent, WriteObservation...
export * from "./world.js";       // World, WorkspaceState, ProfileStore, ParkingFact

// engine.ts:
createEngine(options: {
  adapter: PlatformAdapter;
  configSource: ConfigSource;
  clock: Clock;                    // { now(): number; sleep(ms): Effect<void> }
  random?: Random                  // seeded, optional
}): Effect<Engine>

interface Engine {
  // lifecycle
  start(): Effect<void>            // initial reconcile + rule pass
  stop(): Effect<void>
  // command execution (CLI/WS/renderer all use this)
  execute(command: Command): Effect<CommandResult, CommandError>
  // committed state snapshot (queries never do platform I/O)
  state(): Effect<StateSnapshot>
  // domain events (seq-numbered, bounded replay)
  events(): Stream<DomainEvent>
}
```

`StateSnapshot` = user-facing committed view: topology, managed windows with
workspace/mode/frame/capabilities, workspaces with membership+trees+visibility,
focused workspace, health, pending transaction metadata, paused flag.

## Config

JSONC config, Schema-validated, unknown fields are errors. Global defaults inherited
field-by-field by workspace settings: name, preferred display, mode (bsp|floating),
margins, gap, resize increment, initial assignment matchers. Hotload = delta reload
(validated fully before atomic swap; invalid hotload keeps prior config + health event).
Explicit reload = full rebuild preserving runtime overlay. Engine defines the schema +
`ConfigSource` interface (`load(): Effect<Config>`, `changes(): Stream<void>`); the node
host implements file loading/watching.

## Command execution layer (single source of truth)

One `CommandBus` executes validated Commands against committed state via the transaction
queue: serialized FIFO, idempotent-command coalescing, suspicious-repeat escalation
(≥3 repeats ⇒ full reconciliation before execute), recovery mode queues submissions,
15 s timeout, pendingLimit 256, historyLimit 512, batches ≤64 stop-on-first-failure.
CLI, WebSocket server, and renderer ALL call this same layer. Queries return last
committed state plus pending metadata — queries never wait on platform I/O.
## Explicit dimension-limit diagnostic

`probeWindowLimits` requires a managed window parked for an invisible workspace,
identified by its durable `parkedFrames` intent and a current connected-display
parking fact. This is the supported least-disruptive target: the diagnostic does
not reveal its workspace or focus the window. Hidden, minimized, fullscreen, or
ambiguously attributed parked windows are rejected; there is no visible fallback.

The explicit sequence is behavioral capabilities, adopted/verified parking,
minimum size, maximum size, then exact restoration. The probe holds the engine's
exclusive command/reconciliation gate and captures the canonical identity and
exact physical frame. Every parked trial recomputes `cornerTarget` from the
requested size and original retained horizontal/vertical sliver. If a requested
dimension is smaller than that sliver, the deterministic impossible-case policy
retains that entire dimension at the same corner. After an application size clamp or reanchor, a
position-only correction recomputes the corner target from the observed size.
A stable position/work-area clamp is recorded separately and does not invalidate
size evidence when dimensions remain stable, actual retained visibility stays
positive at the same corner, and no other display has positive overlap. Onscreen
movement, a different corner/display, cross-dimension changes, or unsafe overlap
aborts the diagnostic and is never treated as size evidence.
Minimum requests use one point. Acceptance at one point is reported as
`noClampDownTo` and does not publish a minimum constraint; only a stable clamp
above one point is an exact, publishable minimum. Maximum requests stop at the largest connected
display work-area width or height; exact acceptance there is `noClampThrough`, not an
unbounded maximum. Any observation below that endpoint, including a one-point
clamp, is an exact maximum.

Every write is bracketed by identity-validated reads and deterministic adapter
settling. The untouched dimensions and position come from the captured frame,
and the complete original frame is restored and verified after every sample.
Any failed exact restore makes the command fail and suppresses all findings and
profile updates. An operation-wide uninterruptible finalizer repeats the guarded
exact restore after interruption or an unexpected defect once mutation may have
started. Durable parked intent is not mutated. After every sample and
the final exact restore succeed, exact bounds atomically replace the topology-
partitioned profile constraints used by subsequent layout planning.

Guarded writes bind both the canonical window ID (the sidecar's CG/AX mapping)
and the expected pid/role/subrole fingerprint. This is the strongest local
contract available without broad adapter redesign. A same-fingerprint AX-only
incarnation that reuses the canonical ID and cannot be distinguished by the
sidecar remains a platform-level residual risk.
