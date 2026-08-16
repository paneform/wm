# wm Prototype API Contract

Status: Normative for the inventory-and-identity prototype

## Scope

The prototype proves:

- One Swift `wm` binary with daemon and client modes
- A fixed configurable loopback WebSocket endpoint
- Shared request routing for CLI and direct WebSocket clients
- AX and Core Graphics raw inventory
- Normalized window and display inventory
- Identity/classification diagnostics
- Initial snapshots and live inventory events
- Ordered event sequences and bounded replay
- JSON output suitable for Bash and TypeScript

Window mutation, BSP, workspace parking, persistence, config hotload, and launchd
installation are reserved command namespaces but are not implemented by this
prototype.

## Transport

- URL: `ws://127.0.0.1:17832/v1`
- Configurable CLI override: `--url ws://127.0.0.1:PORT/v1`
- Frames: UTF-8 JSON text
- Maximum inbound message: 1 MiB
- Browser `Origin`: denied unless exactly allowlisted by daemon arguments/config
- Non-browser clients with no `Origin` header: allowed
- Authentication: none

The server sends one `session.welcome` message immediately after upgrade.

## Common Types

### Identifiers

Prototype IDs are strings and explicitly provisional:

- `request_id`: client-generated UUID or unique string
- `transaction_id`: daemon-generated UUID
- `subscription_id`: client-generated unique string
- `window_id`: daemon-generated normalized identity for this daemon session
- `display_id`: canonical identifier selected from current OS observations

Raw PID and CG window ID remain separate observation fields.

### Rectangle

```json
{
  "x": 0,
  "y": 0,
  "width": 1512,
  "height": 982
}
```

Coordinates are logical macOS points in one documented global coordinate
system. Raw source rectangles additionally identify their source API.

### Health

```json
{
  "status": "healthy",
  "issues": [],
  "capabilities": {
    "accessibility": true,
    "screen_recording": true,
    "window_inventory": true,
    "pointer_warp": null
  }
}
```

Statuses: `healthy`, `degraded`, `recovering`, `unhealthy`.

## Client Messages

### Uncooperative Window Policy

Set the session-wide policy:

```json
{"method":"uncooperative_window_policy.set","params":{"policy":"greedy"}}
```

Set a per-workspace runtime override:

```json
{"method":"uncooperative_window_policy.set","params":{"workspace":"T","policy":"overlap"}}
```

Accepted policies are `greedy`, `stack`, `overlap`, and `reject`. Runtime values
are in-memory overlays and do not persist cooperation profiles.

### Adaptive Geometry Policy

`max_geometry_retries` defaults to `5` and accepts `1` through `5`.
`geometry_profile_mode` accepts:

- `store`: store and reuse learned constraints and retry policy.
- `infer`: infer constraints independently on every request.
- `optimistic`: try ideal geometry first, then use learned constraints as fallback.

Both settings support global and per-workspace configuration under `defaults`
and each `workspaces` entry. Runtime updates are partial in-memory overlays:

```json
{"method":"geometry_policy.set","params":{"max_geometry_retries":4,"geometry_profile_mode":"store"}}
{"method":"geometry_policy.set","params":{"workspace":"T","geometry_profile_mode":"optimistic"}}
```

CLI equivalents are `wm geometry-policy --max-retries 4 --profile-mode store`
and `wm geometry-policy T --profile-mode optimistic`.

Tiling, window moves, and workspace focus first request ideal geometry. A stable
known constraint is accepted promptly and all workspace frames are replanned
with the configured `greedy`, `stack`, `overlap`, or `reject` policy. A higher or
new observed constraint is learned after engine retries, then the workspace is
replanned.

### Directional Window Commands

`window.focus` and `window.move` accept `{"direction":"left|down|up|right"}`.
Both target the focused BSP workspace. Focus chooses and verifies the nearest
window in that spatial half-plane, then persists the remembered focused window.
Move swaps the focused and target BSP leaves, preserves split topology/ratios,
verifies the complete retile and exact raised focus, then commits and emits a
workspace event. Floating workspaces, absent focus, edge directions without a
target, stale inventory, and failed effects return errors without committing.

### Request

```json
{
  "type": "request",
  "request_id": "req-1",
  "method": "state.get",
  "params": {}
}
```

Every request receives exactly one correlated `response` unless the connection
closes.

### Subscribe

```json
{
  "type": "subscribe",
  "request_id": "req-2",
  "subscription_id": "inventory",
  "topics": ["window.inventory", "display.inventory", "health.changed"],
  "projection": "delta",
  "after_sequence": null
}
```

Projection values:

- `delta`: typed changed entities, default
- `snapshot`: complete user-facing state after each committed inventory refresh
- `invalidation`: topic and state version only

`after_sequence` requests replay strictly after that sequence. Omit/null for a
fresh subscription. A successful subscription response is followed by a
current event/snapshot so clients do not race initial query and subscription.

### Unsubscribe

```json
{
  "type": "unsubscribe",
  "request_id": "req-3",
  "subscription_id": "inventory"
}
```

## Server Messages

### Welcome

```json
{
  "type": "session.welcome",
  "session_id": "session-uuid",
  "daemon_version": "0.0.1-dev",
  "current_sequence": 42,
  "state_version": 7,
  "health": {
    "status": "healthy",
    "issues": [],
    "capabilities": {
      "accessibility": true,
      "screen_recording": true,
      "window_inventory": true,
      "pointer_warp": null
    }
  }
}
```

### Successful Response

```json
{
  "type": "response",
  "request_id": "req-1",
  "ok": true,
  "result": {},
  "state_version": 7
}
```

### Error Response

```json
{
  "type": "response",
  "request_id": "req-1",
  "ok": false,
  "error": {
    "code": "method_not_found",
    "message": "unknown method: workspace.focus",
    "retryable": false,
    "details": {}
  },
  "state_version": 7
}
```

Prototype error codes:

- `invalid_message`
- `invalid_params`
- `method_not_found`
- `not_ready`
- `permission_denied`
- `inventory_failed`
- `subscription_not_found`
- `replay_unavailable`
- `internal_error`

### Event

```json
{
  "type": "event",
  "sequence": 43,
  "state_version": 8,
  "timestamp": "2026-08-14T03:00:00.000Z",
  "topic": "window.inventory",
  "data": {
    "added": [],
    "updated": [],
    "removed": []
  }
}
```

### Resync Required

```json
{
  "type": "resync.required",
  "subscription_id": "inventory",
  "requested_after_sequence": 10,
  "oldest_available_sequence": 30,
  "current_sequence": 43,
  "state_version": 8
}
```

The client must request a new snapshot and subscribe from the resulting current
sequence.

## Inventory Models

### Display

```json
{
  "id": "display:uuid-or-os-id",
  "name": "Built-in Retina Display",
  "is_builtin": true,
  "is_primary": true,
  "frame": {"x": 0, "y": 0, "width": 1512, "height": 982},
  "visible_frame": {"x": 0, "y": 32, "width": 1512, "height": 950},
  "backing_scale": 2,
  "identifiers": {
    "nsscreen_number": "1",
    "cg_direct_display_id": "1",
    "uuid": null,
    "vendor_id": null,
    "product_id": null,
    "serial_number": null
  }
}
```

Unknown identifier values are `null`, never invented placeholders.

### Raw AX Window

```json
{
  "source": "accessibility",
  "pid": 1234,
  "app_name": "Ghostty",
  "bundle_id": "com.mitchellh.ghostty",
  "title": "tmux",
  "role": "AXWindow",
  "subrole": "AXStandardWindow",
  "frame": {"x": 8, "y": 40, "width": 1496, "height": 934},
  "minimized": false,
  "fullscreen": false,
  "focused": true,
  "main": true,
  "cg_window_id": 155,
  "read_errors": []
}
```

`cg_window_id` may be null, zero, or duplicated and is not assumed unique.

### Raw CG Window

```json
{
  "source": "core_graphics",
  "cg_window_id": 155,
  "pid": 1234,
  "owner_name": "Ghostty",
  "title": "tmux",
  "layer": 0,
  "alpha": 1,
  "on_screen": true,
  "frame": {"x": 8, "y": 40, "width": 1496, "height": 934}
}
```

### Normalized Window

```json
{
  "id": "window:session-opaque-id",
  "pid": 1234,
  "app_name": "Ghostty",
  "bundle_id": "com.mitchellh.ghostty",
  "executable_path": "/Applications/Ghostty.app/Contents/MacOS/ghostty",
  "title": "tmux",
  "role": "AXWindow",
  "subrole": "AXStandardWindow",
  "frame": {"x": 8, "y": 40, "width": 1496, "height": 934},
  "display_id": "display:uuid-or-os-id",
  "classification": "normal",
  "management": "unmanaged",
  "rejection_reasons": [],
  "identity": {
    "cg_window_id": 155,
    "join_confidence": "exact",
    "signals": ["pid", "cg_window_id", "frame", "title"]
  },
  "observations": {
    "accessibility": true,
    "core_graphics": true,
    "minimized": false,
    "fullscreen": false,
    "focused": true,
    "main": true,
    "on_screen": true
  },
  "health": {
    "status": "healthy",
    "issues": []
  }
}
```

Classification values:

- `normal`
- `transient`
- `system_ui`
- `uncertain`

Management values for the prototype:

- `unmanaged`
- `ineligible`
- `pending`

Join confidence values:

- `exact`: PID plus valid matching CG window ID
- `strong`: PID plus frame and stable metadata
- `weak`: PID plus partial metadata
- `ax_only`
- `cg_only`

The prototype retains unmatched AX and CG observations in raw inventory. Only
AX-controllable records become normalized windows; unmatched CG records remain
diagnostic surfaces rather than actionable windows.

## State Models

### User-Facing State

```json
{
  "state_version": 8,
  "sequence": 43,
  "health": {},
  "focused_window_id": "window:...",
  "displays": [],
  "windows": []
}
```

### Observed State

Adds inventory timestamps, source health, scan duration, per-app scan results,
raw counts, and join statistics.

### Diagnostic Inventory

Returns:

- Raw AX windows
- Raw CG windows
- Normalized windows
- AX records rejected before normalization with reasons
- Join decisions and confidence
- Permission/source health

## Methods

### Prototype Implemented

| Method | Params | Result |
|---|---|---|
| `state.get` | `{}` | User-facing state |
| `state.observed` | `{}` | Observed state |
| `health.get` | `{}` | Health |
| `display.list` | `{}` | `{ "displays": [...] }` |
| `window.list` | `{}` | `{ "windows": [...] }` |
| `window.focus` | `{ "direction": "left" }` | Direction, source/target IDs, workspace, verified status |
| `window.move` | `{ "direction": "left" }` | Direction, source/target IDs, workspace, verified status |
| `diagnostics.inventory` | `{}` | Diagnostic inventory |
| `inventory.refresh` | `{}` | New observed/user-facing state after scan |
| `daemon.ping` | `{}` | Session/version/readiness data |

`inventory.refresh` is serialized and coalesces equivalent concurrent refresh
requests. It is a prototype administrative mutation and returns only after the
new inventory commits.

### Reserved, Not Implemented

These names are reserved to avoid CLI/API redesign but return
`method_not_found` until their feature slice exists:

- `window.focus`, `window.move`, `window.resize`, `window.float`,
  `window.tile`, `window.manage`, `window.unmanage`
- `workspace.focus`, `workspace.move_window`, `workspace.move_display`,
  `workspace.set_mode`
- `layout.retile`, `state.reconcile`, `window.recover`
- `daemon.pause`, `daemon.resume`
- `config.validate`, `config.reload`
- `transaction.get`
- `diagnostics.snapshot`

## Event Topics

Prototype topics:

- `window.inventory`
- `display.inventory`
- `health.changed`
- `inventory.refreshed`
- `daemon.ready`

Window/display delta events compare normalized current state to the previous
committed inventory. Raw AX/CG observations are query-only in the prototype to
avoid publishing unstable platform details as domain events.

## Event Retention And Backpressure

- Replay buffer: latest 2,048 events or 5 minutes, whichever is smaller
- Per-client outbound queue: 256 messages
- Inventory events are coalescible by topic/state version before enqueue
- Responses and resync messages are non-coalescible
- A client whose queue remains full is disconnected
- The inventory/state actor never waits for socket writes

## CLI Surface

All output is JSON. Exit code is zero only when the response is `ok: true`.

```text
wm daemon [--host 127.0.0.1] [--port 17832] [--allow-origin ORIGIN ...]
wm ping [--url URL]
wm state [--url URL]
wm state observed [--url URL]
wm health [--url URL]
wm display list [--verbose] [--url URL]
wm monitor list [--verbose] [--url URL] # CLI alias
wm window list [--url URL]
wm window focus left|down|up|right [--url URL]
wm window move left|down|up|right [--url URL]
wm diagnostics inventory [--url URL]
wm inventory refresh [--url URL]
wm subscribe [TOPIC ...] [--projection delta|snapshot|invalidation]
             [--after-sequence N] [--url URL]
wm start                               # reserved lifecycle command
wm stop [--force]                      # reserved lifecycle command
wm restart                             # reserved lifecycle command
wm install-service                     # reserved lifecycle command
wm uninstall-service                   # reserved lifecycle command
```

`wm subscribe` prints one JSON server message per line until interrupted.

Unknown/reserved commands fail with a structured local CLI error or correlated
daemon `method_not_found` response; they never print help text to stdout.

## TypeScript Example

```ts
const socket = new WebSocket("ws://127.0.0.1:17832/v1");

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({
    type: "subscribe",
    request_id: crypto.randomUUID(),
    subscription_id: "topbar-inventory",
    topics: ["window.inventory", "display.inventory", "health.changed"],
    projection: "delta",
    after_sequence: null,
  }));
});

socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.type === "event") {
    console.log(message.topic, message.data);
  }
});
```

## CLI Examples

```bash
wm state | jq '.result.windows[] | {id, app_name, classification}'

wm diagnostics inventory \
  | jq '.result.rejected_ax_windows[] | {app_name, role, reasons}'

wm subscribe window.inventory health.changed \
  | while IFS= read -r event; do
      jq -r '.topic' <<<"$event"
    done
```

## Contract Tests

The implementation must test:

- Every client/server message round-trips through `Codable`
- Unknown fields and malformed message variants fail deterministically
- Request IDs correlate responses
- CLI commands map to the documented methods and params
- Alias `monitor list` maps to `display.list`
- State/sequence values are monotonic
- Subscription starts with current projection without a query race
- Replay returns the requested retained range
- Expired replay sends `resync.required`
- Slow subscribers cannot block the state actor
- JSON field names and enum values match this document
