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

## Environment Limitation

The active Command Line Tools Swift installation exposes neither XCTest nor
Swift Testing to SwiftPM. Library/executable builds, dependency-free verifier
targets, and live contract checks are used until a full Xcode toolchain is
available.

## Next Slices

1. Stable identity/event updates across window creation, closure, hide/show, and
   title/frame changes
2. Pure BSP tree/layout package and invariant/property fixtures
3. Explicit workspace state with one visible workspace and no parking initially
4. Transactional BSP tiling of explicitly selected windows
5. Verified parking/reveal and startup reconciliation
6. Multi-display topology and workspace migration
