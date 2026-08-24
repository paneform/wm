# Web Renderer Guide

`packages/renderer` — a Vite + vanilla TypeScript web app (no framework) that runs the
REAL engine from `@wm/engine` against a simulated platform. Purpose: visualize layout
edge cases, debug multi-display behavior deterministically, and demo the engine.

## Core ideas

- The browser is a better test bench than macOS: deterministic, scriptable, and one
  viewport can render MULTIPLE pseudo-displays and workspaces simultaneously.
- It implements `PlatformAdapter` from docs/rewrite/platform-contract.md with an
  in-memory window system ("web windows"): draggable/resizable DOM rectangles obeying
  scripted personalities (same personality model as the test fake; share concepts, not
  code — renderer lives in its own package).
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

- Import engine directly: `import { createEngine } from "@wm/engine"` — same schemas,
  rules, command bus as production. Renderer drives it through the CommandBus like the
  CLI does, plus direct PlatformAdapter event injection.
- Render loop subscribes to committed-state epochs; redraw on change only.
- Determinism: all randomness seeded; scenarios are pure data.
