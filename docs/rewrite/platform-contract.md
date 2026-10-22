# Platform Contract

Defines the ONLY boundary between engine and any host system. Three implementations
exist: the macOS sidecar host (`packages/platform-macos`), the headless test fake
(`packages/layout/test/helpers/fake-platform.ts`), and the renderer simulation
(`packages/layout-browser`). All must behave identically at this interface.

## PlatformAdapter interface (engine-side, TypeScript)

```ts
interface PlatformAdapter {
  // Stream of generic events. Adapter translates native callbacks; engine treats
  // events trigger reconciliation; explicitly closed removals carry lifecycle evidence.
  events(): Stream<PlatformEvent>

  // Optional native-host control. The engine calls this when pause state
  // changes; adapters without native hotkey capture may omit it.
  setHotkeySwallowing?(enabled: boolean): Effect<void, PlatformError>

  // Snapshot queries. Unavailable observation fails rather than returning an empty list.
  getTopology(): Effect<TopologyObservation, PlatformError>
  getWindows(): Effect<WindowObservation[], PlatformError>
  getWindowInventory?(): Effect<WindowInventory, PlatformError>

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
  | { kind: "window_removed"; windowId: WindowId; closed?: boolean }
  | { kind: "window_changed"; window: WindowObservation }   // frame/title/state
  | { kind: "focus_changed"; windowId: WindowId | null }
  | { kind: "space_changed" }                                // native Space switch
  | { kind: "sleep" } | { kind: "wake" }
```

Rules for ALL implementations:

- Layout events are hints. The engine re-queries snapshots to reconcile.
- `WindowInventory` contains `windows` (current actionable observations),
  `unavailableWindowIds` (known instances that could not be observed), and
  `closedWindowIds` (positive destruction/process-exit evidence). Failure of the
  whole inventory read is `PlatformError { code: "unavailable" }`, not `windows: []`.
- Inventory-diff absence is not closure. Only positive lifecycle evidence may set
  `window_removed.closed: true`. Enumeration failure, filtering, and failed AX/CG
  joining must not generate that evidence. `getWindow` fails with `unavailable`
  for a known unreadable instance instead of reporting it as nonexistent.
- The engine remembers placement without a time limit while an instance is
  unavailable. It restores only matching window ID/PID and `instanceId` when
  provided. `instanceId` is an opaque platform lifetime token, not an app name,
  title, frame, or state-dependent subrole. Confirmed closure or replacement retires
  the old placement. Without tokens, the fallback matches ID/PID/role/application
  identity; adapters must report confirmed closure to disambiguate reuse.
- Unavailable windows are excluded from geometry plans. Remembered placement is
  separate from actionable window facts, so recovery does not write stale frames.
  New instances use configured assignment, then current workspace. Authoritative
  focus follows the assigned workspace; discovery alone never changes focus.
- `focused` in inventory and live readback means global focus, not an app-local
  window flag. On macOS, match the window to the frontmost application's
  `AXFocusedWindow`; inactive applications cannot report a globally focused window.
- `focus_changed` carries authoritative, ordered focus changes, including user
  activation outside wm. Snapshots bootstrap focus but cannot overwrite a newer
  focus event or successful focus command. A focus result verifies the requested
  window only when its application is frontmost and its focused-window reference
  matches; `AXMain` alone is insufficient.
- macOS focus detection runs separately from all-app inventory: activation
  notifications trigger a targeted read, with a 25 ms active-app polling fallback
  for window changes inside the same application. Cached AX window references
  map that read to the existing normalized ID without waiting for other apps.
- Window discovery includes normal CoreGraphics window owner PIDs even when
  Launch Services omits their application from `NSWorkspace.runningApplications`.
  AX enumeration and normal identity/reportability checks still apply. For these
  owners, executable and bundle metadata are resolved from the process path.
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
{ "op": "inspectWindow", "id": "window:cg:123" } // read-only live window and AX diagnostics
{ "op": "inspectApplication", "pid": 123 } // raw AXWindows, including filtered/minimized windows
{ "op": "setWindowFrame", "id": "...", "frame": {...}, "mode": "frame" | "position" | "size" }
{ "op": "focusWindow", "id": "..." }
{ "op": "executeBatch", "operations": [{ "operationId": "reveal:1", "kind": "setFrame", "windowId": "...", "frame": {...}, "expectedIdentity": {...} }, { "operationId": "focus:1", "kind": "focus", "windowId": "...", "expectedIdentity": {...}, "dependsOn": ["reveal:1"] }] }
{ "op": "ping" }
{ "op": "permissionsStatus" }
{ "op": "requestPermissions" }   // TCC prompts MUST be invoked by the sidecar executable
{ "op": "openPermissionsSettings", "target": "accessibility" | "screenRecording" }
{ "op": "configureKeybinds", "keybinds": {...}, "alwaysSwallow": ["rshift p"] }
{ "op": "setHotkeySwallowing", "swallow": true | false }
```

`executeBatch` has one aggregate response. Intermediate streaming is intentionally
out of scope: it would add protocol and rollback ordering complexity without reducing
the command's completion latency, because the engine cannot commit until all results
have settled.

`inspectWindow` returns `{ window, diagnostics }`. Diagnostics include the granted
reader identity/permissions, target registration, NSWorkspace foreground PID,
resolution errors, and scoped raw AX queries. Every query includes numeric/readable
error status, value type, and a JSON-safe value (`null` on failure). No activation,
geometry writes, permission requests, UI text contents, or pointer serialization
are performed. The engine preserves a separate cached observation for comparison.
`inspectApplication` accepts a positive process ID, bypasses normalized inventory,
and returns `window: null` with `diagnostics.target.windowId: null`. Both inspection
operations include `diagnostics.rawWindows`: unfiltered AXWindows elements with
response-local index, PID/error/target-match identity, and per-window query status.
Application AXWindows remains a count-valued query; errors and malformed values
are not treated as a successful empty array. Window queries also include
AXMinimized.settable alongside position and size settable checks.

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
   - Lifetime token: retain the AX reference and sampled process start time across
     observation gaps. Match by AX reference, or CG handle plus verified process
     start time when AX handles are rebuilt. Keep the original public ID across
     normalization changes for a matched instance. A changed process start time
     or unmatched native window mints a new `instanceId`. Process exit or
     `AXError.invalidUIElement` without a surviving CG surface retires a missing
     instance; timeouts and unreadable process metadata do not. Filtered/minimized
     windows retain their identity but are not made actionable using cached facts.
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
   Expected fingerprints are `[pid, role ?? null, subrole ?? null, instanceId]`
   when a lifetime token is available; otherwise retain the three-element format.
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
10. **Hotkeys:** forward every matched non-repeat keydown to the engine. Return the
    event to other applications when swallowing is disabled, except for chords listed
    by `alwaysSwallow`. The sidecar does not parse actions or decide whether a command
    is valid while paused.
11. **Bounded calls:** every AX call must be bounded (async with timeout); one hung app
    must never block the sidecar loop. Isolate per-app failures.
12. **Topology events:** poll CGGetOnlineDisplayList (AppKit notifications are
    insufficient without an event loop — see bean wm-dm8l); emit `topology_changed` on
    change. Also emit on wake/sleep notifications.
13. **Sleep observation:** mark window inventory unavailable before forwarding sleep.
    Wake requests a fresh pass; discard any pass spanning a sleep/wake transition.
    Requests remain unavailable until a fresh pass completes. AX failures are
    isolated per application so healthy windows remain manageable during recovery.
