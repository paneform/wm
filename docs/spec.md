# wm Product Specification

Status: Living specification

## Product Philosophy

`wm` is a reliability-first macOS window manager for technical power users. It
follows a Unix-like philosophy: remain small in scope and do window management
extremely well.

Performance is an architectural requirement, especially for hotkey-driven
commands, but never takes priority over reliability. Performance targets will
be set from prototype benchmarks rather than guessed in advance.

The manager owns:

- Window discovery, classification, identity, and health
- Virtual workspaces and workspace visibility
- BSP layout state and geometry reconciliation
- Floating window membership and geometry
- Display assignment and topology recovery
- Durable runtime intent
- CLI, WebSocket commands, state, events, and diagnostics

It does not own:

- Hotkey registration
- A status bar or other desktop UI
- System monitoring
- Window decorations, borders, shadows, opacity, layers, or sticky behavior
- Application launch, quit, or window close actions
- Native window minimize, hide, or fullscreen actions
- Scratchpads
- Arbitrary event hooks or external command execution
- Native macOS Space creation, movement, Mission Control automation, or
  synthesized Space gestures

The first release uses public Apple APIs only. Calling the implementation
"native" is not itself a goal.

## Platform And Distribution

- Language: portable TypeScript engine and Node host with a thin Swift native host
- Process model: signed native launchd host supervising the TypeScript engine child;
  short-lived TypeScript clients communicate over loopback WebSocket
- Architecture: Apple Silicon only
- OS support: current major macOS release only
- Distribution: signed and notarized release archives plus Homebrew
- Supervision: official per-user launchd support and supported foreground/manual
  daemon operation
- Process ownership: one per-user instance enforced by an atomic lock
- Unexpected crashes: launchd restart with backoff and crash-loop diagnostics
- GUI session scope: current active user GUI session only

Project branding must remain consistent across executable metadata, config/state
paths, launchd labels, packaging scripts, and user-facing names.

Client commands must not initialize daemon-only systems.
CLI startup, WebSocket handshake, instant acknowledgement, and completed
command latency must be benchmarked early. The implementation should remain
modular enough to split binaries if measurements justify it.

## Permissions

Accessibility permission is required for daemon readiness. Screen Recording is
optional; without it, window titles and off-process application names degrade.
`wm doctor` checks both permissions, can open the appropriate System Settings
panes, and reports concrete remediation. Native operations report permission
errors if access is revoked at runtime. Pointer-centering capability may degrade
independently without making the window manager unavailable.

## Core State Model

The implementation maintains separate layers:

- Desired state: durable workspace membership, BSP trees, visibility, display
  assignments, modes, floating geometry, and config/runtime policy
- Observed state: current AX and Core Graphics inventory, handles, geometry,
  focus, visibility, capabilities, and health
- Operation state: pending command, retries, verification, and fallback outcome
- Committed state: the last desired state whose required macOS postconditions or
  explicit fallback outcomes have been verified

Window records own identity, current native handles, observations,
capabilities, and health. Workspaces own layout intent, membership, visibility,
display assignment, and transaction consistency.

No desired window geometry mutation occurs independently of its workspace and
the display-topology epoch against which the workspace was laid out.

Queries during a mutation return the last committed user-facing state plus
pending transaction/recovery metadata. A transaction commits only after all
required postconditions verify or an explicit degraded fallback, such as
floating a resistant window, verifies.

Mutations execute through one serialized transaction queue. Commands received
during topology recovery queue until safe. Equivalent idempotent commands are
coalesced while pending; suspicious repetition escalates reconciliation.

Bulk selectors apply mutations to all matches. Bulk intent is committed
atomically, while individual platform failures are reported without attempting
unsafe rollback of already verified macOS effects.

## Persistence

Runtime state uses one atomically replaced JSON snapshot containing the last
fully committed state. It is written after every completed transaction. V1 has
no pre-operation journal.

If the daemon crashes during an operation, startup restores the last committed
state rather than resuming interrupted intent. Observed side effects not present
in the snapshot are drift and are reconciled back to committed intent.

Only the current snapshot is retained. Invalid state is quarantined and rebuilt
from config plus observed windows. Runtime schema changes across releases cause
a best-effort all-or-nothing import of everything parseable; on failure the
state is rebuilt.

Paths follow XDG conventions:

- Config: `$XDG_CONFIG_HOME/wm/config.jsonc`, default `~/.config/wm/config.jsonc`
- State and logs: `$XDG_STATE_HOME/wm`, default `~/.local/state/wm`
- Cache: `$XDG_CACHE_HOME/wm`, default `~/.cache/wm`
- Single-instance lock and ephemeral ownership metadata: XDG state directory

## Startup, Shutdown, Pause, And Recovery

Startup sequence:

1. Validate permissions and configuration.
2. Acquire the single-instance lock and configured WebSocket port.
3. Load the last committed runtime snapshot, or quarantine/rebuild it.
4. Build stable display and work-area observations.
5. Enumerate applications and join AX/Core Graphics window inventories.
6. Audit observed windows against committed desired state.
7. Repair parked, lost, stale, and unexplained state divergence.
8. Reconcile and verify workspace layouts.
9. Report ready and begin accepting normal commands.

An unresponsive application has a bounded per-app startup timeout. The daemon
may become ready with that app marked degraded and retry it asynchronously.

Normal shutdown restores every parked workspace using its layout on its
assigned display. Visible windows retain their useful current frames. The CLI
requests graceful shutdown over WebSocket, waits boundedly, and refuses to
force termination unless the caller passes `--force`.

Global pause mode continues observation, events, diagnostics, and audits but
performs no geometry, parking, or focus mutations. Parked windows remain parked.
Mutations return a structured paused error. Resume performs a full observed
state rebuild and reconciliation before mutations are accepted.

## Window Discovery And Identity

The daemon joins Accessibility and Core Graphics inventories. Neither source is
authoritative alone. AX handles and Core Graphics window IDs are treated as
transient observations rather than unquestioned durable identity.

The identity model is a prototype deliverable. The first prototype must expose
raw and normalized inventory sufficient to study:

- Missing, zero, duplicate, reused, or changing CG window IDs
- AX handle replacement after hide/show, tab changes, and app behavior
- Native tabs represented as windows
- Multiple AX elements corresponding to one physical surface
- Windows discoverable only in the active native Space
- App-level and title-level metadata changes

Default classification manages normal movable/resizable user windows and
ignores system UI, panels, sheets, popovers, and transient controls. App
activation policy does not decide manageability. Uncertain windows remain
unmanaged and expose rejection reasons. Explicit `manage` always overrides
classification and ignore policy unless the platform proves the window cannot
be controlled safely. Explicit `unmanage` lasts for that logical window's
lifetime.

`windows list` returns all observed windows with classification, management,
workspace, and health metadata. A diagnostic raw-inventory endpoint exposes
AX/CG records, join confidence, and classification reasons.

User-facing state and full/delta events may include titles. Structured logs and
diagnostic bundles omit titles and document names, using stable identifiers and
useful app/executable identity instead.

## Window Rules

Rules support:

- Bundle ID
- Executable path and name
- Process identity
- Title
- AX role and subrole
- Other explicitly modeled AX/CG properties
- Exact, contains, and regular-expression matching
- Case-sensitivity control and boolean AND/OR/NOT composition

First matching rule wins. V1 actions include:

- Manage or ignore
- Initial workspace assignment
- Tiled or floating behavior
- Initial floating geometry policy
- Resistant-window fallback policy

Rules place newly discovered windows initially. They do not continuously undo
subsequent attributed user moves. Unexplained loss of management or assignment
is drift and is retried with bounded backoff. Explicit user commands always
override default assignment behavior.

Unmatched normal windows are managed in the globally focused workspace.
Relaunched applications produce new windows and use workspace initial
assignments/current focus rather than restoring prior window-lifetime membership.

## User Intent Attribution

Intent-changing actions include:

- Accepted manager commands
- Recognized mouse move and resize gestures
- Native focus changes observed through resulting system focus/application
  events, including Cmd-Tab, Cmd-`, Dock clicks, and app activation

The manager does not monitor those native hotkeys directly. It follows the
resulting focused window and adopts its workspace as globally focused. If that
window belongs to a parked workspace, the workspace is revealed on its assigned
display and the previously visible workspace there is parked.

Unattributed divergence is repairable drift.

## Workspaces

A workspace is a portable, uniquely named window group with durable layout and
display assignment. Each display can show one workspace independently. Exactly
one workspace is globally focused; other displays may show visible unfocused
workspaces.

There is no display-focus operation. A display is targeted by moving or
focusing a workspace assigned to it.

Every workspace is assigned to a display, including while parked. Preferred
display affinity is an initial/default assignment. An explicit workspace move
creates a persisted runtime assignment override until reset; later explicit
config changes still win.

Workspace names are the public identity. There is no workspace rename command,
global workspace cycling, or workspace focus-history command.

Workspace lifecycle is implicit:

- `focus-workspace NAME` focuses an existing workspace or creates an empty
  runtime workspace when absent.
- A newly focused runtime workspace is assigned to the focused workspace's
  display. If none exists, use the frontmost window's display, then pointer
  display, then macOS primary display.
- `move-window-to-workspace NAME` follows the moved window and focused
  destination. If absent, create the workspace on the source workspace display.
- A future separate `send` command may provide non-follow semantics; it is not
  required initially.
- Runtime-created workspaces are automatically deleted when empty and parked.
- Configured workspaces persist while empty.
- Empty workspaces are valid visible/focused desktops.
- A display may have no workspace assigned or visible.

Focusing a visible workspace on another display focuses it in place. Focusing a
parked workspace reveals it on its assigned display and parks the previously
visible workspace there.

Each display remembers one previous visible workspace. Moving its current
workspace away reveals that previous workspace if still valid; otherwise the
source display remains empty.

## Workspace Visibility And Parking

Inactive workspace windows are parked offscreen. The authoritative last
committed snapshot, not magic coordinates alone, determines whether a window is
intended to be parked. Startup and audits compare observed geometry with
committed workspace visibility and repair disagreement.

Parking and revealing are workspace transactions. Desired tiled frames are
derived from the workspace tree and current work area; absolute tiled frames
are not durable layout truth.

Native app hiding is respected. Hidden windows temporarily collapse out of the
active layout while retaining their workspace/tree restoration metadata.
Minimized windows behave the same way. Native fullscreen suspends management
for the window and retains its slot for restoration after fullscreen exits.

When a window is verified closed, remove it immediately from membership,
collapse its BSP parent, and treat any later AX replacement/new window as a
fresh insertion.

## BSP Layout

V1 ships only BSP, behind an extensible layout interface.

Default insertion:

- Split the workspace's most recently focused leaf.
- Preserve most-recent focus per workspace even when another workspace becomes
  globally focused, so cross-workspace moves split the intended destination
  window.
- Split along the tile's longest dimension.
- A square tile uses a vertical divider.
- Existing window stays left/top; new window goes right/bottom.
- New split ratio is 50/50.

Removing a leaf promotes its sibling subtree while preserving all nested
structure and ratios.

Cycle next/previous focus follows BSP leaf traversal order. Directional focus
and directional move algorithms must be prototyped before their exact semantics
are fixed. Directional focus remains within the workspace and cycles at its
edge rather than crossing displays.

Keyboard and mouse resize update the nearest controlling ancestor split.
Keyboard increments use configurable percentage points. Split ratios clamp to
known application minimum sizes. If no feasible tiled layout exists, float the
newest window whose constraints made it infeasible and emit degradation.

Mouse drag interaction must be prototyped among swap, reinsert, and drop-zone
semantics. An unambiguous gesture updates BSP intent; an ambiguous gesture
floats the window.

V1 has no stacking and no animations. Leaves should remain extensible so
stacking can be evaluated later.

## Floating Windows And Workspace Modes

Floating windows remain workspace members and park/reveal with the workspace.
When first floated, keep the current native frame and clamp it to the work area.

Across differently sized displays:

1. Preserve absolute size and relative position.
2. Reposition minimally until fully inside the work area.
3. If it cannot fit, resize only as much as needed, then reposition fully inside.

Each workspace supports BSP or floating mode. Switching BSP to floating adopts
the current tiled frames. Switching floating to BSP rebuilds the tree from
current geometry; candidate reconstruction algorithms must be prototyped before
semantics are fixed.

Dialogs, sheets, and transient utility windows float in their parent's
workspace. If parent cannot be determined, use the focused workspace. Transient
windows are not persisted.

## Displays And Work Areas

Public interfaces use `display`; the CLI accepts `monitor` as an alias. JSONC
config and WebSocket schemas use only canonical `display` terminology.

Display identity must build on OS identifiers exposed by Apple APIs. The
prototype must document and normalize identifiers among AppKit, Core Graphics,
and hardware metadata. If two displays remain ambiguous, manage both but fail
affinity safely and emit diagnostics rather than guessing.

`wm display list` must show connected displays and valid command/config
identifiers. Exact targeting semantics will be fixed after identity prototyping.

Work area calculation:

1. Begin with the macOS-reported usable system frame.
2. Apply global box-model margins.
3. Per-display explicit edge values replace corresponding global edges.
4. Positive margins shrink from that edge; negative margins extend toward it.
5. Workspace margin applies outside the layout; gap applies between adjacent
   tiles.
6. Shared BSP boundaries are rounded once deterministically so siblings meet
   without cumulative seams or overlap.

Resolution, scale, rotation, display position, menu-bar location, Dock location,
Stage Manager reservation, connect/disconnect, clamshell changes, wake, and
other work-area/coordinate changes increment the display topology epoch and
trigger workspace relayout.

Topology operations pause geometry writes until consecutive OS snapshots are
stable, with a bounded timeout and degraded fallback.

Display disconnect behavior:

- Move each affected workspace intact to the globally focused workspace's
  display as a temporary assignment.
- Recompute layout for the new work area.
- Emit a workspace-moved event.
- If the moved workspace was globally focused, keep it focused and visible on
  the destination.
- Otherwise park it and preserve the destination's previously focused/visible
  workspace.
- Retain preferred and prior arrangement for reconnect.

Display reconnect behavior:

- Wait for stable topology.
- Restore prior arrangement automatically.
- Explicit configured display affinities take priority.
- Recompute and verify every affected layout.

Unknown displays begin with no assigned workspace. Moving a focused workspace
to an occupied destination parks the destination workspace; the moved workspace
stays globally focused and pointer-centering applies to its focused window.

V1 should work whether "Displays have separate Spaces" is enabled or disabled,
without supporting multiple managed native Spaces per display. Exact behavior
when users switch native Spaces must be determined through prototypes in both
settings. Mission Control UI automation is never used.

## Sleep, Wake, And Session Changes

Sleep, wake, unlock, session activation, and display changes are transition
epochs rather than isolated events. Wake/unlock always performs a full rebuild:

- Pause mutations
- Wait for stable displays
- Revalidate permissions
- Recreate AX observers and discard old handles
- Re-enumerate applications and AX/CG windows
- Reconstruct observed state
- Audit lost/parked/drifted windows
- Reconcile committed workspace intent
- Resume command processing and emit resynchronized/health events

Clamshell transitions follow the same topology machinery.

## Drift, Lost Windows, And Resistant Apps

The manager reconciles with restraint:

- Clear violations of committed intent repair automatically.
- Operations are bounded and verified by readback.
- Repeated failure and oscillation stop aggressive enforcement.
- A resistant tiled window floats, commits as degraded, and emits diagnostic
  and health events.

Lost-window conditions include:

- Frame does not intersect an active work area sufficiently to remain reachable
- Managed window is inconsistent with workspace visibility or assignment
- Frame belongs to a disconnected display topology
- Actual geometry persistently disagrees with desired geometry
- AX/CG inventories or handles contradict one another
- A supposedly managed window is missing from desired membership without
  attributed user intent

Managed lost windows recover through their assigned workspace layout. An
unassigned lost normal window is recovered, managed, and inserted into the
focused workspace.

Audits are adaptive: low frequency while healthy, faster after topology/wake,
errors, suspicious repeated commands, focusing an empty workspace, or observing
native focus on an unmanaged window. Events indicative of inconsistency trigger
scoped or full audits immediately.

Every successful automatic repair emits a structured event without interrupting
the user by default.

## Focus And Pointer

Manager-initiated focus commands center the pointer in the focused window.
Native focus changes do not warp the pointer. Pointer failure degrades only that
capability.

The exact public-API strategy when macOS activates the wrong same-app window
must be prototyped. Empty-workspace native focus should prototype Finder/Desktop
activation and define fallback behavior from evidence.

## Configuration

Primary format: JSONC with a generated JSON Schema.

- Unknown fields are errors.
- Environment interpolation is allowed only in schema-declared path fields.
- Every workspace setting inherits field-by-field from global defaults.
- Core workspace settings: name, preferred display, mode, margin, gap, resize
  increment, and initial assignment matchers.
- Workspace initial assignment matchers select the first workspace for a newly
  managed window; later manual moves remain authoritative.
  tiled/floating behavior.

Runtime state is a separate overlay; the daemon never rewrites config. New
explicit config changes override corresponding runtime values while untouched
fields retain runtime customizations.

Reload triggers and modes:

- Hotload is enabled by default and uses delta reload.
- Explicit reload defaults to full reload.
- Callers can request any hotload/explicit and delta/full combination.
- Every candidate is fully parsed and validated before atomic application.
- Delta applies only changes relative to the loaded config.
- Full rebuilds config-derived intent, preserves runtime overlay, and performs a
  complete drift reconciliation pass.
- Invalid hotload retains prior config, emits config/health events, and marks
  health degraded until a later valid hotload applies successfully.
- Removing an empty configured workspace deletes it.
- Removing a populated configured workspace preserves it as runtime state and
  removes config-derived properties.

Validation and reload commands have CLI/WebSocket parity.

## CLI And WebSocket API

V1 uses no Unix socket. The daemon exposes one WebSocket server on a fixed,
documented, configurable loopback port. Port conflicts fail startup clearly.
`wm` reads the same config to discover a non-default port and accepts an
explicit URL override.

The WebSocket uses JSON text frames. V1 does not design protocol version
negotiation before the protocol has been prototyped. Browser origins are denied
by default and enabled through a configurable exact allowlist. Non-browser
local clients are allowed. There is no authentication; documentation states
that the API assumes a trusted single-user local-process environment.

CLI and WebSocket are thin frontends to one command/query handler. Ordinary CLI
commands connect through WebSocket. The CLI outputs JSON always, with optional
table/quiet formats.

Lifecycle operations are managed by the signed native host and launchd service tooling:

- `wm service install`
- `wm service start`
- `wm service stop`
- `wm service restart`
- `wm service uninstall`

Command targets default to the focused window and support explicit IDs and
structured selectors. Selectors apply to all matches.

Return modes:

- Default `completion`: wait for verified/fallback commit and return modified
  user-facing state.
- `instant`: return transaction ID and accepted/queued status without state by
  default; an explicit option may include clearly labeled current committed
  state.
- Transaction status remains queryable if completion events are missed.

Sequential command batches execute each command fully in order and stop on the
first failure. V1 has no transaction cancellation.

Initial command surface includes:

- User-facing state and separate observed/desired/health/diagnostic queries
- Display inventory
- All-window inventory and raw diagnostic inventory
- Window focus, directional focus, cycle focus, directional move, resize,
  float/tile, manage/unmanage
- Workspace focus, move window to workspace, and move workspace to display
- Workspace BSP/floating mode
- Retile/reconcile/recover
- Pause/resume
- Configuration validate/reload
- Transaction status
- Event subscribe
- Logs and diagnostic snapshot

No close, quit, minimize, hide, fullscreen, or process-lifecycle actions exist.

## Events

Domain events are ordered and assigned monotonic sequence numbers. The daemon
retains a bounded replay buffer independent of subscribers. Subscribers do not
acknowledge events and cannot block state processing. Slow subscribers are
disconnected. Consumers recover through bounded replay or an authoritative
snapshot when history is unavailable.

Event payloads are idempotent wherever practical. Sequence numbers order
events; state versions identify committed snapshots; transaction IDs correlate
effects.

Subscriptions select topics only. Clients may select projection:

- Typed deltas, default
- Full user-facing snapshots
- Invalidations

Health transitions always emit dedicated events with active issue summaries.
Config errors/recovery, display changes, workspace movement/focus, window state,
transaction completion, reconciliation, automatic repair, pause/resume, and
startup/wake resynchronization are typed topics.

The WM does not accept arbitrary custom user events. Those belong to the future
topbar host's component-owned broker. The daemon does not spawn external hooks;
scripts consume `wm subscribe`.

V1 publishes a documented JSON protocol with TypeScript examples rather than an
official generated client. A future topbar can drive client abstraction design.

## Health, Logging, And Diagnostics

Overall health states:

- `healthy`
- `degraded`
- `recovering`
- `unhealthy`

Health includes typed component issues and capability status. Every transition
emits an event.

Daemon logs are structured JSON with readable formatting/filter/follow through
`wm log`. Default retention is three days with bounded rotation. Titles and
documents are not logged.

`wm diagnostics snapshot` produces a full redacted convergence bundle:

- Effective config summary
- Committed desired state
- Current observed state
- Display topology and work areas
- AX/CG join and health
- Pending retries and active issues
- Recent events and transaction decisions
- Relevant structured logs

## Testing And Prototype Plan

Strong automated coverage is required for deterministic code:

- BSP geometry and tree transformations
- Shared-edge rounding
- Workspace lifecycle and display migration
- Config parsing/delta/full application
- Rules and selectors
- Protocol command/result/event contracts
- Transaction reducer and invariants
- Persistence and release-import behavior

A small practical integration/e2e suite should diagnose real macOS behavior
without blocking the first working prototype on exhaustive coverage.

Prototype sequence begins with inventory and identity, while driving toward a
daily-usable replacement quickly through small integrated milestones.

## Prototype Questions

These are intentionally unresolved until measured on current macOS:

1. Reliable logical window identity across AX handle replacement, duplicate or
   missing CG IDs, native tabs, and multiple app instances
2. Inventory behavior with "Displays have separate Spaces" enabled and disabled
3. Behavior after switching native macOS Spaces
4. Finder/Desktop native focus behavior for empty virtual workspaces
5. Exact display identifier normalization and command selectors
6. Same-application exact-window focus behavior and bounded fallback
7. Geometric versus tree-based directional focus
8. Swap versus remove/reinsert/drop-zone directional and mouse move behavior
9. Floating-geometry-to-BSP reconstruction algorithm
10. Native-host cold/warm CLI and WebSocket latency
