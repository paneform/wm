# Platform Contract

Defines the ONLY boundary between engine and any host system. Three implementations
exist: the macOS sidecar host (`packages/platform-macos`), the headless test fake
(`packages/layout/test/helpers/fake-platform.ts`), and the renderer simulation
(`packages/layout-browser`). All must behave identically at this interface.

## PlatformAdapter interface (engine-side, TypeScript)

```ts
interface PlatformAdapter {
  // Stream of generic events. Adapter translates native callbacks; engine treats
  // events as hints that trigger reconciliation, never as authoritative mutations.
  events(): Stream<PlatformEvent>

  // Snapshot queries. Must be safe to call any time; return last-known state.
  getTopology(): Effect<TopologyObservation, PlatformError>
  getWindows(): Effect<WindowObservation[], PlatformError>

  // Primitive write operations. Each returns the OBSERVED outcome; the engine
  // classifies success/constraint/failure. Adapters do NOT retry, classify, or clamp.
  setWindowFrame(id: WindowId, frame: Frame): Effect<WriteObservation, PlatformError>
  setWindowPosition(id: WindowId, point: Point): Effect<WriteObservation, PlatformError>
  setWindowSize(id: WindowId, size: Size): Effect<WriteObservation, PlatformError>
  focusWindow(id: WindowId): Effect<void, PlatformError>
  executeBatch(request: PlatformBatchRequest): Effect<PlatformBatchResult, PlatformError>

  // Readback of a single window (cheap, used for settle polling).
  getWindow(id: WindowId): Effect<WindowObservation | null, PlatformError>
}

type WriteObservation = {
  requested: Frame
  observed: Frame          // settled readback after the write
  stable: boolean          // readback stable across settle polls
  errorKind?: "rejected" | "not_found" | "not_controllable" | "stale" | "ambiguous"
}

type PlatformError = { code: "not_found" | "not_controllable" | "stale" | "ambiguous"
                     | "rejected" | "permission" | "unavailable"; detail?: string }

PlatformEvent =
  | { kind: "topology_changed" }
  | { kind: "window_added"; window: WindowObservation }
  | { kind: "window_removed"; windowId: WindowId }
  | { kind: "window_changed"; window: WindowObservation }   // frame/title/state
  | { kind: "focus_changed"; windowId: WindowId | null }
  | { kind: "space_changed" }                                // native Space switch
  | { kind: "sleep" } | { kind: "wake" }
```

Rules for ALL implementations:
- Events are hints. The engine re-queries snapshots to reconcile.
- `setWindowFrame` semantics: write position and size as separate component writes in
  an adapter-chosen order (macOS: size→position→size bookends; see engine-guide for why),
  then settle-poll readback and report. Never throw on "window refused the exact frame" —
  report the observed frame instead. Throw `rejected` only when the platform API itself
  refuses the write (e.g. AX error), `not_controllable` when the element exists but is
  not writable, `stale` when identity changed mid-operation.
- The adapter performs NO policy: no clamping, no retry ladders, no learning, no parking
  search. A batch may schedule independent primitives concurrently and serializes
  operations targeting the same window, but does not provide all-or-nothing atomicity.
  Every operation retains its ID, requested/observed/stable/error result in request order;
  the engine compensates partial failure from captured preframes.
- All adapter outputs are Schema-validated before entering the engine.

## macOS sidecar wire protocol

Swift sidecar = separate executable speaking newline-delimited JSON over stdio
(stdin = commands, stdout = events/results, stderr = logs for humans). One JSON object
per line, all Schema-validated on both ends.

Engine → sidecar:
```jsonc
{ "op": "subscribe" }
{ "op": "getTopology" }
{ "op": "getWindows" }
{ "op": "getWindow", "id": "window:cg:123" }
{ "op": "setWindowFrame", "id": "...", "frame": {...}, "mode": "frame" | "position" | "size" }
{ "op": "focusWindow", "id": "..." }
{ "op": "executeBatch", "operations": [{ "operationId": "reveal:1", "kind": "setFrame", "windowId": "...", "frame": {...}, "expectedIdentity": {...} }, { "operationId": "focus:1", "kind": "focus", "windowId": "...", "expectedIdentity": {...}, "dependsOn": ["reveal:1"] }] }
{ "op": "ping" }
{ "op": "permissionsStatus" }
{ "op": "requestPermissions" }   // TCC prompts MUST be invoked by the sidecar executable
{ "op": "openPermissionsSettings", "target": "accessibility" | "screenRecording" }
```

`executeBatch` has one aggregate response. Intermediate streaming is intentionally
out of scope: it would add protocol and rollback ordering complexity without reducing
the command's completion latency, because the engine cannot commit until all results
have settled.

Sidecar → engine:
```jsonc
{ "ev": "topology_changed" } | { "ev": "window_added", "window": {...} } | ...
{ "result": { ... WriteObservation ... } }   // correlated by "reqId" on commands
{ "ready": true, "version": "..." }          // handshake on start
```

Sidecar implementation requirements:

1. **Canonicalize coordinates once at enumeration.** NSScreen frames are bottom-left
   origin, y-up: convert via `y' = primaryMaxY - rect.maxY`. AX positions/sizes and
   `kCGWindowBounds` are already top-left global — pass through. CGDisplayBounds is
   already canonical.
2. **Display identity:** `display:<uuid lowercase>` from CGDisplayCreateUUID; fallback
   `display:<directDisplayID>`. Order: primary first, then by x, y, id. Keep
   online-but-inactive displays during sleep (prevents topology churn).
3. **Window identity/normalization:**
   - Stable id: `window:cg:<id>` when CG id valid (non-zero); else
     `window:ax:<pid>:<role>:<subrole>:<fnv1a64(title) hex>:<occurrence-index>`.
   - Join AX + CG inventories by evidence score: cg_window_id match +100, frame match +20,
     title +5, pid prerequisite. Two CG candidates with equal evidence ⇒ refuse the join
     (mark uncertain). CG id 0 is invalid/absent.
   - Normal AX window with no CG surface ⇒ `uncertain` (CG is the existence oracle),
     unless minimized.
   - Structurally ignore: AutoFillPanelService, controlcenter, dock, notificationcenterui,
     systemuiserver; subroles AXDialog/AXSheet/AXSystemDialog/AXFloatingWindow; modal;
     has-parent; role must be exactly `AXWindow`.
4. **Identity validation around every write:** re-read identity (pid + role +
   AXWindowNumber↔cgWindowID if present) before and after each component write; if the
   element was replaced, abort with `stale` rather than mutating a replacement window.
5. **`AXEnhancedUserInterface` quirk:** before geometry writes, if the app has
   AXEnhancedUserInterface == true, temporarily set false and restore after (defer).
6. **Settle polling:** up to 36 samples, 17 ms apart; stop early on 3 consecutive target
   matches or 3 consecutive stable reads (≤0.5 pt movement, ε=1e-4). Inter-write delay
   25 ms.
7. **Focus:** activate app (activateAllWindows), set AXFrontmost, AXRaise, AXMain,
   AXFocused; verify via frontmost pid; one delayed retry.
8. **Capabilities:** report AXMovable/AXResizable as `platform_report` evidence.
   Behavioral probing is ENGINE-driven via primitive writes (±1 pt nudges); the sidecar
   just executes them.
9. **Permissions:** report accessibility/screen-recording status as part of `ready`;
   degraded screen recording reduces CG metadata but does not kill the source. TCC
   requests (`requestPermissions`) are invoked by the sidecar process itself so the
   system attributes the prompt to it; status queries never prompt.
10. **Bounded calls:** every AX call must be bounded (async with timeout); one hung app
    must never block the sidecar loop. Isolate per-app failures.
11. **Topology events:** poll CGGetOnlineDisplayList (AppKit notifications are
    insufficient without an event loop — see bean wm-dm8l); emit `topology_changed` on
    change. Also emit on wake/sleep notifications.
