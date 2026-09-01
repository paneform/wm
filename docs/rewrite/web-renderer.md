# Web Renderer Guide

`packages/layout-browser` is the public `@paneform/layout-browser` package and a Vite +
vanilla TypeScript playground. It runs the real `@paneform/layout` engine against a
simulated platform to visualize edge cases, debug multi-display behavior deterministically,
and embed an interactive layout demo.

## Core ideas

- The browser is a better test bench than macOS: deterministic, scriptable, and one
  viewport can render MULTIPLE pseudo-displays and workspaces simultaneously.
- It implements `PlatformAdapter` from docs/rewrite/platform-contract.md with an
  in-memory window system ("web windows"): draggable/resizable DOM rectangles obeying
  scripted personalities (same personality model as the test fake; share concepts, not
  code; the renderer lives in its own package).
- Users can inject events (display connect/disconnect, window close, focus changes,
  topology churn) from a control panel to exercise edge cases live.

## UI sketch

- Canvas area renders each configured pseudo-display as a bordered rectangle at its
  canonical-space position (negative origins render fine — pan/zoom the canvas).
- Overlays per display: work area inset, workspace name + mode badge, BSP tree split
  lines, window frames colored by state (managed/floating/parked/quarantined),
  parked windows shown as slivers at corners.
- Side panels: world inspector (windows, capabilities, learned constraints, profiles,
  parking facts), action log (engine events), scenario controls (scripted edge cases:
  "disconnect display", "fixed-size window appears", "app clamps min width", ...).
- Scenario recorder: record event/command sequences, replay deterministically.

## Non-goals

No real window control, no styling ambitions beyond clarity, no persistence beyond
localStorage of scenarios. It is a debugging/visualization tool.

## Implementation notes

- Import the engine directly: `import { createEngine } from "@paneform/layout"` — same schemas,
  rules, command bus as production. Renderer drives it through the CommandBus like the
  CLI does, plus direct PlatformAdapter event injection.
- Importing `@paneform/layout-browser` has no browser side effects. Consumers explicitly
  call `createLayoutSimulator(container)` or `mountLayoutRenderer(container, engine)`.
- Existing-engine mounts are read-only unless the trusted host explicitly enables commands.
- The package stylesheet is opt-in through `@paneform/layout-browser/styles.css` and is
  scoped under the renderer mount root.
- Render loop subscribes to committed-state epochs; redraw on change only.
- Determinism: all randomness seeded; scenarios are pure data.
