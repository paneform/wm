# Domain Schema & Constants

Source of truth for all types. Implemented with Effect Schema (`effect/Schema`) in
`packages/engine/src/schema.ts`. Names below are canonical; agents must use them exactly.

## Coordinates

One canonical OS space: **top-left origin of the primary display, y-axis down**.
Windows and displays are both observed and commanded in this space. Displays above or
left of the primary legitimately have negative origins. All math is integer points
(round once, at shared boundaries, deterministically: `Math.floor(available * ratio)`).

Engine-local layout space is optional sugar: origin = work-area top-left of a specific
display. Projection = translate by that origin. Multi-display is encoded entirely in
each display's frame/workArea origin — never special-case "which monitor".

## Core schemas

```ts
Frame      = { x: number; y: number; width: number; height: number }  // finite ints
Point      = { x: number; y: number }
DisplayId  = string  // "display:<uuid-lowercase>" (adapter guarantees form)
WindowId   = string  // opaque stable logical id minted by adapter normalization
WorkspaceName = string

DisplayObservation {
  id: DisplayId
  frame: Frame          // full bounds, canonical space
  workArea: Frame       // system usable frame AFTER menu bar/dock reservation
  scale: number         // backing scale factor
  primary: boolean
}
TopologyObservation { displays: DisplayObservation[] }   // sorted by id

CapabilityState = "unknown" | "supported" | "fixed" | "inconclusive"
EvidenceSource  = "platform_report" | "behavioral_probe" | "geometry_operation"

Capabilities {
  movable: CapabilityState
  resizable: CapabilityState
  movableEvidence: EvidenceSource
  resizableEvidence: EvidenceSource
}

Constraints {
  minWidth?: number; maxWidth?: number     // learned size clamps (points)
  minHeight?: number; maxHeight?: number
}

WindowObservation {
  id: WindowId
  pid: number
  bundleId?: string
  executablePath?: string
  title?: string                    // user-facing only; never logged in diagnostics
  role: string                      // e.g. "AXWindow"
  subrole?: string                  // e.g. "AXDialog", "AXFloatingWindow", "AXSheet"
  frame: Frame
  minimized: boolean
  hidden: boolean                   // app-level hide
  fullscreen: boolean
  focused: boolean
  capabilities: Capabilities        // reported by platform where available
  constraints?: Constraints         // platform-known hard limits if any
}

// Classification performed by engine from observation attributes:
WindowClass = "normal" | "transient" | "system" | "uncertain"

World {
  topology: TopologyObservation
  windows: ReadonlyMap<WindowId, WindowObservation>
  // desired state:
  workspaces: WorkspaceState[]      // membership, bsp tree, mode, floating ids,
                                    // display assignment + pinned override,
                                    // parked frames per window
  focusedWorkspace: WorkspaceName | null
  profiles: ProfileStore            // learned constraints/cooperation, evidence-gated
  parkingFacts: ParkingFact[]       // per display+corner measured visibility limits
  paused: boolean
  epoch: number                     // increments on every committed change
}

GeometryRequest {
  windowId: WindowId
  frame: Frame
  tolerance?: number                // default 1, valid 0..20
  attempts?: number                 // default 3, valid 1..5
}
```

## Outcome classification (geometry writes)

After each write attempt, poll-settle then readback. Classify:

1. `exact` — observed ≈ requested within tolerance.
2. `constrained` — matches a KNOWN learned constraint: for each axis violating a learned
   min/max, observed equals the bound within tolerance AND position held within tolerance.
3. `progressing` — normalized distance to target decreased vs previous read (never learn
   from this; report honestly instead of failing mid-animation).
4. `stableClamp` — stable across reads, ≠ requested, position honored within tolerance,
   size differs from requested AND from initial frame by > tolerance. Candidate evidence
   for learning (see Learning rules).
5. `failed` — none of the above.

`set()` succeeds on `exact | constrained`; otherwise throws carrying the last observed
frame so callers can inspect/recover.

## Numeric constants (port these exactly)

| Constant | Value |
|---|---|
| Default geometry tolerance | 1 pt |
| Default attempts | 3 (range 1–5) |
| Tolerance range | 0–20 |
| Retry ladder | [positionSize, sizeOnly, sizePositionSize, convergedSizePositionSize] |
| Settle polling (engine default) | ≤11 reads, delay between non-matching reads |
| Position-only verify | Δpos ≤1, Δsize ≤1 |
| Probe delta | ±1 pt per dimension (floored at ≥1) |
| Probe match threshold | ≤0.25 pt per component |
| Work-area flush guard | observation edge within 2 pt of work-area edge ⇒ NOT learnable |
| Constraint promotion | 3 consistent samples within ±1 pt of each other |
| Confidence tiers | samples ≥8 strong, ≥3 learned, else tentative |
| Viability margins | learned min usable iff observed+1 < bound; max iff observed−1 > bound |
| Tiling containment acceptance | within content ±1 pt OR center inside content |
| Replan bound per layout pass | memberCount + 1 |
| Parking acceptance tolerance | 1 pt |
| Typical measured parking visibility | ~1 pt horizontal, ~52 pt vertical (per corner, probed) |
| BSP preferred split length | floor(available · ratio); second pane offset += gap |
| Default gap / resize increment | 8 pt / 0.05 |
| Default policy chain | [greedy, overlap, stack, overflow] |
| Transaction queue | pendingLimit 256, historyLimit 512, timeout 15 s |
| Suspicious-repeat escalation threshold | 3 |
| Batch cap | 64 commands, stop on first failure |

## Wire protocol messages (CLI/WebSocket)

JSON text frames. Every message has `{ v: 1, type: ... }` discriminator, validated by
Schema on receipt. Families:

- Request: `{ type: "request", id: string, command: Command }`
- Response: `{ type: "response", id, ok: true, data } | { ok: false, error: { code, message } }`
- Event: `{ type: "event", seq: number, topic: string, payload }`
- Snapshot: full committed state (on subscribe or gap recovery)

Command set mirrors existing CLI verbs: state/windows/displays/workspaces queries;
focus/move/resize/float/tile/manage/unmanage window commands; workspace focus/move/
move-window/move-display; retile/reconcile; pause/resume; config validate/reload;
transaction status; subscribe.

Error codes (closed union): `invalid_request, window_not_found, workspace_not_found,
window_not_manageable, window_not_controllable, inventory_stale, geometry_rejected,
geometry_verification_failed, topology_unstable, paused, queue_full, timeout,
config_invalid, internal_error`.
### Window dimension-limit probe

The command `{ type: "probeWindowLimits", windowId }` returns
`windowLimitsProbe` with canonical `identity`, `originalFrame`, `restoredFrame`,
`restoreStatus: verifiedExact`, per-axis `testedRanges`, exact minimum findings,
minimum findings discriminated as `exact` or `noClampDownTo`, maximum findings
discriminated as `exact` or `noClampThrough`, and
`profileUpdated`. The ordered `phases` report behavioral capability verification,
adoption/verification of existing durable parking, minimum probing, maximum
probing, and exact restoration. Targets must be inactive durable parked windows;
the command does not focus a window or reveal its workspace. Capability findings
come from guarded parked behavioral writes rather than metadata bounds.

The parked target identifies its host display, corner, retained visibility, and
aggregate `positionCorrection` (`verified` or `clamped`). Per-sample position
diagnostics keep requested ideal and observed points plus ideal and actual
retained visibility separate from size evidence. A stable OS position clamp is
accepted when the measured size and orthogonal dimension are unchanged, the
window remains positively parked at the same host corner, and it overlaps no
other display. `noClampThrough` is only a tested lower bound at the largest
connected display work-area extent.
