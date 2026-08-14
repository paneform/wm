# Prototype Implementation Status

Updated: 2026-08-14

## Complete

- One Swift `wm` binary with daemon and WebSocket CLI modes
- Fixed loopback WebSocket transport with Origin allowlist support
- Canonical JSON request/response/subscription/event envelopes
- AppKit display inventory with OS display identifiers
- Accessibility and Core Graphics raw window inventory
- Provisional AX/CG joining, classification, and diagnostic reasons
- User-facing, observed, health, display, window, and diagnostic queries
- Ordered state/event versions, subscriptions, replay, and resync
- Inventory refresh and live event publication
- CLI and direct WebSocket contract parity for prototype methods
- TypeScript subscription example
- Warm CLI/WebSocket benchmark
- Explicit frame get/set with bounded strategy and verified readback
- Retained AX handle continuity across sequential geometry changes
- Immediate committed observed-frame update after verified mutation
- Dependency-free executable protocol and fake geometry verification
- Workspace domain, atomic persistence, default workspace adoption, and verified focus
- Pure BSP layout with strict transactional frame application for compatible windows
- Verified off-screen workspace parking and exact-frame reveal with rollback
- Persisted parked-frame recovery across daemon restarts
- Workspace lifecycle reconciliation for newly observed and closed windows
- Stable CG-backed window identities across scans and daemon restarts
- Two-second automatic inventory observation with coalesced refresh/reconciliation
- Observed minimum-size feedback and BSP ratio adaptation

## Live Findings

- Expected normal windows were found without removed-comparison-tool: Ghostty, Spotify, Zen,
  Messages, and Discord.
- Hex's visible full-display popup is `AXSystemDialog` and correctly transient.
- Hex retains an invisible `AXStandardWindow` Settings element without a current
  CG surface. Normal AX windows without CG corroboration are now uncertain and
  pending rather than immediately eligible.
- Notification Center widget surfaces require explicit system-UI bundle
  classification.
- `AXWindowNumber` is not available for these tested windows. Identity continuity
  cannot depend on it; retained exact AX handles are used after initial
  unambiguous resolution.
- Screen Recording preflight reports unavailable in the unsigned debug daemon,
  although CG inventory still contains useful owner/frame metadata.
- Warm CLI/WebSocket ping median measured approximately 0.57 ms.
- Ghostty explicit geometry test:
  - Original frame: `(8, 40, 1490, 934)`
  - Temporary frame: `(100, 100, 900, 700)` verified in 8 ms
  - Immediate restore without inventory refresh verified in 6 ms
  - Final readback exactly matched original frame
- Ghostty and Zen strict BSP test produced verified frames `(0,32,752,950)` and
  `(760,32,752,950)` with an 8-point gap, then restored both original frames.
- Spotify enforces an 800-point minimum width and currently rejects a half-display
  tile; minimum-size-aware layout adaptation remains pending.
- Ghostty/Zen workspace switching verified parking, reveal, frontmost activation,
  and preservation of exact window frames.
- Bottom-right parking verified Ghostty fully off-screen at `(1612,1082)` and
  Zen at macOS's constrained `(1472,950)` corner position.
- Bottom-left probing clamps Zen symmetrically to `x=-1456`, also leaving 40
  points visible. AeroSpace documents bottom-corner parking with a typical
  1-pixel line; Yabai uses native Spaces/private scripting additions rather than
  virtual off-screen workspace parking. Public AX size-position-size writes did
  not reduce Zen's clamp below 40 points.

## Validation

- Xcode 26.6 / Swift 6.3.3 toolchain active.
- Full suite passes: 28 XCTest tests and 45 Swift Testing tests.
- Dependency-free geometry and workspace-layout verifiers pass.

## Next Slices

1. Route move-window, move-display, and mode mutations through verified platform
   reconciliation before committing intent
2. Native AX/workspace event hints layered over periodic inventory audits
3. Multi-display topology and workspace migration
