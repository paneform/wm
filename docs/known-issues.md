# macOS Window Manager Reliability Review

Status: Research snapshot as of 2026-08-13

## Purpose

This document records recurring failures across established macOS window
managers and translates them into design requirements for `wm`. Open issues do
not prove that every report reproduces on current releases, but repeated
patterns across independent implementations are strong evidence about the
platform boundary.

Projects reviewed:

- yabai (`asmvik/yabai`, formerly `koekeishiya/yabai`)
- AeroSpace (`nikitabobko/AeroSpace`)
- removed-comparison-tool for Mac (`LGUG2Z/removed-comparison-tool-for-mac` public snapshot)
- Amethyst (`ianyh/Amethyst`)
- Rectangle (`rxhanson/Rectangle`)
- Hammerspoon (`Hammerspoon/hammerspoon`)

## Cross-Ecosystem Conclusions

### Accessibility is an eventually consistent remote system

AX calls can block, fail while permission appears granted, return stale handles,
omit events, reorder events, and vary by application. One hung app must never
block unrelated apps or the daemon transaction loop.

Design requirements:

- Bound every cross-process AX call.
- Isolate per-app failures.
- Treat notifications as hints to reconcile, not authoritative mutations.
- Retry observer registration and failed app inventory with backoff.
- Verify geometry and focus through readback.
- Reacquire stale AX handles.
- Expose operational AX health separately from TCC permission state.

Evidence:

- [yabai #600: suspended/busy applications](https://github.com/asmvik/yabai/issues/600)
- [AeroSpace #1615: slow app blocks world refresh](https://github.com/nikitabobko/AeroSpace/issues/1615)
- [Rectangle PR #1810: AX enumeration blocks on hung app](https://github.com/rxhanson/Rectangle/pull/1810)
- [Amethyst PR #1868: app AX observer readiness race](https://github.com/ianyh/Amethyst/pull/1868)
- [Rectangle #1325: wake breaks AX/window ID access](https://github.com/rxhanson/Rectangle/issues/1325)

### Window identity is not one OS identifier

AX elements are replaceable handles. CG window IDs can be missing, zero,
duplicated, stale, or reused. Native tabs and some apps expose multiple AX
elements for one visible surface, or replace an element without a clean
creation event.

Design requirements:

- Separate logical window lifetime from current AX/CG handles.
- Join multiple observations with confidence and explain decisions.
- Never key correctness solely by CG window ID.
- Support unknown and duplicate IDs without crashing.
- Rescan an affected app after ambiguous lifecycle events.
- Expose raw pre-classification inventory and rejection reasons.

Evidence:

- [yabai #68: native tabs](https://github.com/asmvik/yabai/issues/68)
- [yabai #2566: phantom Keynote windows](https://github.com/asmvik/yabai/issues/2566)
- [AeroSpace #68: native tabs as windows](https://github.com/nikitabobko/AeroSpace/issues/68)
- [AeroSpace #307: multiple AX windows for one surface](https://github.com/nikitabobko/AeroSpace/issues/307)
- [Amethyst PR #1870: stale AX handle after hide/show](https://github.com/ianyh/Amethyst/pull/1870)
- [Amethyst PR #1871: tab close reveals unobserved replacement](https://github.com/ianyh/Amethyst/pull/1871)

### Discovery must combine events with scoped and periodic reconciliation

Apps can miss initial detection, become visible while cached as non-AX, retain
ghost windows, or disappear from manager state without user intent.

Design requirements:

- Inventory at startup and after wake/topology changes.
- Rescan one app after suspicious lifecycle/focus events.
- Run adaptive audits even when no event arrived.
- Distinguish timeout from verified absence.
- Automatically recover unexplained management loss.

Evidence:

- [yabai #2793: Xcode sometimes not discovered](https://github.com/asmvik/yabai/issues/2793)
- [yabai #2765: visible Chrome window loses AX reference](https://github.com/asmvik/yabai/issues/2765)
- [Amethyst #1857: close events fail to trigger reflow](https://github.com/ianyh/Amethyst/issues/1857)
- [AeroSpace #1235: diagnostics omit rejected windows](https://github.com/nikitabobko/AeroSpace/issues/1235)

### Display changes are transactions, not individual callbacks

Connect/disconnect, KVM, clamshell, wake, scale, rotation, Dock, menu bar, and
Stage Manager changes produce intermediate and contradictory snapshots.
Transient display IDs and array indexes are not durable identity.

Design requirements:

- Debounce until consecutive topology snapshots stabilize.
- Identify displays through OS hardware/UUID information and fail ambiguity
  safely.
- Increment a topology epoch and reject stale callbacks/geometry.
- Recompute coordinate transforms and every affected layout.
- Update source and destination atomically for cross-display movement.
- Preserve workspace/display affinity independently of transient indexes.

Evidence:

- [yabai #259: display churn after sleep destroys layout](https://github.com/asmvik/yabai/issues/259)
- [yabai #2594: stale scaled frame after disconnect](https://github.com/asmvik/yabai/issues/2594)
- [AeroSpace #506: crash on display connect/disconnect](https://github.com/nikitabobko/AeroSpace/issues/506)
- [AeroSpace #2173: restore workspaces on reconnect](https://github.com/nikitabobko/AeroSpace/issues/2173)
- [Amethyst #1853: newly connected display does not reflow](https://github.com/ianyh/Amethyst/issues/1853)
- [Rectangle #1674: stale Dock-adjusted frame after KVM](https://github.com/rxhanson/Rectangle/issues/1674)
- [removed-comparison-tool WIP monitor/laptop branch](https://github.com/LGUG2Z/removed-comparison-tool-for-mac/commit/291cac8be6d4f8793f2006b570de2be470a3fadd)

### Wake requires complete resynchronization

Wake is not one reliable event. WindowServer, AX, applications, displays, Dock,
and timers recover at different times. Handles and observers can remain
syntactically present but dead.

Design requirements:

- Pause mutations during sleep/wake/session transitions.
- Wait for stable displays.
- Revalidate permissions and AX health.
- Recreate observers and discard native handles.
- Re-enumerate all apps/windows.
- Audit geometry, workspace assignment, focus, and parked state.
- Resume only after reconciliation.

Evidence:

- [yabai #2746: stale offscreen frame cache after wake](https://github.com/asmvik/yabai/issues/2746)
- [yabai #2783: focus event handling degrades after wake](https://github.com/asmvik/yabai/issues/2783)
- [Rectangle #1325](https://github.com/rxhanson/Rectangle/issues/1325)
- [Amethyst #1030: offscreen Emacs after sleep](https://github.com/ianyh/Amethyst/issues/1030)
- [Hammerspoon #1942: timers stop after sleep](https://github.com/Hammerspoon/hammerspoon/issues/1942)
- [removed-comparison-tool sleep/work-area fix](https://github.com/LGUG2Z/removed-comparison-tool-for-mac/commit/c45090c5c55aa70aeb3a0f20cefd3675173b46a1)

### Work-area and coordinate systems are independently mutable

AppKit frames, Core Graphics bounds, AX coordinates, backing scale, Dock/menu
bar insets, Stage Manager, and app-enforced sizes can disagree. Independent
rounding creates seams. Size and position are not one atomic operation.

Design requirements:

- Maintain explicit conversions into one canonical coordinate system.
- Derive work area from system frame plus box-model user margins.
- Round shared BSP boundaries once.
- Apply geometry with bounded move/resize ordering and readback.
- Respect minimum size where observable.
- Guarantee reachable intersection for every non-parked managed window.

Evidence:

- [Amethyst #1155: vertical display coordinate errors](https://github.com/ianyh/Amethyst/issues/1155)
- [Rectangle #1774: display ordering differs from macOS](https://github.com/rxhanson/Rectangle/issues/1774)
- [Rectangle PR #1812: fractional rounding seams](https://github.com/rxhanson/Rectangle/pull/1812)
- [Hammerspoon #3852: mixed-scale animation overshoot](https://github.com/Hammerspoon/hammerspoon/issues/3852)
- [Rectangle #1115: inconsistent Stage Manager work area](https://github.com/rxhanson/Rectangle/issues/1115)

### Manual and programmatic movement must share one state path

Managers commonly leave ghost nodes, fail to reclaim source layout space, or
fight a mouse drag using stale state.

Design requirements:

- Attribute source of change.
- Translate recognized gestures into the same workspace transaction model as
  commands.
- Reconcile both source and destination.
- Detect and stop correction loops.

Evidence:

- [yabai #2300: cross-display drag leaves ghost node](https://github.com/asmvik/yabai/issues/2300)
- [yabai #2627: source space not reclaimed](https://github.com/asmvik/yabai/issues/2627)
- [AeroSpace #347: dragged floating window jumps back](https://github.com/nikitabobko/AeroSpace/issues/347)
- [AeroSpace #1519: floating geometry bidirectional-state problem](https://github.com/nikitabobko/AeroSpace/issues/1519)

### Focus events race with macOS activation policy

Creation, application activation, Space changes, destruction, minimize, and AX
focus events can arrive in any order. Activating an app can focus the wrong
same-app window. Empty displays/workspaces have no obvious native focus target.

Design requirements:

- Treat global manager focus and observed native focus separately.
- Verify exact-window focus after commands.
- Follow native focus changes as user intent without monitoring hotkeys.
- Preserve pre-event context where assignment depends on it.
- Prototype empty-workspace and same-app focus behavior.

Evidence:

- [AeroSpace #1097: focus race when closing windows](https://github.com/nikitabobko/AeroSpace/issues/1097)
- [AeroSpace #101: wrong same-app window across displays](https://github.com/nikitabobko/AeroSpace/issues/101)
- [Hammerspoon #370: Chrome focuses wrong window](https://github.com/Hammerspoon/hammerspoon/issues/370)
- [yabai #1907: focus/Space event reordering](https://github.com/asmvik/yabai/issues/1907)

### Public native Space control is not reliable enough for a core contract

Cross-Space inventory is incomplete. Public workarounds rely on Mission Control
UI automation, focus side effects, dragging, synthesized input, or private APIs;
operations can return success without moving windows.

Design requirements:

- Own virtual workspaces independently of native Spaces.
- Never depend on complete off-Space inventory.
- Do not automate Mission Control or synthesize Space controls.
- Prototype active-Space behavior with separate-Spaces both enabled and
  disabled.
- Do not promise private-API features such as Space creation/destruction,
  arbitrary hidden-Space movement, sticky/layer/opacity/shadow controls.

Evidence:

- [Hammerspoon #3698: moveWindowToSpace returns true without move](https://github.com/Hammerspoon/hammerspoon/issues/3698)
- [Hammerspoon #3276: incomplete cross-Space window inventory](https://github.com/Hammerspoon/hammerspoon/issues/3276)
- [Hammerspoon #2776: public Mission Control automation limitations](https://github.com/Hammerspoon/hammerspoon/issues/2776)
- [yabai #1863: features requiring scripting addition/private APIs](https://github.com/asmvik/yabai/issues/1863)
- [yabai #2789: hidden/empty Space move failure](https://github.com/asmvik/yabai/issues/2789)
- [removed-comparison-tool installation Space limitation](https://github.com/LGUG2Z/removed-comparison-tool-for-mac/blob/master/docs/installation.md)

### Offscreen workspace emulation can leak and lose windows

Moving inactive windows to corners/offscreen causes flicker, fights apps that
constrain geometry, leaks parking frames after hide/show, and leaves windows
lost after crashes or topology changes.

Design requirements:

- Parking is explicit committed workspace intent, never inferred only from a
  magic coordinate.
- Startup and adaptive audits compare parking intent with observed geometry.
- Clean shutdown restores all parked workspaces.
- Crash restart reconciles to the last committed snapshot.
- Unexplained offscreen windows are recovered automatically.
- Bound enforcement against resistant apps.

Evidence:

- [AeroSpace #545: hidden-workspace AX fights/flicker](https://github.com/nikitabobko/AeroSpace/issues/545)
- [AeroSpace #642: hidden floating frame leaks onscreen](https://github.com/nikitabobko/AeroSpace/issues/642)
- [Amethyst #626: mostly offscreen windows](https://github.com/ianyh/Amethyst/issues/626)
- [Amethyst #1030](https://github.com/ianyh/Amethyst/issues/1030)

### Internal tree/state invariants need transactional validation

Mutable ownership bugs can detach nodes twice, discard sibling subtrees, leave
invisible nodes, or diverge rendered geometry from the tree.

Design requirements:

- Workspace mutation is a single serialized transaction.
- Prefer value-semantic/persistent or safely copied layout state.
- Validate after every mutation: each managed live window exactly once, every
  node reachable, no cycles, valid ratios, feasible geometry.
- Commit only after verified or explicit fallback convergence.
- Use pure deterministic layout functions with property tests.

Evidence:

- [AeroSpace #1215: replace mutable double-linked tree](https://github.com/nikitabobko/AeroSpace/issues/1215)
- [AeroSpace #1311: already-unbound crash](https://github.com/nikitabobko/AeroSpace/issues/1311)
- [Amethyst PR #1865: BSP node removal discards subtree](https://github.com/ianyh/Amethyst/pull/1865)
- [AeroSpace #680: rendered layout diverges until reset](https://github.com/nikitabobko/AeroSpace/issues/680)

### Event streams require snapshots, sequences, and failure isolation

Forking a process per event is expensive. Best-effort sockets can drop events,
crash on subscriber data, block behind slow consumers, and provide no replay.

Design requirements:

- Persistent WebSocket streams with monotonic sequence and state versions.
- Bounded replay independent of subscriber acknowledgement.
- Disconnect slow consumers instead of blocking manager state.
- Snapshot resynchronization after expired gaps.
- Include last known state in destruction events where useful.
- Keep commands/transactions queryable independent of event receipt.

Evidence:

- [yabai #1606: live signals instead of fork/exec](https://github.com/asmvik/yabai/issues/1606)
- [yabai #2639: destruction event lacks last state](https://github.com/asmvik/yabai/issues/2639)
- [AeroSpace #463: callback spawn failure crashes manager](https://github.com/nikitabobko/AeroSpace/issues/463)
- [removed-comparison-tool subscription implementation](https://github.com/LGUG2Z/removed-comparison-tool-for-mac/blob/master/removed-comparison-tool/src/lib.rs)

### CLI queries must not wait on world refresh

Read operations can become slow or unresponsive when command handling shares
blocking AX inventory work.

Design requirements:

- Serve user queries from last committed immutable snapshots.
- Keep per-app AX work outside the command actor.
- Return pending/recovery metadata without exposing half-applied state.
- Benchmark native-host and TypeScript CLI startup plus WebSocket handshake before setting latency
  budgets.

Evidence:

- [AeroSpace #104: CLI performance](https://github.com/nikitabobko/AeroSpace/issues/104)
- [AeroSpace #1615](https://github.com/nikitabobko/AeroSpace/issues/1615)

### Permissions, code identity, and lifecycle need first-class diagnostics

TCC may appear granted while AX remains unusable. Re-signing, changing paths,
quarantine, or endpoint security can invalidate access. launchd KeepAlive can
turn bad config/permission startup into a crash loop.

Design requirements:

- Stable signed identity and notarized distribution.
- Functional permission probes and `doctor` diagnostics.
- Single-instance lock independent of process-name checks.
- launchd backoff and crash-loop visibility.
- Graceful stop over the live protocol, bounded fallback, and explicit force.

Evidence:

- [yabai #2688: TCC entries and code identity](https://github.com/asmvik/yabai/issues/2688)
- [yabai #2805: persistent AX issues despite permission](https://github.com/asmvik/yabai/issues/2805)
- [Amethyst #1856: permission granted but nonfunctional](https://github.com/ianyh/Amethyst/issues/1856)
- [removed-comparison-tool launchd generation](https://github.com/LGUG2Z/removed-comparison-tool-for-mac/blob/master/removed-comparison-toolc/src/main.rs)

## Local removed-comparison-tool Scar Tissue

The current dotfiles contain concrete workarounds that informed the `wm` spec.

### Managed windows disappeared from state

Ghostty, Messages, Discord, and Spotify remained open according to an independent
AX inventory but vanished from `removed-comparison-toolc state`. `removed-comparison-toolc visible-windows`
returned only the currently visible window and could not identify these open
unmanaged windows.

Mitigation added:

- Exact executable `manage_rules`
- AX-based all-window diagnostic table
- Restart to force re-observation and assignment

Design implication:

- Inventory must include unmanaged/uncertain windows independently of manager
  state, and unexplained management loss must trigger automatic repair.

### `visible-windows` semantics were narrower than expected

Source inspection showed that it returns selected windows only from focused
workspaces, not a complete OS-visible or open-window inventory.

Design implication:

- Public commands need precise names/schemas and explicit normalized versus raw
  inventory endpoints.

### Global work-area offset was double-applied on the built-in display

macOS already reserved the MacBook menu/notch region. removed-comparison-tool also applied the
global external-display top/bottom offset, shrinking tile height by roughly 50
points. Static monitor matching did not reliably apply the desired override.

Mitigation added:

- Discover built-in display by name after startup
- Apply a zero monitor-specific offset through CLI
- Retile before reloading the topbar

Design implication:

- Start with system work area, apply box-model field overrides, identify
  displays durably, and verify resulting geometry.

### Static config reload mutated topology incorrectly

`replace-configuration` produced duplicate workspace names in live state. A
later static display preference shape caused workspace config not to attach,
collapsing windows into an unnamed workspace.

Design implication:

- Config application must be parse/validate/candidate-build/atomic-swap, with
  no mutation on failure and invariant validation before commit.

### launchd and manual starts competed

The generated launchd agent used unconditional KeepAlive while manual start/stop
commands created competing ownership and thousands of failed respawns.

Mitigation added:

- Stop manual instance
- Restart through launchd
- Poll actual state readiness

Design implication:

- Enforce one owner with an atomic lock and distinguish process existence from
  healthy protocol readiness.

### Window geometry sometimes did not follow workspace movement

Moving a workspace between displays recalculated manager layout but macOS left
windows at prior monitor geometry. Retile alone was unreliable. Reversible
container movement or float toggling forced frame adoption.

Design implication:

- A successful API/manager state change is not completion. Apply geometry,
  read back every affected frame, retry bounded variants, and commit verified
  or degraded fallback state only.

### Offscreen/lost windows needed explicit recovery

Managed windows could retain rectangles that did not intersect the physical
display assigned to their workspace.

Mitigation added:

- Audit each window against display bounds
- Force geometry refresh through float toggles
- Preserve focus and workspace context

Design implication:

- Lost-window detection and recovery are core continuous invariants, not a
  troubleshooting add-on.

### Topbar state could be erased during WM downtime

The SketchyBar adapter converted a failed manager query into valid-looking `[]`.
Reconciliation then removed every workspace item. State snapshots were also
written non-atomically.

Mitigation added:

- Propagate query failure distinctly
- Skip reconciliation on unavailable state
- Write snapshots through temporary file plus atomic rename
- Reload the bar after a full manager restart

Design implication:

- Unavailable is not empty. All projections need explicit health/version
  metadata, and state consumers must resynchronize instead of interpreting
  transport failure as authoritative state.

## Public-API Boundary For `wm`

V1 can promise:

- Discovery and management of controllable normal windows on observable native
  Space contexts
- Verified movement, resizing, focus attempts, BSP tiling, floating, and
  virtual workspace parking
- Multi-display assignment and topology recovery
- Full wake/session reconciliation
- Automatic drift/lost-window recovery
- Scriptable JSON CLI and WebSocket state/events/commands

V1 does not promise:

- Complete inventory across all native macOS Spaces
- Reliable native Space creation/destruction/movement
- Hidden-Space movement without visible transition
- Sticky windows, arbitrary layers, shadows, opacity, or animation controls
- Perfect exact-window focus where macOS app activation overrides AX requests
- Control of apps/windows that reject or hang public Accessibility operations
