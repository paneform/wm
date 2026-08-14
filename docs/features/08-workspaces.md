# Feature 08: Workspace Domain And Persistence

Status: Normative for the workspace-model checkpoint

## Scope

This slice implements workspace intent, API, lifecycle, state events, atomic
runtime persistence, verified focus, strict verified BSP tiling, and verified
off-screen workspace parking.

## Workspace State

```json
{
  "name": "T",
  "origin": "runtime",
  "display_id": "display:uuid",
  "preferred_display_id": null,
  "visible": true,
  "focused": true,
  "mode": "bsp",
  "margin": {"top": 0, "right": 0, "bottom": 0, "left": 0},
  "gap": 8,
  "resize_increment": 0.05,
  "window_ids": ["window:1"],
  "focused_window_id": "window:1",
  "bsp": {
    "root": {"type": "leaf", "window_id": "window:1"}
  }
}
```

Origins: `configured`, `runtime`.

Modes: `bsp`, `floating`.

Exactly one workspace may be globally focused. At most one workspace per
display may be visible. Every workspace has a display assignment.

## BSP Tree

Leaf:

```json
{"type":"leaf","window_id":"window:1"}
```

Split:

```json
{
  "type": "split",
  "axis": "vertical",
  "ratio": 0.5,
  "first": {},
  "second": {}
}
```

Axes describe the divider: `vertical` creates left/right children;
`horizontal` creates top/bottom children.

Invariants:

- Every tiled `window_id` appears exactly once in the BSP tree.
- Every BSP leaf appears in `window_ids`.
- Floating-mode workspaces may retain an empty/rootless BSP tree.
- Ratios are finite and strictly between 0 and 1.
- No duplicate workspace names.
- Focused window belongs to the workspace.
- Empty runtime workspace is deleted when it transitions from visible to parked.
- Empty configured workspace persists.

## Commands

### `workspace.list`

Params: `{}`

Result:

```json
{"workspaces":[],"focused_workspace_name":"T"}
```

### `workspace.focus`

Params:

```json
{"name":"T","display_id":null}
```

Behavior:

- Existing visible workspace focuses in place.
- Existing parked workspace reveals on its assigned display and parks the
  currently visible workspace there.
- Missing workspace is created empty/runtime on the supplied display.
- If no display supplied, use the focused workspace display. If none exists,
  the handler supplies frontmost-window display, then pointer display, then
  primary display.
- If an empty runtime workspace is parked by this operation, delete it.
- `display_id` is optional and resolves from the focused workspace display,
  frontmost-window display, then primary display.
- If the workspace has windows, raise and focus its remembered focused window
  and verify the owning process is the system frontmost application. AX window
  focus attributes are best-effort because tested applications report stale
  values after successful activation. Empty workspaces require no platform
  action.
- Focusing a BSP workspace with multiple windows applies its tree to the AX
  coordinate-space display visible frame, including margins and gaps. Each frame
  is read back; failure aborts the focus transaction and restores windows already
  changed. Applications whose minimum sizes exceed their tile currently fail
  rather than receiving an adapted layout.
- Parking records exact window frames and moves outgoing windows beyond the
  bottom-right corner of the display union while preserving size. Reveal restores those
  exact frames before tiling and focus. Every frame transition is read back, and
  failures roll back prior platform changes before workspace state is committed.
  Apps that macOS constrains to a 40-point reachable strip are accepted only
  when size remains exact and the strips are at the display union's bottom-right
  corner.

### `workspace.move_window`

Params:

```json
{"window_ids":["window:1"],"workspace":"T"}
```

Behavior:

- Follow semantics only: destination becomes visible and globally focused.
- Missing destination is created runtime on the source workspace display.
- Remove each window from its source tree, promote sibling subtree, and insert
  into the destination by splitting its most recently focused leaf.
- If destination is empty, create a leaf.
- Default split derives from target tile geometry later; this model checkpoint
  uses vertical 50/50 with new window second and marks the split decision as
  provisional.
- Moving the last window out of a runtime workspace deletes it only when it is
  parked by the destination focus transition.
- All selected windows mutate in one atomic intent transaction.
- The resulting destination focus, reveal, tiling, and outgoing parking complete
  and verify before workspace state is committed.

### `workspace.move_display`

Params:

```json
{"workspace":"T","display_id":"display:uuid"}
```

Behavior:

- Persist runtime display assignment override.
- Workspace remains visible and globally focused.
- Park visible workspace on destination display.
- Source display reveals its one remembered previous workspace if valid;
  otherwise it becomes empty.
- Destination workspace becomes that display's remembered previous workspace.
- Platform movement, tiling, and focus verify before assignment state commits.

### `workspace.set_mode`

Params:

```json
{"workspace":"T","mode":"floating"}
```

Changing the focused workspace mode reconciles its platform geometry before the
mode state commits. Parked workspaces update intent without moving windows.

## Result Envelope

Every workspace mutation returns:

```json
{
  "workspace_state": {},
  "modified_workspaces": ["T"],
  "deleted_workspaces": [],
  "effect_status": "verified"
}
```

Workspace mutations report `verified` after platform reconciliation succeeds.

## CLI

```text
wm workspace list
wm workspace focus NAME [--display DISPLAY_ID]
wm workspace move-window NAME [WINDOW_ID ...]
wm workspace move-display NAME DISPLAY_ID
wm workspace mode NAME bsp|floating
```

`move-window` with no IDs targets the currently observed focused window. The
handler resolves that default before applying workspace intent.

## Events

Topics:

- `workspace.changed`
- `workspace.focused`
- `workspace.created`
- `workspace.deleted`
- `workspace.display_changed`
- `workspace.mode_changed`

Delta projection contains added, updated, and removed workspace names/entities.
Snapshot projection contains complete workspace state.

## Persistence

Path:

`$XDG_STATE_HOME/wm/state.json`, default `~/.local/state/wm/state.json`.

The snapshot includes:

- Snapshot schema/build version
- State version
- Workspace states
- Global focused workspace name
- Per-display visible and one previous workspace name
- Runtime display assignment overrides
- Exact pre-parking frames for parked windows

Write to a same-directory temporary file, fsync, then atomic rename after each
committed workspace transaction. Invalid state is quarantined and rebuilt.

Inventory-only refreshes do not write workspace runtime state.
Parking metadata and workspace visibility commit atomically after verified
platform reconciliation, allowing exact reveal after daemon restart.

## Initial State

Until JSONC config is implemented, startup assigns normal observed windows that
are not already persisted to configured workspace `1` on the primary display.
The command handler validates referenced display/window IDs against current
committed inventory.

Inventory refresh reconciles workspace membership: newly observed normal windows
join the focused workspace, or configured workspace `1` when none is focused.
Vanished windows are removed with BSP sibling promotion, focused-window repair,
parked-frame cleanup, runtime workspace lifecycle cleanup, and atomic persistence.
The daemon performs this refresh automatically every two seconds; manual refresh
uses the same coalescing state path.

When strict BSP frames reveal a plausible application clamp, the daemon caches
that window's observed width/height lower bounds, recomputes subtree allocations,
and retries one adapted transaction. Infeasible or unpredictable constraints
still fail closed and roll back.

## Tests

- Focus creates missing workspace on resolved display.
- Focus visible workspace in place.
- Focus parked workspace parks destination visible workspace.
- Empty runtime workspace deletes when parked; configured workspace persists.
- Move window creates destination, removes/promotes source, inserts destination,
  and follows focus.
- Multi-window move is atomic and deterministic.
- Move display updates previous workspace slots correctly.
- Invalid window/display/workspace references do not mutate state.
- Snapshot writes atomically and reloads identically.
- Corrupt snapshot quarantines and rebuilds empty.
- CLI/WebSocket map to one handler and emit documented events.
