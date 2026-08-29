# Architecture: TypeScript Core + Platform Adapter

Status: Current production architecture. Read this document first, plus any document
referenced by the task.

## Why a rewrite

The architecture separates:

- **Engine (portable TypeScript)**: all policy. Rules as Effect.ts effects, probes,
  constraint learning, BSP layout, transactions with verified postconditions, config,
  command execution layer, WebSocket/CLI message schemas. Knows nothing about macOS.
- **Platform adapter (dumb)**: translates macOS observations/events into generic engine
  representations and generic commands into platform API calls. No policy.
- **Frontends**: TS CLI and WebSocket server are thin wrappers over one command
  execution layer. A web renderer visualizes the engine for debugging and testing.

The engine assumes nothing about the host system. It discovers reality through
observations and probes and adapts.

## Non-negotiable principles

1. **All boundary data is validated with Effect Schema.** Observations in, commands out,
   config in, events out, wire messages both ways. Invalid input is an error, never a guess.
2. **Nothing platform-specific in the engine.** No Node-only APIs either (no `fs`, no
   `net`, no `process`). Runtime services (file watching, socket servers, process spawn)
   are interfaces defined by the engine and implemented in the node host package.
3. **Rules are deterministic pure-ish effects.** A rule inspects the world snapshot and
   emits actions; it does not perform I/O itself. Each rule lives in its own file.
4. **Verification over trust.** A geometry write is not success until readback confirms
   it (or a documented fallback applies). Transactions commit only after verification.
5. **Learned constraints are evidence-gated.** Never learn constraints from observations
   that were clamped by the OS work area or that equal the untouched initial frame.
6. **Coordinates:** one canonical OS space everywhere (top-left of primary display,
   y-down). Conversion from AppKit happens once, in the adapter, at enumeration time.
7. **Simple core loop.** The layout algorithm is: apply ordered rules that may or may not
   apply to a window based on observed capabilities and attributes. No hidden global logic.
8. **Clean, simple, readable code.** Prefer small modules and explicit data flow.

## Package layout (pnpm workspace)

```
packages/
  engine/            @wm/engine — portable core (Effect, effect Schema). No runtime deps.
    src/
      schema.ts      All Effect Schema domain types (single source of truth)
      world.ts       World snapshot type + immutable update helpers
      platform.ts    PlatformAdapter interface + event/command types
      probe.ts       Probe runner (capability + constraint probing)
      learn.ts       Constraint/cooperation profile learning (evidence-gated)
      observation-store.ts Browser-safe durable observation port + versioned document
      geometry.ts    Frame math, classification of write outcomes, retry ladders
      parking.ts     Offscreen parking search (clamp discovery, corner planning)
      layout/bsp.ts  BSP tree ops + constraint-aware tiling math
      rules/*.ts     One rule per file; index exports ordered rule list
      engine.ts      Pipeline: events → world → rules → plan → execute → commit
      transactions.ts Transaction queue/retry/verification state machine
      commands.ts    Command execution layer shared by CLI/WebSocket/renderer
      events.ts      Domain event bus, sequence numbers, replay buffer
      config.ts      Config schema + ConfigSource interface (loader impl is host's)
      transport.ts   WebSocketPort interface + message schemas for CLI/WS
    test/            Vitest suites + test/helpers/fake-platform.ts (owned by TEST agent)

  node-host/         @wm/node-host — Node implementations of engine ports
    src/config-file.ts   fs config loader/watcher implementing ConfigSource
    src/observation-file.ts atomic fs implementation of ObservationStore
    src/ws-server.ts     ws-based WebSocketPort implementation
    src/cli.ts           `wm` bin: thin arg parsing → CommandBus → print JSON

  platform-macos/    @wm/platform-macos — macOS adapter
    sidecar/             Swift package (see docs/rewrite/platform-contract.md)
    src/host.ts          TS glue: sidecar messages ↔ PlatformAdapter

  renderer/          @wm/renderer — web visualization (Vite + vanilla TS)
```

Dependency direction: `node-host`, `platform-macos`, `renderer`, CLI → `engine`.
`engine` depends on nothing runtime-specific. `renderer` runs the engine directly against
a simulated platform (the same interface as the macOS adapter).

## Data flow

```
macOS (AX/CoreGraphics)
   │  observations/events, converted once into canonical space
   ▼
PlatformAdapter (sidecar host)  ──generic events──►  Engine
   ▲                                                │ normalize/join → World
   └────generic commands (move/focus/probe op)──────┤ rules (ordered Effects) → actions
                                                    │ transaction executor: apply → readback
                                                    │ verify → classify → learn → commit
                                                    ▼
                                         committed State + domain events
                                              │                 │
                                    CommandBus ◄─ CLI / WS      └─► Renderer (simulated
                                    (same execution layer)          platform, no macOS)
```

The engine also receives an optional `ObservationStore`. Production injects the
Node file implementation. A browser may inject IndexedDB or omit the store for
session-only learning. The engine owns validation and learning semantics; hosts
own storage I/O.

## Key contracts

- `docs/rewrite/domain-schema.md` — exact schemas, coordinate rules, constants table.
  THE source of truth for types. Agents must not invent divergent shapes.
- `docs/rewrite/platform-contract.md` — PlatformAdapter interface, sidecar wire protocol,
  and the catalog of documented macOS behaviors that fakes must emulate and the real
  adapter must survive.
- `docs/rewrite/engine-guide.md` — pipeline, rule catalog, probe algorithms, learning,
  transactions.
- `docs/rewrite/testing-guide.md` — headless test strategy and the edge-case matrix
  covered by the current TypeScript and native-host suites.
- `docs/rewrite/web-renderer.md` — renderer spec.

## Design history

- Bean history (`.beans/`) records hard-won lessons: stale-probe starvation, orthogonal
  clamp misclassification, learning constraints from display-clamped observations,
  topology migration bugs, reentrancy during probes. See beans:
  wm-ysdj, wm-fh5i, wm-6aea, wm-dm8l, wm-45sa, wm-xq1q, wm-v270.
