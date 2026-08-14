# Feature 07: Explicit Verified Window Geometry

Status: Prototype slice

## Purpose

Prove reliable AX frame mutation and postcondition verification before BSP or
automatic management can move windows.

## API

### `window.frame.get`

Params:

```json
{
  "window_id": "window:session-id"
}
```

Result:

```json
{
  "window_id": "window:session-id",
  "frame": {"x": 8, "y": 40, "width": 1496, "height": 934},
  "observed_at": "2026-08-14T05:30:00.000Z"
}
```

### `window.frame.set`

Params:

```json
{
  "window_id": "window:session-id",
  "frame": {"x": 100, "y": 100, "width": 900, "height": 700},
  "tolerance": 1,
  "attempts": 3
}
```

Defaults: `tolerance=1` logical point per field, `attempts=3`. Attempts must be
between 1 and 5. Tolerance must be between 0 and 20.

Result:

```json
{
  "window_id": "window:session-id",
  "requested_frame": {},
  "observed_frame": {},
  "verified": true,
  "attempts": 1,
  "strategy": "position_then_size",
  "duration_ms": 12
}
```

Strategies are attempted in this order:

1. Set position, then size.
2. Set size, then position.
3. Repeat position, then size after a short bounded delay.

Each attempt reads frame back. A successful AX write is not completion without
readback within tolerance.

Errors:

- `window_not_found`
- `window_not_controllable`
- `invalid_frame`
- `geometry_rejected`
- `geometry_verification_failed`
- `inventory_stale`

No desired workspace state is committed by this prototype command. It is a
diagnostic explicit mutation only.

## CLI

```text
wm window frame get WINDOW_ID
wm window frame set WINDOW_ID X Y WIDTH HEIGHT
  [--tolerance POINTS] [--attempts COUNT]
```

Output remains the canonical JSON response envelope.

## Handle Resolution

The normalized inventory must provide a resolver key sufficient to find the
live AX window without exposing AX objects in Sendable state. Resolution may use
PID plus current AX/CG observations, but must verify the resolved window still
matches the requested normalized identity before mutation.

If identity cannot be resolved unambiguously, fail rather than moving another
window.

## Tests

- Fake adapter accepts exact frame on first strategy.
- Fake adapter clamps size and fails verification with observed frame.
- Adapter succeeds only on second strategy.
- Missing/stale/ambiguous identity never invokes write.
- Invalid dimensions and bounds reject before platform calls.
- CLI and direct WebSocket map to the same method/params.
- Live test always captures original frame and restores it after verification.
