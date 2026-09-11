# Design Decisions

This log records architectural decisions whose constraints and tradeoffs should
remain visible as the implementation evolves.

## 2026-08-26: Monitor Hotkeys in the Native Service

**Status:** Accepted

### Context

Window-management interactions should reliably complete with sub-frame input
latency. Local IPC is sub-millisecond, but launching even a basic CLI process
costs approximately 10-20 ms. An external hotkey program that starts the WM CLI
for every keypress therefore consumes roughly one frame before layout or native
window operations begin. Process-launch variance also makes the latency budget
unreliable.

### Decision

Hotkey monitoring is part of the long-lived native window-management service.
The same persistent process that owns the macOS window-management APIs listens
for configured keydown chords and forwards matched actions over the existing IPC
channel to the TypeScript engine. Keybinds and actions remain config-driven; the
native layer provides event capture and transport rather than layout policy.

### Consequences

- Keypress handling avoids per-event process startup and leaves more of the
  frame budget available to the TypeScript layout engine and native mutations.
- Actions are dispatched on matching keydown rather than waiting for keyup.
- Left and right modifiers can be tracked independently by the native event API.
- The native service now requires Input Monitoring permission in addition to
  the permissions needed for window management.
- Hotkey lifecycle, configuration hotload, and daemon supervision are coupled;
  failure of the native service also removes hotkey handling.
- External hotkey daemons must be disabled when equivalent native bindings are
  active, otherwise commands can be delivered twice.

## 2026-09-02: Engine Controls Hotkey Swallowing During Pause

**Status:** Accepted

### Context

The native event tap must swallow configured hotkeys during normal operation so
the application underneath does not also act on a window-management shortcut.
When the engine is paused, layout-affecting hotkeys must remain visible to the
application underneath. The pause toggle must still be usable, and it must not
leak through to that application.

### Decision

The layout engine remains the source of truth for pause state. The platform
adapter exposes an optional `setHotkeySwallowing` control, and the engine sends
the desired state to the native host during startup and every pause transition.

Keybind configuration also sends the native host the chord strings that must
remain swallowed while paused. The node host derives this list from configured
actions: `togglePause` and `resume` are exceptions; `pause` and every other
action are not. The Swift sidecar only matches chords, forwards every matched
action to the engine, and applies the swallow setting. It does not parse command
strings or make pause-policy decisions.

### Consequences

- Paused hotkeys still reach the engine, so command validation and pause gating
  remain centralized.
- Non-exception hotkeys are visible to the focused application while paused.
- The configured unpause binding remains swallowed and can always reach the
  engine.
- Adapters without native hotkey capture can omit the control and remain
  portable.

## 2026-08-26: Native Host Owns the Engine Process

**Status:** Accepted

### Context

When Node launches the native service, macOS can attribute TCC responsibility
to the unsigned Node parent rather than to the executable that calls the native
APIs. This makes permission onboarding ambiguous and can require permissions on
processes which do not themselves access protected APIs. The product also needs
one clear executable for launchd ownership, permission prompts, and native API access.

### Decision

The signed native `wm` host is the root of the product process tree. Launchd
starts that host; it owns Accessibility, CoreGraphics, Input Monitoring, and
permission onboarding, then launches and supervises the bundled TypeScript
engine as a child. Native events and operations continue to use the existing
versioned protocol over private inherited transport rather than exposing native
APIs directly to TypeScript.

The signed `wm` executable runs as the native supervisor and launches the TypeScript
engine child. Short-lived TypeScript CLI clients send commands over the loopback
WebSocket. Native hotkeys use the persistent private protocol path and do not create a
CLI process.

### Consequences

- macOS permissions belong to one stable signed native application identity;
  Node requires no TCC grants.
- Launchd supervises one entrypoint, and native-host or engine-child failure
  restarts the complete stack.
- Release bundles must include a Node runtime and compiled engine artifacts.
- The native host must supervise child startup, shutdown, logs, and protocol
  compatibility.
- Development may retain a source-based Node child and the old spawn direction
  temporarily, but production uses native-parent ownership.
- CLI process-launch cost remains acceptable for explicit human commands;
  configured hotkeys bypass CLI creation entirely.
