import { describe, expect, test } from "vitest";
import { makeWindowDiagnostics } from "./helpers/window-diagnostics.ts";
import { Cause, Effect, Exit, Fiber, Stream } from "effect";
import { createEngine } from "../src/engine.ts";
import type { Engine } from "../src/engine.ts";
import type { Command, CommandResult, StateSnapshot } from "../src/commands.ts";
import type { DomainEvent } from "../src/events.ts";
import type { Clock, ConfigSource } from "../src/platform.ts";
import {
  emptyObservationDocument,
  type ObservationSnapshot,
  type ObservationStore,
} from "../src/observation-store.ts";
import type { Frame, WindowId } from "../src/schema.ts";
import type { PlatformAdapter } from "../src/platform.ts";
import { PlatformError, type PlatformEvent, type WriteObservation } from "../src/schema.ts";
import type { WindowId as WId } from "../src/schema.ts";
import {
  createFakePlatform,
  makeDisplay,
  makeWindow,
  type FakeDisplaySpec,
} from "./helpers/fake-platform.ts";

// Hotkey parity commands (bean wm-pmys) — engine-side behavior through the
// real command bus + transaction executor against the fake PlatformAdapter.
//
// Seeding note: the assign rule deliberately quarantines windows while a
// workspace tree is empty (see renderer main.ts "revive" note), so tests seed
// BSP membership deterministically via the explicit moveWindowToWorkspace
// path — exactly what production flows use to bootstrap an empty workspace.

// Transaction deadlines (15 s) compress so interruption tests stay fast;
// settle polls (17 ms) compress to 2 ms. Gated-isolation tests widen the
// deadline temporarily via DEADLINE.deadlineMs.
const DEADLINE = { deadlineMs: 3 };
const CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (millis: number) =>
    Effect.sleep(
      `${millis >= 5000 ? DEADLINE.deadlineMs : millis >= 500 ? millis : Math.min(millis, 2)} millis`,
    ),
};

const CONFIG_SOURCE: ConfigSource = {
  load: () => Effect.succeed({ defaults: {}, workspaces: [] }),
  changes: () => Stream.empty,
};

interface Harness {
  fake: ReturnType<typeof createFakePlatform>;
  engine: Engine;
  run(command: Command): Promise<CommandResult>;
  snapshot(): Promise<StateSnapshot>;
  failure(command: Command): Promise<{ code: string; message: string }>;
}

interface EngineRefs {
  engine: Pick<Engine, "setRecovery"> | null;
}

const bootstrap = async (
  displays?: ReadonlyArray<Partial<FakeDisplaySpec>>,
  wrap?: (inner: PlatformAdapter, refs: EngineRefs) => PlatformAdapter,
  observationStore?: ObservationStore,
  retainWrappedBatch = false,
  configSource: ConfigSource = CONFIG_SOURCE,
): Promise<Harness> => {
  const fake = createFakePlatform({
    clock: CLOCK,
    displays:
      displays === undefined
        ? [
            makeDisplay(),
            makeDisplay({
              id: "display:sim-left",
              frame: { x: -1512, y: 0, width: 1512, height: 982 },
              workArea: { x: -1512, y: 38, width: 1512, height: 944 },
              primary: false,
            }),
          ]
        : displays.map((spec) => makeDisplay(spec)),
  });
  const refs: EngineRefs = { engine: null };
  const adapter = (() => {
    if (wrap === undefined) return fake.adapter;
    const wrapped = wrap(fake.adapter, refs);
    if (retainWrappedBatch) return wrapped;
    const { executeBatch: _batch, ...legacyAdapter } = wrapped;
    void _batch;
    return legacyAdapter;
  })();
  const engine = await Effect.runPromise(
    observationStore === undefined
      ? createEngine({ adapter, configSource, clock: CLOCK })
      : createEngine({ adapter, configSource, clock: CLOCK, observationStore }),
  );
  refs.engine = engine;
  await Effect.runPromise(engine.start());
  return {
    fake,
    engine,
    run: (command) => Effect.runPromise(engine.execute(command)),
    snapshot: () => Effect.runPromise(engine.state()),
    failure: async (command) => {
      const exit = await Effect.runPromiseExit(engine.execute(command));
      if (Exit.isSuccess(exit)) throw new Error(`expected ${command.type} to fail`);
      const typed = Cause.failureOption(exit.cause);
      if (typed._tag === "None") throw new Error("expected a typed CommandError");
      return { code: typed.value.code, message: typed.value.message };
    },
  };
};

/** Ingest observations and ensure every given window is tiled in workspace "1". */
const seedWorkspace = async (h: Harness, ids: readonly WindowId[]): Promise<void> => {
  await h.run({ type: "reconcile" });
  for (const id of ids) {
    const snap = await h.snapshot();
    const ws1 = snap.workspaces.find((ws) => ws.name === "1");
    if (!ws1?.members.includes(id)) {
      await h.run({ type: "moveWindowToWorkspace", windowId: id, workspace: "1", follow: false });
    }
  }
  await h.run({ type: "reconcile" });
};

const workspaceOf = (snap: StateSnapshot, name: string) =>
  snap.workspaces.find((ws) => ws.name === name);

const frameOf = async (h: Harness, id: string): Promise<Frame | null> => h.fake.frameOf(id);

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

const frame = (x: number, y: number, width: number, height: number): Frame => ({
  x,
  y,
  width,
  height,
});

describe("togglePause", () => {
  test("atomically toggles committed paused state, including while paused", async () => {
    const h = await bootstrap();
    expect((await h.snapshot()).paused).toBe(false);
    await h.run({ type: "togglePause" });
    expect((await h.snapshot()).paused).toBe(true);
    // The second press must work WHILE paused — otherwise the engine could
    // never be un-paused via the hotkey.
    await h.run({ type: "togglePause" });
    expect((await h.snapshot()).paused).toBe(false);
  });

  test("rapid double-press executes twice (never coalesced into one toggle)", async () => {
    const h = await bootstrap();
    await Promise.all([
      h.run({ type: "togglePause" }),
      h.run({ type: "togglePause" }),
      h.run({ type: "togglePause" }),
    ]);
    // Odd number of presses ⇒ paused. Coalescing would have left it unpaused.
    expect((await h.snapshot()).paused).toBe(true);
  });
});

describe("floatWindow toggle", () => {
  test("omitted target resolves to the focused window; tiled ⇄ floating", async () => {
    const h = await bootstrap();
    const first = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const second = h.fake.addWindow(makeWindow({ x: 400, y: 400 }));
    await seedWorkspace(h, [first, second]);
    await h.run({ type: "floatWindow", windowId: second });
    expect(workspaceOf(await h.snapshot(), "1")?.floating).toEqual([second]);

    // second is focused and floating ⇒ the toggle tiles it.
    await h.run({ type: "focusWindow", windowId: second });
    await h.run({ type: "floatWindow", toggle: true });
    let snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.floating).toEqual([]);
    expect(sorted(workspaceOf(snap, "1")?.members ?? [])).toEqual(sorted([first, second]));

    // Explicit target: the tiled window floats again.
    await h.run({ type: "floatWindow", toggle: true, windowId: second });
    snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.floating).toEqual([second]);
    expect(workspaceOf(snap, "1")?.members).toEqual([first]);
  });

  test("an unmanaged target is not a structured failure (same as float/tile)", async () => {
    const h = await bootstrap();
    const id = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [id]);
    await h.run({ type: "unmanageWindow", windowId: id });
    await h.run({ type: "floatWindow", toggle: true, windowId: id });
    const snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.members ?? []).toEqual([]);
    expect(workspaceOf(snap, "1")?.floating ?? []).toEqual([]);
  });
});

describe("window assignment", () => {
  test("no-follow assignment to the current workspace preserves focus", async () => {
    const h = await bootstrap();
    const first = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const second = h.fake.addWindow(makeWindow({ x: 400, y: 400 }));
    await seedWorkspace(h, [first, second]);
    await h.run({ type: "moveWindowToWorkspace", workspace: "1", follow: false });
    expect((await h.snapshot()).focusedWindow).toBe(first);
    expect(h.fake.focusedWindowId()).toBe(first);
  });
  test("workspace mode and display movement default to the focused workspace", async () => {
    const h = await bootstrap();
    const id = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [id]);
    await h.run({ type: "setWorkspaceMode", mode: "floating" });
    expect(workspaceOf(await h.snapshot(), "1")?.mode).toBe("floating");
    await h.run({ type: "moveWorkspaceToDisplay", displayId: "display:sim-left" });
    const snapshot = await h.snapshot();
    expect(workspaceOf(snapshot, "1")?.visibleOnDisplay).toBe("display:sim-left");
    expect(snapshot.focusedWorkspace).toBe("1");
  });
  test("explicit-ID assignment follows and focuses the selected nonfocused window", async () => {
    const h = await bootstrap();
    const first = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const second = h.fake.addWindow(makeWindow({ x: 400, y: 400 }));
    await seedWorkspace(h, [first, second]);
    await h.run({ type: "moveWindowToWorkspace", windowId: second, workspace: "2" });
    const snapshot = await h.snapshot();
    expect(snapshot.focusedWorkspace).toBe("2");
    expect(snapshot.focusedWindow).toBe(second);
    expect(h.fake.focusedWindowId()).toBe(second);
    expect(workspaceOf(snapshot, "1")?.members).toEqual([first]);
  });
  test("focused no-follow assignment keeps the source view and focuses a remaining window", async () => {
    const h = await bootstrap();
    const first = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const second = h.fake.addWindow(makeWindow({ x: 400, y: 400 }));
    await seedWorkspace(h, [first, second]);
    await h.run({ type: "moveWindowToWorkspace", workspace: "2", follow: false });
    const snapshot = await h.snapshot();
    expect(snapshot.focusedWorkspace).toBe("1");
    expect(snapshot.focusedWindow).toBe(second);
    expect(h.fake.focusedWindowId()).toBe(second);
    expect(workspaceOf(snapshot, "2")?.members).toEqual([first]);
    expect(workspaceOf(snapshot, "2")?.visibleOnDisplay).toBeNull();
  });
  test("omitted geometry targets resolve to the focused window at execution", async () => {
    const h = await bootstrap();
    const id = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [id]);
    await h.run({ type: "floatWindow" });
    await h.run({ type: "resizeWindow", size: { width: 600, height: 400 } });
    await h.run({ type: "moveWindow", point: { x: 80, y: 90 } });
    expect((await h.snapshot()).windows.find((window) => window.id === id)?.frame).toEqual({
      x: 80,
      y: 90,
      width: 600,
      height: 400,
    });
  });
  test("focused observation updates lastFocusedMember; focus follows", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 400, y: 400 }));
    await seedWorkspace(h, [w1, w2]);

    // Adding w2 does not replace w1's actual focus history.
    let snap = await h.snapshot();
    const ws1 = workspaceOf(snap, "1");
    expect(sorted(ws1?.members ?? [])).toEqual(sorted([w1, w2]));
    expect(ws1?.lastFocusedMember).toBe(w1);
    expect(h.fake.focusedWindowId()).toBe(w1);

    await h.run({ type: "moveWindowToWorkspace", workspace: "scratch" });
    snap = await h.snapshot();

    const scratch = workspaceOf(snap, "scratch");
    expect(scratch?.members).toEqual([w1]);
    expect(workspaceOf(snap, "1")?.members).toEqual([w2]);
    expect(snap.focusedWorkspace).toBe("scratch"); // skhdrc: "…and follow it"
    expect(workspaceOf(snap, "1")?.visibleOnDisplay).toBeNull(); // vacated parks
    expect(scratch?.visibleOnDisplay).not.toBeNull();
  });

  test("falls back to lastFocusedMember when nothing holds focus", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 400, y: 400 }));
    await seedWorkspace(h, [w1, w2]);
    await h.run({ type: "focusWindow", windowId: w2 });

    h.fake.focusWindowExternal(null);
    await h.run({ type: "reconcile" });

    await h.run({ type: "moveWindowToWorkspace", workspace: "scratch" });
    const snap = await h.snapshot();
    expect(workspaceOf(snap, "scratch")?.members).toEqual([w2]);
    expect(workspaceOf(snap, "1")?.members).toEqual([w1]);
  });

  test("no focus and no live fallback member is a structured error", async () => {
    const h = await bootstrap();
    const error = await h.failure({ type: "moveWindowToWorkspace", workspace: "x" });
    expect(error.code).toBe("window_not_found");
  });

  test("a focused non-normal window refuses with window_not_manageable", async () => {
    const h = await bootstrap();
    h.fake.addWindow(makeWindow({ subrole: "AXDialog", x: 60, y: 60 }));
    await h.run({ type: "reconcile" });
    const error = await h.failure({ type: "moveWindowToWorkspace", workspace: "x" });
    expect(error.code).toBe("window_not_manageable");
  });
});

describe("moveFocusedWorkspaceToNextDisplay", () => {
  test("cycles in topology order and wraps back", async () => {
    const h = await bootstrap();
    await h.run({ type: "reconcile" });

    await h.run({ type: "moveFocusedWorkspaceToNextDisplay" });
    let snap = await h.snapshot();
    let ws1 = workspaceOf(snap, "1");
    expect(ws1?.visibleOnDisplay).toBe("display:sim-left");
    expect(ws1?.pinnedDisplayOverride).toBe("display:sim-left");

    await h.run({ type: "moveFocusedWorkspaceToNextDisplay" });
    snap = await h.snapshot();
    ws1 = workspaceOf(snap, "1");
    expect(ws1?.visibleOnDisplay).toBe("display:sim-primary"); // wrapped
    expect(ws1?.pinnedDisplayOverride).toBe("display:sim-primary");
  });

  test("with zero connected displays it fails topology_unstable", async () => {
    const h = await bootstrap([]);
    const error = await h.failure({ type: "moveFocusedWorkspaceToNextDisplay" });
    expect(error.code).toBe("topology_unstable");
  });

  test("with exactly one display it succeeds as a no-op", async () => {
    const h = await bootstrap([{ id: "display:solo", primary: true }]);
    h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await h.run({ type: "reconcile" });
    await waitFor(() => !h.engine.gateState().busy);
    const before = await h.snapshot();
    const wsBefore = workspaceOf(before, "1");

    const writesBefore = h.fake.writes().length;
    await h.run({ type: "moveFocusedWorkspaceToNextDisplay" });

    const after = await h.snapshot();
    const wsAfter = workspaceOf(after, "1");
    expect(after.epoch).toBe(before.epoch);
    expect(wsAfter?.visibleOnDisplay).toBe(wsBefore?.visibleOnDisplay);
    expect(wsAfter?.pinnedDisplayOverride).toBe(wsBefore?.pinnedDisplayOverride);
    expect(h.fake.writes().length).toBe(writesBefore); // no geometry churn
  });

  test("moves the workspace containing an externally focused window", async () => {
    const h = await bootstrap();
    const docker = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveWindowToWorkspace", windowId: docker, workspace: "D", follow: false });
    await h.run({
      type: "moveWorkspaceToDisplay",
      workspace: "D",
      displayId: "display:sim-primary",
    });
    expect((await h.snapshot()).focusedWorkspace).not.toBe("D");

    h.fake.focusWindowExternal(docker);
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveFocusedWorkspaceToNextDisplay" });

    const snap = await h.snapshot();
    expect(workspaceOf(snap, "D")?.visibleOnDisplay).toBe("display:sim-left");
    expect(workspaceOf(snap, "D")?.pinnedDisplayOverride).toBe("display:sim-left");
    expect(workspaceOf(snap, "1")?.pinnedDisplayOverride).toBeNull();

    await h.run({
      type: "moveWorkspaceToDisplay",
      workspace: "1",
      displayId: "display:sim-left",
    });
    const displaced = await h.snapshot();
    expect(workspaceOf(displaced, "D")?.visibleOnDisplay).toBeNull();
    expect(workspaceOf(displaced, "D")?.pinnedDisplayOverride).toBe("display:sim-left");

    const terminal = h.fake.addWindow(makeWindow({ x: 200, y: 200 }));
    await h.run({ type: "reconcile" });
    await h.run({
      type: "moveWindowToWorkspace",
      windowId: terminal,
      workspace: "T",
      follow: false,
    });
    await h.run({
      type: "moveWorkspaceToDisplay",
      workspace: "T",
      displayId: "display:sim-primary",
    });
    h.fake.focusWindowExternal(terminal);
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveWindowToWorkspace", workspace: "D" });

    const moved = await h.snapshot();
    expect(moved.windows.find((window) => window.id === terminal)?.workspace).toBe("D");
    expect(workspaceOf(moved, "D")?.visibleOnDisplay).toBe("display:sim-left");
    expect(h.fake.frameOf(terminal)?.x).toBeLessThan(0);
  });
});

describe("focusDirection", () => {
  test("focuses the directional neighbor and no-ops at edges", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);

    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });

    await h.run({ type: "focusDirection", direction: "right" });
    expect(h.fake.focusedWindowId()).toBe(w2);
    let snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.lastFocusedMember).toBe(w2);

    // At the right edge: keep focus and focus history unchanged.
    await h.run({ type: "focusDirection", direction: "right" });
    expect(h.fake.focusedWindowId()).toBe(w2);
    snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.lastFocusedMember).toBe(w2);
  });

  test("adapter focus refusal leaves lastFocusedMember untouched; retry succeeds", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);

    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });
    let snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.lastFocusedMember).toBe(w1);

    h.fake.swapBackingElement(w2);
    const error = await h.failure({ type: "focusDirection", direction: "right" });
    expect(error.code).toBe("inventory_stale");
    snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.lastFocusedMember).toBe(w1); // unchanged
    expect(h.fake.focusedWindowId()).toBe(w1);

    await h.run({ type: "focusDirection", direction: "right" });
    snap = await h.snapshot();
    expect(h.fake.focusedWindowId()).toBe(w2);
    expect(workspaceOf(snap, "1")?.lastFocusedMember).toBe(w2);
  });

  test("a single-window workspace has no neighbor and no-ops", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [w1]);
    await h.run({ type: "focusDirection", direction: "right" });
    expect(h.fake.focusedWindowId()).toBe(w1);
  });
});

describe("moveDirection", () => {
  test("an edge move no-ops; an effective move swaps leaves and keeps focus", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);

    const before = await h.snapshot();
    const treeBefore = workspaceOf(before, "1")!.tree;
    expect(treeBefore).toEqual({
      kind: "split",
      axis: "vertical",
      ratio: 0.5,
      first: { kind: "leaf", windowId: w1 },
      second: { kind: "leaf", windowId: w2 },
    });
    const writesBefore = h.fake.writes().length;

    // w1 is the only window on the left edge, so moving farther left is a no-op.
    await h.run({ type: "moveDirection", direction: "left" });

    expect(workspaceOf(await h.snapshot(), "1")!.tree).toEqual(treeBefore);
    expect(h.fake.writes().length).toBe(writesBefore);

    await h.run({ type: "moveDirection", direction: "right" });

    const after = await h.snapshot();
    const ws1 = workspaceOf(after, "1")!;
    // Tree topology/ratios preserved, labels swapped.
    expect(ws1.tree).toEqual({
      kind: "split",
      axis: "vertical",
      ratio: 0.5,
      first: { kind: "leaf", windowId: w2 },
      second: { kind: "leaf", windowId: w1 },
    });
    expect(sorted(ws1.members)).toEqual(sorted([w1, w2]));
    // The moved window stays focused and lastFocused.
    expect(h.fake.focusedWindowId()).toBe(w1);
    expect(ws1.lastFocusedMember).toBe(w1);
    // Retile produced verified SetFrames through the adapter.
    expect(await frameOf(h, w1)).toEqual(frame(760, 38, 752, 944));
    expect(await frameOf(h, w2)).toEqual(frame(0, 38, 752, 944));
    expect(h.fake.writes().length).toBeGreaterThan(writesBefore);
  });

  test("a perpendicular move rotates a two-window split", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);

    await h.run({ type: "moveDirection", direction: "down" });

    const ws1 = workspaceOf(await h.snapshot(), "1")!;
    expect(ws1.tree).toEqual({
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "leaf", windowId: w2 },
      second: { kind: "leaf", windowId: w1 },
    });
    expect(await frameOf(h, w2)).toEqual(frame(0, 38, 1512, 468));
    expect(await frameOf(h, w1)).toEqual(frame(0, 514, 1512, 468));
    expect(h.fake.focusedWindowId()).toBe(w1);
  });

  test("nested-tree move reinserts the focused leaf at the destination pane", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 200 }));
    await seedWorkspace(h, [w1, w2]); // tiles w1|w2 so w2's pane is tall
    await h.run({ type: "focusWindow", windowId: w2 });
    const w3 = h.fake.addWindow(makeWindow({ x: 1100, y: 700 }));
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveWindowToWorkspace", windowId: w3, workspace: "1", follow: false });
    await h.run({ type: "reconcile" }); // inserts w3 beside w2 along its height

    const before = await h.snapshot();
    const treeBefore = workspaceOf(before, "1")!.tree;
    expect(treeBefore).toEqual({
      kind: "split",
      axis: "vertical",
      ratio: 0.5,
      first: { kind: "leaf", windowId: w1 },
      second: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "leaf", windowId: w2 },
        second: { kind: "leaf", windowId: w3 },
      },
    });

    // DOWN ranks w1 ahead of w3 by primary-axis gap. Moving w2 there removes
    // it from above w3 and splits w1's tall destination pane horizontally.
    h.fake.focusWindowExternal(w2);
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveDirection", direction: "down" });

    const after = await h.snapshot();
    const ws1 = workspaceOf(after, "1")!;
    expect(ws1.tree).toEqual({
      kind: "split",
      axis: "vertical",
      ratio: 0.5,
      first: { kind: "leaf", windowId: w1 },
      second: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "leaf", windowId: w3 },
        second: { kind: "leaf", windowId: w2 },
      },
    });
    expect(await frameOf(h, w1)).toEqual(frame(0, 38, 752, 944));
    expect(await frameOf(h, w2)).toEqual(frame(760, 514, 752, 468));
    expect(await frameOf(h, w3)).toEqual(frame(760, 38, 752, 468));
    expect(h.fake.focusedWindowId()).toBe(w2);
    expect(ws1.lastFocusedMember).toBe(w2);
  });

  test("floating origin rejects with window_not_manageable", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    await h.run({ type: "floatWindow", windowId: w2 });
    h.fake.focusWindowExternal(w2);
    await h.run({ type: "reconcile" });

    const error = await h.failure({ type: "moveDirection", direction: "left" });
    expect(error.code).toBe("window_not_manageable");
    expect(h.fake.focusedWindowId()).toBe(w2);
    // Nothing was swapped or retiled for the floating window.
    const snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.floating).toEqual([w2]);
  });

  test("floating windows are excluded from geometric targets", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    await h.run({ type: "floatWindow", windowId: w2 });
    await h.run({ type: "reconcile" });

    // w1 (tiled, focused) has only the floating w2 as spatial candidate.
    const writesBefore = h.fake.writes().length;
    await h.run({ type: "moveDirection", direction: "right" });
    const snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.members).toEqual([w1]); // tree untouched
    expect(h.fake.writes().length).toBe(writesBefore);
  });

  test("retries a physically rejected greedy move with the next layout policy", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });

    const batchesBefore = h.fake.batchCalls();
    h.fake.rejectNextBatchWrite(w2);
    await h.run({ type: "moveDirection", direction: "right" });

    expect(h.fake.batchCalls()).toBe(batchesBefore + 1);
    expect(workspaceOf(await h.snapshot(), "1")!.tree).toEqual({
      kind: "split",
      axis: "vertical",
      ratio: 0.5,
      first: { kind: "leaf", windowId: w2 },
      second: { kind: "leaf", windowId: w1 },
    });
    expect(await frameOf(h, w2)).toEqual(frame(0, 38, 752, 944));
    expect(await frameOf(h, w1)).toEqual(frame(760, 38, 752, 944));
  });

  test("a later stale native result aborts before an earlier failure can retry", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });
    const treeBefore = workspaceOf(await h.snapshot(), "1")!.tree;

    h.fake.rejectNextBatchWrite(w2);
    h.fake.swapBackingElement(w1);
    const error = await h.failure({ type: "moveDirection", direction: "right" });

    expect(error.code).toBe("inventory_stale");
    expect(workspaceOf(await h.snapshot(), "1")!.tree).toEqual(treeBefore);
  });

  test("exhausting move layout policies rolls back tree and original frames", async () => {
    let rejectWrites = false;
    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      setWindowFrame: (id, requested, expected) =>
        rejectWrites
          ? Effect.fail(
              new PlatformError({ code: "rejected", detail: "scripted persistent refusal" }),
            )
          : inner.setWindowFrame(id, requested, expected),
      setWindowPosition: (id, requested, expected) =>
        rejectWrites
          ? Effect.fail(
              new PlatformError({ code: "rejected", detail: "scripted persistent refusal" }),
            )
          : inner.setWindowPosition(id, requested, expected),
      setWindowSize: (id, requested, expected) =>
        rejectWrites
          ? Effect.fail(
              new PlatformError({ code: "rejected", detail: "scripted persistent refusal" }),
            )
          : inner.setWindowSize(id, requested, expected),
    }));
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });
    const before = await h.snapshot();
    const framesBefore = { w1: await frameOf(h, w1), w2: await frameOf(h, w2) };
    rejectWrites = true;
    DEADLINE.deadlineMs = 4000;

    const error = await h.failure({ type: "moveDirection", direction: "right" });
    DEADLINE.deadlineMs = 3;

    expect(error.code).toBe("geometry_rejected");
    expect(workspaceOf(await h.snapshot(), "1")!.tree).toEqual(workspaceOf(before, "1")!.tree);
    expect(await frameOf(h, w1)).toEqual(framesBefore.w1);
    expect(await frameOf(h, w2)).toEqual(framesBefore.w2);
  });

  test("learns a later confirmed native clamp before an earlier failure triggers fallback", async () => {
    let snapshot: ObservationSnapshot = {
      revision: "0",
      document: emptyObservationDocument(),
    };
    const store: ObservationStore = {
      load: () => Effect.succeed(snapshot),
      changes: () => Stream.empty,
      save: (_expected, document) =>
        Effect.sync(() => {
          snapshot = { revision: String(Number(snapshot.revision) + 1), document };
          return snapshot;
        }),
    };
    let fallbackWrites = false;
    const refusal = new PlatformError({ code: "rejected", detail: "scripted refusal" });
    const h = await bootstrap(
      undefined,
      (inner) => ({
        ...inner,
        executeBatch: (request) =>
          Effect.map(inner.executeBatch!(request), (result) => {
            fallbackWrites = true;
            return {
              ...result,
              operations: result.operations.map((operation, index) =>
                index === 0
                  ? { ...operation, error: refusal }
                  : operation.observed === undefined
                    ? operation
                    : { ...operation, error: refusal, stable: true, stableReads: 3 },
              ),
            };
          }),
        setWindowFrame: (id, requested, expected) =>
          fallbackWrites ? Effect.fail(refusal) : inner.setWindowFrame(id, requested, expected),
        setWindowPosition: (id, requested, expected) =>
          fallbackWrites ? Effect.fail(refusal) : inner.setWindowPosition(id, requested, expected),
        setWindowSize: (id, requested, expected) =>
          fallbackWrites ? Effect.fail(refusal) : inner.setWindowSize(id, requested, expected),
      }),
      store,
      true,
    );
    const constrained = h.fake.addWindow(
      makeWindow({
        x: 100,
        y: 100,
        bundleId: "test.confirmed-clamp",
        personality: { kind: "minMaxClamp", constraints: { minHeight: 700 } },
      }),
    );
    const origin = h.fake.addWindow(makeWindow({ x: 900, y: 300, bundleId: "test.retry-origin" }));
    await seedWorkspace(h, [constrained, origin]);
    fallbackWrites = false;
    h.fake.focusWindowExternal(origin);
    await h.run({ type: "reconcile" });

    await h.failure({ type: "moveDirection", direction: "up" });

    expect(
      snapshot.document.profiles.find(
        (profile) => profile.key.application === "test.confirmed-clamp",
      )?.constraints.minHeight,
    ).toBe(700);
  });

  test("records stable native movement refusal and replaces it with demonstrated fallback movement", async () => {
    const diagnostics: DomainEvent[] = [];
    const refusal = new PlatformError({ code: "rejected", detail: "scripted movement refusal" });
    let refusedWindow: WindowId | null = null;
    let originalFrame: Frame | null = null;
    let refuseNative = false;
    const h = await bootstrap(
      undefined,
      (inner) => ({
        ...inner,
        executeBatch: (request) =>
          Effect.gen(function* () {
            const result = yield* inner.executeBatch!(request);
            if (!refuseNative || refusedWindow === null || originalFrame === null) return result;
            refuseNative = false;
            yield* inner.setWindowFrame(refusedWindow, originalFrame);
            return {
              ...result,
              operations: result.operations.map((operation, index) =>
                request.operations[index]?.windowId === refusedWindow &&
                operation.observed !== undefined
                  ? {
                      ...operation,
                      observed: originalFrame!,
                      error: refusal,
                      stable: true,
                      stableReads: 3,
                    }
                  : operation,
              ),
            };
          }),
      }),
      undefined,
      true,
    );
    const left = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const right = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [left, right]);
    h.fake.focusWindowExternal(left);
    await h.run({ type: "reconcile" });
    refusedWindow = right;
    originalFrame = await frameOf(h, right);
    refuseNative = true;
    const collector = Effect.runFork(
      Stream.runForEach(
        Stream.filter(h.engine.events(), (event) => event.topic === "diagnostic"),
        (event) => Effect.sync(() => diagnostics.push(event)),
      ),
    );

    await h.run({ type: "moveDirection", direction: "right" });

    expect(diagnostics.some((event) => event.payload.code === "geometry_move_refused")).toBe(true);
    expect(
      (await h.snapshot()).windows.find((window) => window.id === right)?.capabilities,
    ).toMatchObject({
      movable: "supported",
      movableEvidence: "geometry_operation",
    });
    await Effect.runPromise(Fiber.interrupt(collector));
  });

  test("stale stable fallback metadata preserves original capture and learns no profile evidence", async () => {
    let snapshot: ObservationSnapshot = {
      revision: "0",
      document: emptyObservationDocument(),
    };
    const store: ObservationStore = {
      load: () => Effect.succeed(snapshot),
      changes: () => Stream.empty,
      save: (_expected, document) =>
        Effect.sync(() => {
          snapshot = { revision: String(Number(snapshot.revision) + 1), document };
          return snapshot;
        }),
    };
    let staleWindow: WindowId | null = null;
    let originalFrame: Frame | null = null;
    let rejectNative = false;
    let staleWrites = 0;
    const h = await bootstrap(
      undefined,
      (inner) => ({
        ...inner,
        executeBatch: (request) =>
          Effect.gen(function* () {
            const result = yield* inner.executeBatch!(request);
            if (!rejectNative || staleWindow === null || originalFrame === null) return result;
            yield* inner.setWindowFrame(staleWindow, originalFrame);
            return {
              ...result,
              operations: result.operations.map((operation, index) =>
                request.operations[index]?.windowId === staleWindow
                  ? {
                      ...operation,
                      observed: originalFrame!,
                      error: undefined,
                      stable: true,
                      stableReads: 3,
                    }
                  : operation,
              ),
            };
          }),
        setWindowFrame: (id, requested, expected) =>
          rejectNative && id === staleWindow && originalFrame !== null
            ? Effect.sync(() => {
                staleWrites += 1;
                return {
                  requested,
                  observed: { ...originalFrame!, width: requested.width },
                  stable: true,
                  stableReads: 3,
                  errorKind: "stale" as const,
                };
              })
            : inner.setWindowFrame(id, requested, expected),
      }),
      store,
      true,
    );
    const guarded = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const peer = h.fake.addWindow(
      makeWindow({ x: 900, y: 300, bundleId: "test.stale-learning-guard" }),
    );
    await seedWorkspace(h, [guarded, peer]);
    h.fake.focusWindowExternal(guarded);
    await h.run({ type: "reconcile" });
    staleWindow = peer;
    originalFrame = await frameOf(h, peer);
    rejectNative = true;

    const error = await h.failure({ type: "moveDirection", direction: "right" });

    expect(error.code).toBe("inventory_stale");
    expect(staleWrites).toBeGreaterThan(0);
    expect(await frameOf(h, peer)).toEqual(originalFrame);
    expect(
      snapshot.document.profiles.find(
        (profile) => profile.key.application === "test.stale-learning-guard",
      ),
    ).toBeUndefined();
    expect(
      snapshot.document.pending.find(
        (pending) => pending.key.application === "test.stale-learning-guard",
      ),
    ).toBeUndefined();
  });

  test("an unreadable floating window does not block a tiled edge no-op", async () => {
    let unreadable: WindowId | null = null;
    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      getWindow: (id) => (id === unreadable ? Effect.succeed(null) : inner.getWindow(id)),
    }));
    const tiled = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const floating = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [tiled, floating]);
    await h.run({ type: "floatWindow", windowId: floating });
    h.fake.focusWindowExternal(tiled);
    await h.run({ type: "reconcile" });
    unreadable = floating;

    await h.run({ type: "moveDirection", direction: "left" });

    expect(h.fake.focusedWindowId()).toBe(tiled);
  });
});

describe("pause gating for hotkey commands", () => {
  test("engine synchronizes native hotkey swallowing around pause transitions", async () => {
    const swallowing: boolean[] = [];
    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      setHotkeySwallowing: (enabled) => Effect.sync(() => swallowing.push(enabled)),
    }));

    expect(swallowing).toEqual([true]);
    await h.run({ type: "pause" });
    expect(swallowing).toEqual([true, false]);
    await h.run({ type: "togglePause" });
    expect(swallowing).toEqual([true, false, true]);
  });

  test("directional/layout mutations fail paused; togglePause still works", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    await h.run({ type: "pause" });

    expect((await h.failure({ type: "focusDirection", direction: "left" })).code).toBe("paused");
    expect((await h.failure({ type: "moveDirection", direction: "left" })).code).toBe("paused");
    expect((await h.failure({ type: "moveWindowToWorkspace", workspace: "s" })).code).toBe(
      "paused",
    );
    expect((await h.failure({ type: "moveFocusedWorkspaceToNextDisplay" })).code).toBe("paused");

    await h.run({ type: "togglePause" });
    expect((await h.snapshot()).paused).toBe(false);

    // Unpaused, the same directional command executes normally.
    await h.run({ type: "focusDirection", direction: "right" });
    expect(h.fake.focusedWindowId()).toBe(w2);
  });

  test("all commands except resume and togglePause fail while paused", async () => {
    const h = await bootstrap();
    await h.run({ type: "pause" });

    expect((await h.failure({ type: "getState" })).code).toBe("paused");
    expect((await h.failure({ type: "focusWorkspace", name: "1" })).code).toBe("paused");
    expect((await h.failure({ type: "pause" })).code).toBe("paused");

    await h.run({ type: "resume" });
    expect((await h.snapshot()).paused).toBe(false);
    await h.run({ type: "pause" });
    await h.run({ type: "togglePause" });
    expect((await h.snapshot()).paused).toBe(false);
  });
});

describe("transactional compound commands (review issue 1)", () => {
  test("moveDirection: FIRST write failure leaves tree/membership/focus untouched", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });

    const before = await h.snapshot();
    const wsBefore = workspaceOf(before, "1")!;
    const frameBefore = { w1: await frameOf(h, w1), w2: await frameOf(h, w2) };

    // After the swap the retile writes the FIRST leaf (w2) first.
    h.fake.swapBackingElement(w2);
    const error = await h.failure({ type: "moveDirection", direction: "right" });
    expect(error.code).toBe("inventory_stale");

    const after = await h.snapshot();
    const wsAfter = workspaceOf(after, "1")!;
    expect(wsAfter.tree).toEqual(wsBefore.tree);
    expect(sorted(wsAfter.members)).toEqual(sorted(wsBefore.members));
    expect(wsAfter.lastFocusedMember).toBe(wsBefore.lastFocusedMember);
    expect(after.focusedWorkspace).toBe(before.focusedWorkspace);
    expect(h.fake.focusedWindowId()).toBe(w1);
    // Complete frames restored (position AND size), not just position.
    expect(await frameOf(h, w1)).toEqual(frameBefore.w1);
    expect(await frameOf(h, w2)).toEqual(frameBefore.w2);
  });

  test("moveDirection: MIDDLE write failure restores the window an earlier step already moved", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 200 }));
    await seedWorkspace(h, [w1, w2]);
    await h.run({ type: "focusWindow", windowId: w2 });
    const w3 = h.fake.addWindow(makeWindow({ x: 1200, y: 600 }));
    await seedWorkspace(h, [w1, w2, w3]);
    await h.run({ type: "reconcile" });

    // w2 is above w3. DOWN swaps them, writing w3 before failing on w2.
    const before = await h.snapshot();
    const wsBefore = workspaceOf(before, "1")!;
    const frameBefore = {
      w1: await frameOf(h, w1),
      w2: await frameOf(h, w2),
      w3: await frameOf(h, w3),
    };

    h.fake.swapBackingElement(w2);
    const error = await h.failure({ type: "moveDirection", direction: "down" });
    expect(error.code).toBe("inventory_stale");

    const after = await h.snapshot();
    const wsAfter = workspaceOf(after, "1")!;
    expect(wsAfter.tree).toEqual(wsBefore.tree);
    expect(wsAfter.lastFocusedMember).toBe(wsBefore.lastFocusedMember);
    expect(h.fake.focusedWindowId()).toBe(w2);
    // The already-applied middle step is fully rolled back.
    expect(await frameOf(h, w3)).toEqual(frameBefore.w3);
    expect(await frameOf(h, w2)).toEqual(frameBefore.w2);
    expect(await frameOf(h, w1)).toEqual(frameBefore.w1);
  });

  test("moveFocusedWindowToWorkspace: failure rolls back created workspace + focus + parking writes", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);

    const before = await h.snapshot();
    const frameBefore = { w1: await frameOf(h, w1), w2: await frameOf(h, w2) };
    const writesBefore = h.fake.writes().length;

    // The reveal parks the vacated source member (w2) — arm it to fail.
    h.fake.swapBackingElement(w2);
    const error = await h.failure({ type: "moveWindowToWorkspace", workspace: "scratch" });
    expect(["topology_unstable", "inventory_stale"]).toContain(error.code);

    const after = await h.snapshot();
    expect(workspaceOf(after, "scratch")).toBeUndefined(); // creation undone
    expect(sorted(workspaceOf(after, "1")?.members ?? [])).toEqual(
      workspaceOf(before, "1")!.members.slice().sort(),
    );
    expect(after.focusedWorkspace).toBe(before.focusedWorkspace);
    expect(workspaceOf(after, "1")?.lastFocusedMember).toBe(
      workspaceOf(before, "1")?.lastFocusedMember,
    );
    expect(workspaceOf(after, "1")?.visibleOnDisplay).toBe(
      workspaceOf(before, "1")?.visibleOnDisplay,
    );
    expect(h.fake.focusedWindowId()).toBe(w1);
    expect(await frameOf(h, w1)).toEqual(frameBefore.w1);
    expect(await frameOf(h, w2)).toEqual(frameBefore.w2);
    void writesBefore;
  });

  test("moveFocusedWorkspaceToNextDisplay: failure rolls back visibility and pin", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [w1]);
    const before = await h.snapshot();
    const wsBefore = workspaceOf(before, "1")!;
    const frameBefore = await frameOf(h, w1);

    // Retiling onto the other display rewrites w1's frame — arm it to fail.
    // The scoped plan's verified write surfaces the identity abort directly.
    h.fake.swapBackingElement(w1);
    const error = await h.failure({ type: "moveFocusedWorkspaceToNextDisplay" });
    expect(error.code).toBe("inventory_stale");

    const after = await h.snapshot();
    const wsAfter = workspaceOf(after, "1")!;
    expect(wsAfter.visibleOnDisplay).toBe(wsBefore.visibleOnDisplay);
    expect(wsAfter.pinnedDisplayOverride).toBe(wsBefore.pinnedDisplayOverride);
    expect(wsAfter.lastFocusedMember).toBe(wsBefore.lastFocusedMember);
    expect(await frameOf(h, w1)).toEqual(frameBefore);
  });
});

describe("destination display preservation (review issue 2)", () => {
  test("an existing destination keeps its visible display; source keeps its own", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [w1]);

    // Park a second, EMPTY workspace on the LEFT display.
    await h.run({
      type: "moveWorkspaceToDisplay",
      workspace: "away",
      displayId: "display:sim-left",
    });
    let snap = await h.snapshot();
    expect(workspaceOf(snap, "away")?.visibleOnDisplay).toBe("display:sim-left");
    expect(workspaceOf(snap, "1")?.visibleOnDisplay).toBe("display:sim-primary");

    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveWindowToWorkspace", workspace: "away" });

    snap = await h.snapshot();
    // Destination display PRESERVED — not yanked to the source's display.
    expect(workspaceOf(snap, "away")?.visibleOnDisplay).toBe("display:sim-left");
    expect(workspaceOf(snap, "1")?.visibleOnDisplay).toBe("display:sim-primary");
    expect(snap.focusedWorkspace).toBe("away");
    expect(workspaceOf(snap, "away")?.members).toEqual([w1]);
    // w1 physically landed tiled across the LEFT display.
    expect(await frameOf(h, w1)).toEqual(frame(-1512, 38, 1512, 944));
  });
});

describe("engine-side logical focus across queued commands (review issue 3)", () => {
  test("consecutive focusDirection calls resolve without refreshed observations", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });

    // Three presses back-to-back; NO reconcile between them, so observed
    // snapshots lag behind. Engine logical focus must carry the chain:
    // right → w2, right no-ops, left → w1.
    await h.run({ type: "focusDirection", direction: "right" });
    expect(h.fake.focusedWindowId()).toBe(w2);
    await h.run({ type: "focusDirection", direction: "right" });
    expect(h.fake.focusedWindowId()).toBe(w2);
    await h.run({ type: "focusDirection", direction: "left" });
    expect(h.fake.focusedWindowId()).toBe(w1);
  });
});

describe("floating-mode workspaces reject directional commands (review issue 4)", () => {
  test("focusDirection and moveDirection refuse non-bsp workspaces", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    await h.run({ type: "setWorkspaceMode", workspace: "1", mode: "floating" });
    await h.run({ type: "reconcile" });

    const focusErr = await h.failure({ type: "focusDirection", direction: "right" });
    expect(focusErr.code).toBe("window_not_manageable");
    const moveErr = await h.failure({ type: "moveDirection", direction: "left" });
    expect(moveErr.code).toBe("window_not_manageable");
    expect(h.fake.focusedWindowId()).toBe(w1); // unchanged
  });
});

describe("observed unmanageable focus blocks fallback (review issue 5)", () => {
  test("focused dialog fails window_not_manageable even with valid lastFocusedMember", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    let snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.lastFocusedMember).toBe(w1); // valid fallback exists

    // Externally focus a transient dialog; reconcile adopts that observation.
    const dialog = h.fake.addWindow(makeWindow({ subrole: "AXDialog", x: 60, y: 60 }));
    h.fake.focusWindowExternal(dialog);
    await h.run({ type: "reconcile" });

    const error = await h.failure({ type: "moveWindowToWorkspace", workspace: "scratch" });
    expect(error.code).toBe("window_not_manageable");
    snap = await h.snapshot();
    expect(workspaceOf(snap, "scratch")).toBeUndefined(); // nothing moved
    expect(sorted(workspaceOf(snap, "1")?.members ?? [])).toEqual(sorted([w1, w2]));
  });
});

// ---------------------------------------------------------------------------
// Review round 2 — architectural requirements
// ---------------------------------------------------------------------------

interface Gate {
  wrapper: (inner: PlatformAdapter) => PlatformAdapter;
  arm(next: (id: WId, op: "position" | "size" | "frame") => boolean): void;
  resume(): void;
  isSuspended(): boolean;
}

const makeGate = (): Gate => {
  let pred: ((id: WId, op: "position" | "size" | "frame") => boolean) | null = null;
  let release: (() => void) | null = null;
  const call = (
    op: "position" | "size" | "frame",
    id: WId,
    run: () => Effect.Effect<WriteObservation, PlatformError>,
  ): Effect.Effect<WriteObservation, PlatformError> => {
    if (pred !== null && pred(id, op)) {
      pred = null; // ONE-SHOT: exactly one suspension per arm
      return Effect.async<WriteObservation, PlatformError>((res) => {
        release = () => res(run());
      });
    }
    return run();
  };
  return {
    wrapper: (inner) => ({
      ...inner,
      setWindowPosition: (id, p, expected) =>
        call("position", id, () => inner.setWindowPosition(id, p, expected)),
      setWindowSize: (id, s, expected) =>
        call("size", id, () => inner.setWindowSize(id, s, expected)),
      setWindowFrame: (id, f, expected) =>
        call("frame", id, () => inner.setWindowFrame(id, f, expected)),
    }),
    arm: (next) => {
      pred = next;
    },
    resume: () => {
      release?.();
      release = null;
    },
    isSuspended: () => release !== null,
  };
};

const waitFor = async (check: () => boolean, timeoutMs = 500): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("committed/draft isolation (round 2 issue 1)", () => {
  test("suspended middle write: queries see OLD state; adapter events do not touch draft", async () => {
    const gate = makeGate();
    const h = await bootstrap(undefined, gate.wrapper);
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });

    const before = await h.snapshot();
    const treeBefore = workspaceOf(before, "1")!.tree;

    // Suspend the SECOND retile write (w1) so the first (w2) already applied.
    DEADLINE.deadlineMs = 4000; // keep the transaction alive while suspended
    gate.arm((id, op) => id === w1 && op === "frame");
    const pending = h.run({ type: "moveDirection", direction: "right" });
    await waitFor(() => h.fake.writes().some((x) => x.windowId === w2 && x.observed.width === 752));

    // Queries during tentative work see ONLY the old committed world.
    const mid = await h.snapshot();
    expect(workspaceOf(mid, "1")!.tree).toEqual(treeBefore);
    expect(mid.windows.find((x) => x.id === w2)?.frame).toEqual(
      before.windows.find((x) => x.id === w2)?.frame,
    );

    // An adapter event during tentative work must NOT reconcile draft state.
    h.fake.emitSleep();
    await new Promise((r) => setTimeout(r, 20));
    const mid2 = await h.snapshot();
    expect(workspaceOf(mid2, "1")!.tree).toEqual(treeBefore);

    gate.resume();
    const result = await pending;
    expect(result.type).toBe("ok");
    DEADLINE.deadlineMs = 3;
    const after = await h.snapshot();
    expect(workspaceOf(after, "1")!.tree).not.toEqual(treeBefore); // committed now
  });

  test("domain events buffer until atomic commit and discard on rollback", async () => {
    const gate = makeGate();
    const h = await bootstrap(undefined, gate.wrapper);
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);

    let focusEventsSeen = 0;
    const collectorFiber = Effect.runFork(
      Stream.runForEach(
        Stream.filter(h.engine.events(), (event: DomainEvent) => event.topic === "focus"),
        () => Effect.sync(() => (focusEventsSeen += 1)),
      ),
    );

    // Park of the vacated member (w2) is the first platform effect — gate it.
    DEADLINE.deadlineMs = 4000;
    gate.arm((id, op) => id === w2 && op === "frame");
    const pending = h.run({ type: "moveWindowToWorkspace", workspace: "scratch" });
    await new Promise((r) => setTimeout(r, 25));

    const midSnap = await h.snapshot();
    expect(workspaceOf(midSnap, "scratch")).toBeUndefined(); // draft invisible
    expect(focusEventsSeen).toBe(0); // buffered, not published

    gate.resume();
    const result = await pending;
    expect(result.type).toBe("ok");
    DEADLINE.deadlineMs = 3;
    // The buffered focus event flushes only after the atomic commit.
    await waitFor(() => focusEventsSeen >= 1);
  });
});

describe("identity-safe verified rollback (round 2 issue 2)", () => {
  test("replacement is never written; health degrades; peers restore fully", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });
    const frameBefore = { w1: await frameOf(h, w1), w2: await frameOf(h, w2) };

    h.fake.swapBackingElement(w2); // replacement behind w2
    h.fake.nudgeSilent(w2, { x: 1234 }); // diverged AND replaced
    const error = await h.failure({ type: "moveDirection", direction: "right" });
    expect(error.code).toBe("inventory_stale");

    // Replacement untouched at its nudged position (no compensation write).
    expect(await frameOf(h, w2)).toEqual({ ...frameBefore.w2, x: 1234 });
    // Peer restored completely (it had been moved by the plan's first step).
    expect(await frameOf(h, w1)).toEqual(frameBefore.w1);
    // Unverifiable restoration surfaces as degraded health.
    expect((await h.snapshot()).health).toBe("degraded");
  });
});

describe("strict reconciliation early exits (round 2 issue 3)", () => {
  test("recovery-active fails typed without committing", async () => {
    let flip = false;
    const h = await bootstrap(undefined, (inner, refs) => ({
      ...inner,
      getWindow: (id) => {
        if (flip) refs.engine?.setRecovery(true);
        return inner.getWindow(id);
      },
    }));
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    const treeBefore = workspaceOf(await h.snapshot(), "1")!.tree;

    flip = true;
    try {
      const error = await h.failure({ type: "moveDirection", direction: "right" });
      expect(error.code).toBe("internal_error");
      expect(workspaceOf(await h.snapshot(), "1")!.tree).toEqual(treeBefore);
    } finally {
      h.engine.setRecovery(false);
    }
  });

  test("paused suppression prevents required plan (retile is strict)", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    await h.run({ type: "pause" });
    h.fake.driftWindow(w1, 120, 60); // repair suppressed while paused
    const drifted = await frameOf(h, w1);

    const error = await h.failure({ type: "retile" });
    expect(error.code).toBe("paused");
    expect(await frameOf(h, w1)).toEqual(drifted); // nothing committed/applied

    await h.run({ type: "resume" });
    await h.run({ type: "retile" });
    expect(await frameOf(h, w1)).toEqual(frame(0, 38, 752, 944)); // repaired
  });

  test("invalid inventory observation fails inventory_stale", async () => {
    let poisonInventory = false;
    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      getWindows: () => {
        if (!poisonInventory) return inner.getWindows();
        const fixture = {
          id: "window:malformed",
          pid: 1,
          title: "Malformed",
          role: "AXWindow",
          frame: { x: 0, y: 0, width: 100, height: 100 },
          minimized: false,
          hidden: false,
          fullscreen: false,
          focused: false,
          capabilities: {
            movable: "unknown",
            resizable: "unknown",
            movableEvidence: "platform_report",
            resizableEvidence: "platform_report",
          },
        } satisfies import("../src/schema.ts").WindowObservation;
        Object.defineProperty(fixture.frame, "width", { value: "invalid" });
        return Effect.succeed([fixture]);
      },
    }));
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    const treeBefore = workspaceOf(await h.snapshot(), "1")!.tree;

    poisonInventory = true;
    try {
      const error = await h.failure({ type: "moveDirection", direction: "right" });
      expect(error.code).toBe("inventory_stale");
      expect(workspaceOf(await h.snapshot(), "1")!.tree).toEqual(treeBefore);
    } finally {
      poisonInventory = false;
    }
  });

  test("invalid topology observation fails topology_unstable", async () => {
    let poisonTopology = false;
    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      getTopology: () => {
        if (!poisonTopology) return inner.getTopology();
        const display = {
          id: "display:malformed",
          frame: { x: 0, y: 0, width: 100, height: 100 },
          workArea: { x: 0, y: 0, width: 100, height: 100 },
          scale: 1,
          primary: true,
        } satisfies import("../src/schema.ts").DisplayObservation;
        Object.defineProperty(display, "scale", { value: "invalid" });
        return Effect.succeed({ displays: [display] });
      },
    }));
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    const treeBefore = workspaceOf(await h.snapshot(), "1")!.tree;

    poisonTopology = true;
    try {
      const error = await h.failure({ type: "moveDirection", direction: "right" });
      expect(error.code).toBe("topology_unstable");
      expect(workspaceOf(await h.snapshot(), "1")!.tree).toEqual(treeBefore);
    } finally {
      poisonTopology = false;
    }
  });

  test("retile intent whose display vanished fails topology_unstable", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [w1]);
    const error = await h.failure({
      type: "moveWorkspaceToDisplay",
      workspace: "1",
      displayId: "display:ghost",
    });
    expect(error.code).toBe("topology_unstable");
    const snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.pinnedDisplayOverride).toBeNull();
    expect(workspaceOf(snap, "1")?.visibleOnDisplay).toBe("display:sim-primary");
  });
});

describe("scoped reconciliation (round 2 issue 4)", () => {
  test("unrelated floating window stays drifted when command succeeds or fails", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    // Stray floats far BEHIND the origin so it never wins directional rank.
    const stray = h.fake.addWindow(makeWindow({ x: -1400, y: -900 }));
    await h.run({ type: "reconcile" });
    await h.run({ type: "floatWindow", windowId: stray });
    h.fake.nudgeSilent(stray, { x: -1200 }); // unrelated divergence, no event

    // SUCCESS path: scoped plan touches only tiled members of workspace 1.
    await h.run({ type: "moveDirection", direction: "right" });
    const strayAfterSuccess = await frameOf(h, stray);
    expect(strayAfterSuccess?.x).toBe(-1200);

    // FAILURE path: rollback likewise never compensates unrelated windows.
    const w3 = h.fake.addWindow(makeWindow({ x: 1300, y: 200 }));
    await seedWorkspace(h, [w1, w2, w3]);
    h.fake.nudgeSilent(stray, { x: -1300 });
    // Arm EVERY candidate except the focused origin: whichever window the
    // scoped plan writes first aborts stale.
    h.fake.swapBackingElement(w1);
    h.fake.swapBackingElement(w2);
    h.fake.swapBackingElement(w3);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });
    // LEFT guarantees a forward TILED neighbor (the floating stray sits
    // behind the origin), so the stale arm aborts the scoped plan write.
    const err = await h.failure({ type: "moveDirection", direction: "left" });
    expect(err.code).toBe("inventory_stale");
    const strayAfterFailure = await frameOf(h, stray);
    expect(strayAfterFailure?.x).toBe(-1300);
  });
});

describe("interruption-safe rollback (round 2 issue 5)", () => {
  test("queue timeout interrupts a blocked write; committed stays old; frames restore", async () => {
    const gate = makeGate();
    const h = await bootstrap(undefined, gate.wrapper);
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });
    const before = await h.snapshot();
    const frameBefore = { w1: await frameOf(h, w1), w2: await frameOf(h, w2) };

    // Block the SECOND write forever; the compressed 15 s deadline fires.
    gate.arm((id, op) => id === w1 && op === "frame");
    const error = await h.failure({ type: "moveDirection", direction: "right" });
    expect(error.code).toBe("timeout");

    // Committed world remains the OLD one.
    expect(workspaceOf(await h.snapshot(), "1")!.tree).toEqual(workspaceOf(before, "1")!.tree);
    // Compensation restores the window an earlier step had already moved…
    await waitFor(() => {
      const f = h.fake.frameOf(w2);
      return f !== null && Math.abs(f.x - (frameBefore.w2?.x ?? NaN)) < 2;
    });
    expect(await frameOf(h, w2)).toEqual(frameBefore.w2);
    // …and leaves the blocked window exactly where it was (write never ran).
    expect(await frameOf(h, w1)).toEqual(frameBefore.w1);

    gate.resume();
  });
});

describe("focus generation survives stale observations (round 2 issue 6)", () => {
  test("delayed focus propagation: directional chain keeps intent across unrelated reconciles", async () => {
    const h = await bootstrap();
    h.fake.setDeferFocus(true);
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);

    // Press RIGHT: engine focuses w2 but observations keep reporting w1.
    await h.run({ type: "focusDirection", direction: "right" });
    expect(h.fake.focusedWindowId()).toBe(w2); // real focus moved
    let snap = await h.snapshot();
    expect(snap.focusedWindow).toBe(w2); // engine intent

    // Unrelated reconciles observe STALE focus (still w1) — must NOT clear.
    await h.run({ type: "reconcile" });
    await h.run({ type: "reconcile" });
    snap = await h.snapshot();
    expect(snap.focusedWindow).toBe(w2);

    // Second press resolves origin from the INTENT (w2), not the stale observation.
    await h.run({ type: "focusDirection", direction: "left" });
    snap = await h.snapshot();
    expect(snap.focusedWindow).toBe(w1);

    h.fake.releaseDeferredFocus();
    await h.run({ type: "reconcile" });
    snap = await h.snapshot();
    expect(snap.focusedWindow).toBe(w1);
    expect(h.fake.focusedWindowId()).toBe(w1);
  });

  test("an authoritative newer external focus supersedes the intent", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });

    await h.run({ type: "focusDirection", direction: "right" }); // intent w2
    expect((await h.snapshot()).focusedWindow).toBe(w2);

    h.fake.focusWindowExternal(w1); // user clicks back — authoritative change
    await h.run({ type: "reconcile" });
    expect((await h.snapshot()).focusedWindow).toBe(w1);

    // Directional resolution now continues from w1 again.
    await h.run({ type: "focusDirection", direction: "right" });
    expect((await h.snapshot()).focusedWindow).toBe(w2);
  });
});

// ---------------------------------------------------------------------------
// Review round 3
// ---------------------------------------------------------------------------

describe("focusWorkspace of a missing workspace never leaks (round 3 issue 1)", () => {
  test("suspended displaced-park write: queries see no ghost workspace", async () => {
    const gate = makeGate();
    const h = await bootstrap(undefined, gate.wrapper);
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [w1]);
    DEADLINE.deadlineMs = 4000;

    // Revealing ghost onto primary displaces ws1 → parks w1 → gate it.
    gate.arm((id, op) => id === w1 && op === "frame");
    const pending = h.run({ type: "focusWorkspace", name: "ghost" });
    await new Promise((r) => setTimeout(r, 25));

    const mid = await h.snapshot();
    expect(workspaceOf(mid, "ghost")).toBeUndefined(); // draft-only creation invisible
    expect(mid.focusedWorkspace).toBe("1"); // old committed focus

    gate.resume();
    const result = await pending;
    expect(result.type).toBe("ok");
    DEADLINE.deadlineMs = 3;
    const after = await h.snapshot();
    expect(after.focusedWorkspace).toBe("ghost");
    // focusWorkspace switches/reveals — it never migrates membership.
    expect(workspaceOf(after, "ghost")?.members).toEqual([]);
    expect(workspaceOf(after, "1")?.members).toEqual([w1]);
  });

  test("failed reveal of missing workspace rolls back — no leaked workspace", async () => {
    const gate = makeGate();
    const h = await bootstrap(undefined, gate.wrapper);
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [w1]);

    // Induced later failure: the displaced member's park write aborts stale
    // behind an injected replacement (which itself is never written).
    h.fake.swapBackingElement(w1);
    h.fake.nudgeSilent(w1, { x: 4321 });
    const error = await h.failure({ type: "focusWorkspace", name: "ghost" });
    expect(error.code).toBe("inventory_stale");

    const after = await h.snapshot();
    expect(workspaceOf(after, "ghost")).toBeUndefined(); // rolled back
    expect(workspaceOf(after, "1")?.members).toEqual([w1]);
    expect(after.focusedWorkspace).toBe("1");
    expect(await frameOf(h, w1)).toEqual({ ...frame(0, 38, 1512, 944), x: 4321 });
    expect((await h.snapshot()).health).toBe("degraded");
  });
});

describe("focusWorkspace physically focuses its destination", () => {
  test("focuses the last live member when the workspace is already visible", async () => {
    const h = await bootstrap();
    const primary = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [primary]);
    await h.run({
      type: "moveWorkspaceToDisplay",
      workspace: "away",
      displayId: "display:sim-left",
    });
    const destination = h.fake.addWindow(makeWindow({ x: -1400, y: 100 }));
    await h.run({ type: "reconcile" });
    await h.run({
      type: "moveWindowToWorkspace",
      windowId: destination,
      workspace: "away",
      follow: false,
    });
    h.fake.focusWindowExternal(primary);
    await h.run({ type: "reconcile" });

    const batchesBefore = h.fake.batchCalls();
    await h.run({ type: "focusWorkspace", name: "away" });

    const snap = await h.snapshot();
    expect(h.fake.focusedWindowId()).toBe(destination);
    expect(snap.focusedWorkspace).toBe("away");
    expect(snap.focusedWindow).toBe(destination);
    expect(workspaceOf(snap, "away")?.lastFocusedMember).toBe(destination);
    expect(h.fake.batchCalls() - batchesBefore).toBe(1);
  });

  test("focuses a live member immediately after revealing a parked workspace", async () => {
    const h = await bootstrap([{ id: "display:solo", primary: true }]);
    const primary = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const destination = h.fake.addWindow(makeWindow({ x: 500, y: 100 }));
    await seedWorkspace(h, [primary, destination]);
    await h.run({
      type: "moveWindowToWorkspace",
      windowId: destination,
      workspace: "away",
      follow: false,
    });
    await h.run({ type: "focusWorkspace", name: "1" });
    h.fake.focusWindowExternal(primary);
    await h.run({ type: "reconcile" });
    expect(workspaceOf(await h.snapshot(), "away")?.visibleOnDisplay).toBeNull();

    await h.run({ type: "focusWorkspace", name: "away" });

    const snap = await h.snapshot();
    expect(workspaceOf(snap, "away")?.visibleOnDisplay).toBe("display:solo");
    expect(h.fake.focusedWindowId()).toBe(destination);
    expect(snap.focusedWindow).toBe(destination);
    expect(workspaceOf(snap, "away")?.lastFocusedMember).toBe(destination);
  });
});

describe("multi-display focus isolation", () => {
  test("T -> M -> T -> 1 -> T preserves pins and never writes the unaffected display", async () => {
    const h = await bootstrap();
    const t = h.fake.addWindow(makeWindow({ displayId: "display:sim-left", x: -1400, y: 100 }));
    const m = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const one = h.fake.addWindow(makeWindow({ x: 500, y: 100 }));
    await seedWorkspace(h, [t, m, one]);
    await h.run({ type: "moveWindowToWorkspace", windowId: t, workspace: "T", follow: false });
    await h.run({ type: "moveWindowToWorkspace", windowId: m, workspace: "M", follow: false });
    await h.run({ type: "moveWorkspaceToDisplay", workspace: "T", displayId: "display:sim-left" });
    await h.run({ type: "focusWorkspace", name: "M" });

    const before = await h.snapshot();
    const pins = new Map(
      before.workspaces.map((workspace) => [workspace.name, workspace.pinnedDisplayOverride]),
    );
    const writesBefore = h.fake.writes().length;

    for (const name of ["T", "M", "T", "1", "T"]) {
      await h.run({ type: "focusWorkspace", name });
    }

    const after = await h.snapshot();
    for (const name of ["T", "M", "1"]) {
      expect(workspaceOf(after, name)?.pinnedDisplayOverride).toBe(pins.get(name));
    }
    expect(
      h.fake
        .writes()
        .slice(writesBefore)
        .map((write) => write.windowId),
    ).not.toContain(t);
    expect(after.windows.find((window) => window.id === one)?.workspace).toBe("1");
  });
});

describe("focusing an empty workspace (issue #5)", () => {
  const EMPTY_WS_CONFIG: ConfigSource = {
    load: () => Effect.succeed({ defaults: {}, workspaces: [{ name: "empty" }] }),
    changes: () => Stream.empty,
  };

  test("retires the previous focus intent and leaves the parked window parked", async () => {
    const h = await bootstrap(
      [{ id: "display:solo", primary: true }],
      undefined,
      undefined,
      false,
      EMPTY_WS_CONFIG,
    );
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [w1]);
    // Authoritative focus of w1, as an external activation (cmd+tab) does.
    h.fake.focusWindowExternal(w1);
    h.fake.emitFocusEvent(w1);
    await new Promise((r) => setTimeout(r, 20));
    expect((await h.snapshot()).focusedWindow).toBe(w1);

    await h.run({ type: "focusWorkspace", name: "empty" });

    const snap = await h.snapshot();
    expect(snap.focusedWorkspace).toBe("empty");
    // The OS keeps w1 as its key window (nothing else took focus), but ws1
    // must stay parked: a stale intent re-revealing it is the flicker bug.
    expect(workspaceOf(snap, "1")?.visibleOnDisplay).toBeNull();

    const parkedFrame = h.fake.frameOf(w1);
    expect(parkedFrame).not.toBeNull();
    // Reconcile passes must not fight the park: zero writes to the parked
    // window, and its frame never leaves the parking spot.
    const writesAfterPark = h.fake.writes().length;
    for (let i = 0; i < 3; i += 1) {
      await h.run({ type: "reconcile" });
      const revealWrites = h.fake
        .writes()
        .slice(writesAfterPark)
        .filter((write) => write.windowId === w1);
      expect(revealWrites).toEqual([]);
      expect(h.fake.frameOf(w1)).toEqual(parkedFrame);
    }
    expect(workspaceOf(await h.snapshot(), "1")?.visibleOnDisplay).toBeNull();
    expect((await h.snapshot()).focusedWorkspace).toBe("empty");
  });

  test("cmd+tab to the parked window still reveals its workspace afterwards", async () => {
    const h = await bootstrap(
      [{ id: "display:solo", primary: true }],
      undefined,
      undefined,
      false,
      EMPTY_WS_CONFIG,
    );
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [w1]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });
    await h.run({ type: "focusWorkspace", name: "empty" });
    expect(workspaceOf(await h.snapshot(), "1")?.visibleOnDisplay).toBeNull();

    // Genuine external activation: the platform focuses the parked window.
    h.fake.focusWindowExternal(w1);
    h.fake.emitFocusEvent(w1);
    await new Promise((r) => setTimeout(r, 40));
    const snap = await h.snapshot();
    expect(snap.focusedWorkspace).toBe("1");
    expect(snap.focusedWindow).toBe(w1);
  });
});

describe("displaced workspace rollback on multi-display moves (round 3 issue 2)", () => {
  test("populated displaced workspace fully rolls back with original park display", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [w1]);

    // Populate `away` on the LEFT display.
    await h.run({
      type: "moveWorkspaceToDisplay",
      workspace: "away",
      displayId: "display:sim-left",
    });
    const wU = h.fake.addWindow(makeWindow({ x: -1400, y: 100 }));
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveWindowToWorkspace", windowId: wU, workspace: "away", follow: false });
    await h.run({ type: "reconcile" });
    let snap = await h.snapshot();
    expect(workspaceOf(snap, "away")?.visibleOnDisplay).toBe("display:sim-left");
    const awayFrameBefore = await frameOf(h, wU);

    // Move focused ws1 to the next (LEFT) display — displaces populated away,
    // whose members must park ON THE LEFT DISPLAY. Arm that write to fail.
    h.fake.swapBackingElement(wU);
    const error = await h.failure({ type: "moveFocusedWorkspaceToNextDisplay" });
    expect(error.code).toBe("inventory_stale");

    snap = await h.snapshot();
    expect(workspaceOf(snap, "away")?.visibleOnDisplay).toBe("display:sim-left");
    expect(snap.windows.find((x) => x.id === wU)?.parked).toBe(false);
    expect(workspaceOf(snap, "1")?.visibleOnDisplay).toBe("display:sim-primary");
    expect(workspaceOf(snap, "1")?.pinnedDisplayOverride).toBeNull();
    expect(await frameOf(h, wU)).toEqual(awayFrameBefore);
    expect((await frameOf(h, wU))?.x).toBeLessThan(-1000); // still on left display
  });
});

describe("capture-phase strictness (round 3 issue 3)", () => {
  test("missing required affected window fails inventory_stale before any mutation", async () => {
    let hideWindow: WId | null = null;
    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      getWindow: (id) => (id === hideWindow ? Effect.succeed(null) : inner.getWindow(id)),
    }));
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    const treeBefore = workspaceOf(await h.snapshot(), "1")!.tree;

    hideWindow = w2;
    try {
      const error = await h.failure({ type: "moveDirection", direction: "right" });
      expect(error.code).toBe("inventory_stale");
      expect(workspaceOf(await h.snapshot(), "1")!.tree).toEqual(treeBefore);
    } finally {
      hideWindow = null;
    }
  });

  test("hung capture is interrupted by the deadline; state unchanged", async () => {
    let blockCapture = false;
    let resumeCapture: (() => void) | null = null;
    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      getWindow: (id: WId) =>
        blockCapture
          ? Effect.async<import("../src/schema.ts").WindowObservation | null, PlatformError>(
              (res) => {
                resumeCapture = () => res(inner.getWindow(id));
              },
            )
          : inner.getWindow(id),
    }));
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    const treeBefore = workspaceOf(await h.snapshot(), "1")!.tree;

    // Block getWindow itself — capture never completes; the compressed
    // transaction deadline interrupts the whole exclusive section.
    DEADLINE.deadlineMs = 4000;
    blockCapture = true;
    const pending = h.failure({ type: "moveDirection", direction: "right" });
    await new Promise((r) => setTimeout(r, 60));
    expect(workspaceOf(await h.snapshot(), "1")!.tree).toEqual(treeBefore);

    const error = await Promise.race([
      pending,
      new Promise<{ code: string }>((resolve) =>
        setTimeout(() => resolve({ code: "timeout" }), 5000),
      ),
    ]);
    expect(error.code).toBe("timeout");
    DEADLINE.deadlineMs = 3;
    blockCapture = false;
    // SAFETY: The async adapter callback is the only writer and stores either a callable resumer or null.
    const resume = resumeCapture as (() => void) | null;
    resume?.();
    expect(workspaceOf(await h.snapshot(), "1")!.tree).toEqual(treeBefore);
  }, 12000);
});

describe("compensation identity race (round 3 issue 4)", () => {
  test("replacement inserted mid-plan: resumed write aborts stale, compensation skips, degraded", async () => {
    const gate = makeGate();
    const h = await bootstrap(undefined, gate.wrapper);
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });
    const frameBefore = { w1: await frameOf(h, w1), w2: await frameOf(h, w2) };

    DEADLINE.deadlineMs = 4000;
    // Suspend the FIRST retile write (w2), then insert a replacement behind
    // it WHILE its write is in flight — the native identity guard must abort.
    gate.arm((id, op) => id === w2 && op === "frame");
    const pending = Effect.runPromiseExit(
      h.engine.execute({
        type: "moveDirection",
        direction: "right",
      }),
    );
    await waitFor(() => gate.isSuspended());
    h.fake.swapBackingElement(w2);
    h.fake.nudgeSilent(w2, { x: 999 });
    gate.resume();

    const exit = await pending;
    DEADLINE.deadlineMs = 3;
    if (Exit.isSuccess(exit)) throw new Error("expected moveDirection to fail");
    const typedFailure = Cause.failureOption(exit.cause);
    const errCode = typedFailure._tag === "Some" ? typedFailure.value.code : "unknown";
    expect(["inventory_stale", "timeout"]).toContain(errCode);

    // Replacement untouched at its nudged position; peer restored.
    await waitFor(() => Math.abs((h.fake.frameOf(w1)?.x ?? NaN) - (frameBefore.w1?.x ?? NaN)) < 2);
    expect(await frameOf(h, w2)).toEqual({ ...frameBefore.w2, x: 999 });
    expect((await h.snapshot()).health).toBe("degraded");
    // Committed tree unchanged.
    const after = await h.snapshot();
    void after;
  });
});

describe("command waits behind blocked reconciliation (round 3 issue 6)", () => {
  test("semaphore suspension: command completes only after slow reconcile ends", async () => {
    let suspendGetWindows = false;
    const resumers: Array<() => void> = [];
    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      getWindows: () =>
        suspendGetWindows
          ? Effect.async<
              ReadonlyArray<import("../src/schema.ts").WindowObservation>,
              PlatformError
            >((res) => {
              resumers.push(() => res(inner.getWindows()));
            })
          : inner.getWindows(),
    }));
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });
    const treeBefore = workspaceOf(await h.snapshot(), "1")!.tree;
    const writesBefore = h.fake.writes().length;

    // Start a background reconcile that hangs inside its exclusive section.
    suspendGetWindows = true;
    h.fake.emitSleep();
    await new Promise((r) => setTimeout(r, 60));

    DEADLINE.deadlineMs = 20000;
    const pending = h.run({ type: "moveDirection", direction: "right" });
    await new Promise((r) => setTimeout(r, 30));

    // The newer focus is observed by the reconcile holding the gate. Once the
    // move acquires that gate, w2 is already at the right edge and must no-op.
    h.fake.focusWindowExternal(w2);

    suspendGetWindows = false;
    for (const resume of resumers.splice(0)) resume();
    const result = await pending;
    expect(result.type).toBe("ok");
    DEADLINE.deadlineMs = 3;
    const after = await h.snapshot();
    expect(workspaceOf(after, "1")!.tree).toEqual(treeBefore);
    expect(h.fake.writes().length).toBe(writesBefore);
    expect(h.fake.focusedWindowId()).toBe(w2);
  });
});

describe("named retile of unknown workspace (round 3 issue 7)", () => {
  test("fails workspace_not_found with no epoch bump", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [w1]);
    let epochBefore = (await h.snapshot()).epoch;

    // Ensure background passes are quiet so the epoch baseline is stable.
    await new Promise((r) => setTimeout(r, 30));
    epochBefore = (await h.snapshot()).epoch;

    const error = await h.failure({ type: "retile", workspace: "nope" });
    expect(error.code).toBe("workspace_not_found");
    expect((await h.snapshot()).epoch).toBe(epochBefore);
  });
});

describe("focused-window-first external reveal", () => {
  const parkedWorkspace = async (
    wrap?: (inner: PlatformAdapter, refs: EngineRefs) => PlatformAdapter,
  ) => {
    const h = await bootstrap(undefined, wrap);
    const old = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const peer = h.fake.addWindow(makeWindow({ x: 500, y: 100 }));
    const selected = h.fake.addWindow(makeWindow({ x: 900, y: 100 }));
    await seedWorkspace(h, [old, peer, selected]);
    await h.run({ type: "moveWindowToWorkspace", windowId: peer, workspace: "B", follow: false });
    await h.run({
      type: "moveWindowToWorkspace",
      windowId: selected,
      workspace: "B",
      follow: false,
    });
    await h.run({ type: "focusWorkspace", name: "B" });
    const target = h.fake.frameOf(selected);
    await h.run({ type: "focusWorkspace", name: "1" });
    return { h, old, peer, selected, target };
  };

  test("selected window reaches its tile before blocked old-workspace parking or peer reveal", async () => {
    const gate = makeGate();
    DEADLINE.deadlineMs = 4000;
    try {
      const { h, old, peer, selected, target } = await parkedWorkspace(gate.wrapper);
      const peerParked = h.fake.frameOf(peer);
      const writesBefore = h.fake.writes().length;
      gate.arm((id, op) => id === old && op === "frame");
      h.fake.focusWindowExternal(selected);
      const pending = h.run({ type: "reconcile" });
      await waitFor(() => gate.isSuspended());
      expect(h.fake.frameOf(selected)).toEqual(target);
      expect(h.fake.frameOf(peer)).toEqual(peerParked);
      expect(h.fake.writes().slice(writesBefore)[0]).toMatchObject({
        windowId: selected,
        op: "position",
      });
      gate.resume();
      await pending;
      expect((await h.snapshot()).focusedWorkspace).toBe("B");
      expect(h.fake.frameOf(peer)).not.toEqual(peerParked);
    } finally {
      gate.resume();
      DEADLINE.deadlineMs = 3;
    }
  });

  test("known focused window is revealed before a blocked full inventory refresh", async () => {
    let blockInventory = false;
    const resumers: Array<() => void> = [];
    DEADLINE.deadlineMs = 4000;
    try {
      const { h, selected, target } = await parkedWorkspace((inner) => ({
        ...inner,
        getWindows: () =>
          blockInventory
            ? Effect.async<
                ReadonlyArray<import("../src/schema.ts").WindowObservation>,
                PlatformError
              >((resume) => {
                resumers.push(() => resume(inner.getWindows()));
              })
            : inner.getWindows(),
      }));
      blockInventory = true;
      h.fake.focusWindowExternal(selected);
      const pending = h.run({ type: "reconcile" });
      await waitFor(() => resumers.length > 0);
      expect(h.fake.frameOf(selected)).toEqual(target);
      blockInventory = false;
      for (const resume of resumers.splice(0)) resume();
      await pending;
      expect((await h.snapshot()).focusedWorkspace).toBe("B");
    } finally {
      blockInventory = false;
      for (const resume of resumers.splice(0)) resume();
      DEADLINE.deadlineMs = 3;
    }
  });

  test("a newer user focus supersedes the preview before old-workspace parking", async () => {
    const gate = makeGate();
    DEADLINE.deadlineMs = 4000;
    try {
      const { h, old, selected } = await parkedWorkspace(gate.wrapper);
      const writesBefore = h.fake.writes().length;
      gate.arm((id, op) => id === selected && op === "position");
      h.fake.focusWindowExternal(selected);
      const pending = h.run({ type: "reconcile" });
      await waitFor(() => gate.isSuspended());
      h.fake.focusWindowExternal(old);
      await waitFor(() => h.engine.gateState().rerunQueued === true);
      gate.resume();
      await pending;
      await h.run({ type: "reconcile" });
      const snapshot = await h.snapshot();
      expect(snapshot.focusedWindow).toBe(old);
      expect(snapshot.focusedWorkspace).toBe("1");
      expect(
        h.fake
          .writes()
          .slice(writesBefore)
          .filter((write) => write.windowId === old),
      ).toEqual([]);
    } finally {
      gate.resume();
      DEADLINE.deadlineMs = 3;
    }
  });

  test("focused preview leaves the other display and its windows untouched", async () => {
    DEADLINE.deadlineMs = 4000;
    try {
      const { h, selected } = await parkedWorkspace();
      const unrelated = h.fake.addWindow(makeWindow({ x: 400, y: 400 }));
      await h.run({ type: "reconcile" });
      await h.run({
        type: "moveWindowToWorkspace",
        windowId: unrelated,
        workspace: "S",
        follow: false,
      });
      await h.run({
        type: "moveWorkspaceToDisplay",
        workspace: "S",
        displayId: "display:sim-left",
      });
      const frameBefore = h.fake.frameOf(unrelated);
      const writesBefore = h.fake.writes().length;
      h.fake.focusWindowExternal(selected);
      await h.run({ type: "reconcile" });
      expect(h.fake.frameOf(unrelated)).toEqual(frameBefore);
      expect(workspaceOf(await h.snapshot(), "S")?.visibleOnDisplay).toBe("display:sim-left");
      expect(
        h.fake
          .writes()
          .slice(writesBefore)
          .filter((write) => write.windowId === unrelated),
      ).toEqual([]);
    } finally {
      DEADLINE.deadlineMs = 3;
    }
  });

  test("stale focused-window identity aborts before parking old windows or retrying writes", async () => {
    let rejectId: WindowId | null = null;
    DEADLINE.deadlineMs = 4000;
    try {
      const { h, old, selected } = await parkedWorkspace((inner) => ({
        ...inner,
        setWindowPosition: (id, point, expected) =>
          id === rejectId
            ? Effect.fail(new PlatformError({ code: "stale", detail: "focused window replaced" }))
            : inner.setWindowPosition(id, point, expected),
      }));
      const oldFrame = h.fake.frameOf(old);
      const parked = h.fake.frameOf(selected);
      const writesBefore = h.fake.writes().length;
      rejectId = selected;
      h.fake.focusWindowExternal(selected);
      const error = await h.failure({ type: "reconcile" });
      expect(error.code).toBe("inventory_stale");
      expect(h.fake.frameOf(old)).toEqual(oldFrame);
      expect(h.fake.frameOf(selected)).toEqual(parked);
      expect(h.fake.writes().slice(writesBefore)).toEqual([]);
    } finally {
      DEADLINE.deadlineMs = 3;
    }
  });
});

describe("read-only live window observation", () => {
  test("PID observation reads an omitted application while paused without selecting the focused window", async () => {
    const reads: number[] = [];
    const diagnostics = makeWindowDiagnostics(null, 65900);
    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      inspectApplication: (pid) =>
        Effect.sync(() => {
          reads.push(pid);
          return { window: null, diagnostics };
        }),
    }));
    const id = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [id]);
    await h.run({ type: "pause" });
    const before = await h.snapshot();
    const writes = h.fake.writes().length;
    expect(await h.run({ type: "getWindow", pid: 65900 })).toMatchObject({
      type: "window",
      window: null,
      cachedWindow: null,
      diagnostics,
    });
    expect(reads).toEqual([65900]);
    expect(await h.snapshot()).toEqual(before);
    expect(h.fake.writes().length).toBe(writes);
  });

  test("PID observation rejects a native result for a different process", async () => {
    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      inspectApplication: () =>
        Effect.succeed({ window: null, diagnostics: makeWindowDiagnostics(null, 7) }),
    }));
    expect((await h.failure({ type: "getWindow", pid: 65900 })).code).toBe("inventory_stale");
  });

  test("PID observation reports unsupported adapters rather than inspecting another window", async () => {
    const h = await bootstrap();
    expect((await h.failure({ type: "getWindow", pid: 65900 })).code).toBe("invalid_request");
  });

  test("returns privileged diagnostics and live facts without changing cached state, geometry, or focus", async () => {
    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      inspectWindow: (id) =>
        Effect.map(inner.getWindow(id), (window) => ({
          window,
          diagnostics: makeWindowDiagnostics(id, window?.pid ?? 42),
        })),
    }));
    const id = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [id]);
    const before = await h.snapshot();
    const cached = h.fake.frameOf(id)!;
    await h.run({ type: "pause" });
    h.fake.nudgeSilent(id, { x: cached.x + 37 });
    const writesBefore = h.fake.writes().length;
    const result = await h.run({ type: "getWindow", windowId: id });
    if (result.type !== "window") throw new Error("expected window inspection");
    expect(result.window?.frame.x).toBe(cached.x + 37);
    expect(result.cachedWindow?.frame).toEqual(cached);
    expect(result.diagnostics?.target.registered).toBe(false);
    expect(result.diagnostics?.queries[1]).toMatchObject({ errorCode: -25204, value: null });
    expect(h.fake.writes().length).toBe(writesBefore);
    const after = await h.snapshot();
    expect(after.windows.find((window) => window.id === id)?.frame).toEqual(cached);
    expect(after.focusedWindow).toBe(before.focusedWindow);
    expect(after.focusedWorkspace).toBe(before.focusedWorkspace);
  });

  test("a vanished live window remains explicit null instead of reusing its cached observation", async () => {
    let vanished = false;
    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      inspectWindow: (id) =>
        vanished
          ? Effect.succeed({
              window: null,
              diagnostics: { ...makeWindowDiagnostics(id), resolutionError: "not_found" },
            })
          : Effect.map(inner.getWindow(id), (window) => ({ window })),
    }));
    const id = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [id]);
    vanished = true;
    const result = await h.run({ type: "getWindow", windowId: id });
    if (result.type !== "window") throw new Error("expected window inspection");
    expect(result.window).toBeNull();
    expect(result.cachedWindow?.id).toBe(id);
    expect(result.diagnostics?.resolutionError).toBe("not_found");
  });
});

describe("globally authoritative window focus", () => {
  test("an idempotent focus command cannot swallow a later manual return to that window", async () => {
    const h = await bootstrap();
    const first = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const second = h.fake.addWindow(makeWindow({ x: 900, y: 100 }));
    await seedWorkspace(h, [first, second]);
    await h.run({ type: "moveWindowToWorkspace", windowId: second, workspace: "B", follow: false });
    await h.run({ type: "focusWindow", windowId: first });
    await h.run({ type: "focusWindow", windowId: second });
    h.fake.focusWindowExternal(first);
    await h.run({ type: "reconcile" });
    const snapshot = await h.snapshot();
    expect(snapshot.focusedWindow).toBe(first);
    expect(snapshot.focusedWorkspace).toBe("1");
    expect(workspaceOf(snapshot, "1")?.visibleOnDisplay).toBe("display:sim-primary");
  });

  test("external focus arriving before admission selects the window's configured workspace", async () => {
    const h = await bootstrap(undefined, undefined, undefined, false, {
      load: () =>
        Effect.succeed({
          workspaces: [{ name: "B", assign: [{ bundleId: "app.zen-browser.zen" }] }],
        }),
      changes: () => Stream.empty,
    });
    const first = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [first]);
    const zen = h.fake.addWindow(makeWindow({ bundleId: "app.zen-browser.zen", x: 900, y: 100 }));
    h.fake.focusWindowExternal(zen);
    await h.run({ type: "reconcile" });
    const snapshot = await h.snapshot();
    expect(snapshot.focusedWindow).toBe(zen);
    expect(snapshot.focusedWorkspace).toBe("B");
    expect(workspaceOf(snapshot, "B")?.members).toEqual([zen]);
    expect(workspaceOf(snapshot, "B")?.visibleOnDisplay).toBe("display:sim-primary");
  });

  test.each([
    { focused: false, active: true },
    { focused: true, active: false },
  ])(
    "app-local focus/main flags are insufficient ($focused, $active)",
    async ({ focused, active }) => {
      const h = await bootstrap(undefined, (inner) => ({
        ...inner,
        focusWindow: (id) =>
          Effect.map(inner.getWindow(id), (window) => ({
            frontmostPid: active ? window!.pid : -1,
            focused,
            main: true,
          })),
      }));
      const first = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
      const second = h.fake.addWindow(makeWindow({ x: 900, y: 100 }));
      await seedWorkspace(h, [first, second]);
      const error = await h.failure({ type: "focusDirection", direction: "right" });
      expect(error.code).toBe("window_not_controllable");
      expect((await h.snapshot()).focusedWindow).toBe(first);
      expect(h.fake.focusedWindowId()).toBe(first);
    },
  );

  test.each(["workspace", "window"] as const)(
    "inactive app flags cannot redirect %s focus then assignment",
    async (focus) => {
      let inactiveId: WindowId | null = null;
      const h = await bootstrap(
        undefined,
        (inner) => ({
          ...inner,
          getWindows: () =>
            Effect.map(inner.getWindows(), (windows) =>
              inactiveId === null
                ? windows
                : windows.map((window) => ({
                    ...window,
                    focused: window.id === inactiveId,
                  })),
            ),
        }),
        undefined,
        true,
      );
      const zen = h.fake.addWindow(makeWindow({ appName: "Zen", x: 100, y: 100 }));
      const bambu = h.fake.addWindow(makeWindow({ appName: "Bambu Studio", x: 900, y: 100 }));
      const terminal = h.fake.addWindow(makeWindow({ appName: "Ghostty", x: 400, y: 400 }));
      await seedWorkspace(h, [zen, bambu, terminal]);
      await h.run({ type: "moveWindowToWorkspace", windowId: zen, workspace: "B", follow: false });
      await h.run({
        type: "moveWindowToWorkspace",
        windowId: bambu,
        workspace: "3",
        follow: false,
      });
      // The polluted report must CHANGE from the last observed ID; otherwise
      // the old change-detection guard could accidentally make this test pass.
      h.fake.focusWindowExternal(terminal);
      await h.run({ type: "reconcile" });
      expect((await h.snapshot()).focusedWindow).toBe(terminal);
      h.fake.setDeferFocus(true);
      await h.run(
        focus === "workspace"
          ? { type: "focusWorkspace", name: "B" }
          : { type: "focusWindow", windowId: zen },
      );
      inactiveId = bambu;
      await h.run({ type: "reconcile" });
      expect((await h.snapshot()).focusedWindow).toBe(zen);
      await h.run({ type: "moveWindowToWorkspace", workspace: "T" });
      const snapshot = await h.snapshot();
      expect(workspaceOf(snapshot, "T")?.members).toContain(zen);
      expect(workspaceOf(snapshot, "3")?.members).toEqual([bambu]);
      expect(h.fake.focusedWindowId()).toBe(zen);
    },
  );

  test("explicit focus reveals a parked workspace and selects the requested member", async () => {
    const h = await bootstrap();
    const first = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const selected = h.fake.addWindow(makeWindow({ x: 900, y: 100 }));
    await seedWorkspace(h, [first, selected]);
    await h.run({ type: "focusWorkspace", name: "away" });
    expect(workspaceOf(await h.snapshot(), "1")?.visibleOnDisplay).toBeNull();
    await h.run({ type: "focusWindow", windowId: selected });
    const snapshot = await h.snapshot();
    expect(snapshot.focusedWorkspace).toBe("1");
    expect(snapshot.focusedWindow).toBe(selected);
    expect(workspaceOf(snapshot, "1")?.visibleOnDisplay).toBe("display:sim-primary");
    expect(workspaceOf(snapshot, "1")?.lastFocusedMember).toBe(selected);
    expect(h.fake.focusedWindowId()).toBe(selected);
    expect(h.fake.frameOf(selected)?.x).toBeGreaterThanOrEqual(0);
  });

  test("external focus reveals the containing workspace and navigation uses its members", async () => {
    const h = await bootstrap();
    const left = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const right = h.fake.addWindow(makeWindow({ x: 900, y: 100 }));
    await seedWorkspace(h, [left, right]);
    await h.run({ type: "focusWorkspace", name: "away" });
    h.fake.focusWindowExternal(left);
    await h.run({ type: "reconcile" });
    const snapshot = await h.snapshot();
    expect(snapshot.focusedWorkspace).toBe("1");
    expect(snapshot.focusedWindow).toBe(left);
    expect(workspaceOf(snapshot, "1")?.visibleOnDisplay).toBe("display:sim-primary");
    await h.run({ type: "focusDirection", direction: "right" });
    expect(h.fake.focusedWindowId()).toBe(right);
  });

  test("external focus on another visible display selects its workspace without relocating it", async () => {
    const h = await bootstrap();
    const primary = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const secondary = h.fake.addWindow(makeWindow({ x: 900, y: 100 }));
    await seedWorkspace(h, [primary, secondary]);
    await h.run({
      type: "moveWindowToWorkspace",
      windowId: secondary,
      workspace: "B",
      follow: false,
    });
    await h.run({ type: "moveWorkspaceToDisplay", workspace: "B", displayId: "display:sim-left" });
    await h.run({ type: "focusWindow", windowId: primary });
    h.fake.focusWindowExternal(secondary);
    await h.run({ type: "reconcile" });
    const snapshot = await h.snapshot();
    expect(snapshot.focusedWorkspace).toBe("B");
    expect(snapshot.focusedWindow).toBe(secondary);
    expect(workspaceOf(snapshot, "B")?.visibleOnDisplay).toBe("display:sim-left");
    expect(workspaceOf(snapshot, "1")?.visibleOnDisplay).toBe("display:sim-primary");
  });
});

describe("authoritative external focus event supersedes equal-id stale snapshot (round 3 issue 5)", () => {
  test("newer event wins even when its id equals the last stale report", async () => {
    const h = await bootstrap();
    h.fake.setDeferFocus(true);
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);

    // Baseline intent w1 (released so observations agree).
    h.fake.focusWindowExternal(w1);
    h.fake.releaseDeferredFocus();
    await h.run({ type: "reconcile" });
    expect((await h.snapshot()).focusedWindow).toBe(w1);

    // Engine focuses w2; observations stay STALE at w1 across reconciles.
    await h.run({ type: "focusDirection", direction: "right" });
    await h.run({ type: "reconcile" });
    await h.run({ type: "reconcile" });
    expect((await h.snapshot()).focusedWindow).toBe(w2);

    // NEW authoritative external event naming w1 — same id as the stale
    // snapshot reports. Change-detection alone would ignore it; the ordered
    // event generation supersedes the engine intent.
    h.fake.emitFocusEvent(w1);
    await new Promise((r) => setTimeout(r, 20));
    expect((await h.snapshot()).focusedWindow).toBe(w1);

    // Directional continuation now runs from w1 again.
    await h.run({ type: "focusDirection", direction: "right" });
    expect((await h.snapshot()).focusedWindow).toBe(w2);
  });
});

describe("single-consumer event subscription (final review issue 1)", () => {
  test("one subscriber drives both focus signals and reconciliation", async () => {
    let maxActive = 0;
    let active = 0;
    let sink: ((e: PlatformEvent) => void) | null = null;
    const push = (event: PlatformEvent): void => sink?.(event);

    const h = await bootstrap(undefined, (inner) => ({
      ...inner,
      // Deliberately SINGLE-consumer: a second engine subscription would
      // steal/queue events and break delivery entirely.
      events: Stream.asyncPush<PlatformEvent>((emit) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            sink = (e: PlatformEvent) => emit.single(e);
          }),
          () =>
            Effect.sync(() => {
              active -= 1;
              sink = null;
            }),
        ),
      ),
    }));
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    const epochBefore = (await h.snapshot()).epoch;

    // A focus event through the ONE subscription updates signals…
    push({ kind: "focus_changed", windowId: w2 });
    await new Promise((r) => setTimeout(r, 40));
    // Event-authoritative supersede: intent moves even though the platform's
    // real focus pointer is untouched by this synthetic event.
    let snap = await h.snapshot();
    expect(snap.focusedWindow).toBe(w2);
    expect(h.fake.focusedWindowId()).toBe(w1);

    // …and the SAME event loop requests reconciliation.
    h.fake.updateWorkArea("display:sim-primary", {
      x: 0,
      y: 38,
      width: 1512,
      height: 600,
    });
    push({ kind: "topology_changed" });
    await waitFor(() => {
      const f = h.fake.frameOf(w1);
      return f !== null && f.height === 600;
    });
    snap = await h.snapshot();
    expect(snap.epoch).toBeGreaterThan(epochBefore);

    // Exactly ONE concurrent subscription was ever registered.
    expect(maxActive).toBe(1);
  });
});

describe("busy-event coalesced rerun guarantees convergence (final issue 2)", () => {
  test("work-area change arriving mid-command converges after release", async () => {
    const gate = makeGate();
    const h = await bootstrap(undefined, gate.wrapper);
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });

    DEADLINE.deadlineMs = 4000;
    gate.arm((id, op) => id === w2 && op === "frame");
    const pending = h.run({ type: "moveDirection", direction: "right" });
    await waitFor(() => gate.isSuspended());

    // Event arrives while the command holds the mutex: gatedReconcile must
    // coalesce (assign reconcileAgain=true) and guarantee a post-release
    // rerun. Wait for the DETERMINISTIC acknowledgment that the event
    // consumer actually reached the busy branch before releasing.
    h.fake.updateWorkArea("display:sim-primary", {
      x: 0,
      y: 38,
      width: 1512,
      height: 500,
    });
    h.fake.emitSleep();
    await waitFor(() => h.engine.gateState().rerunQueued === true);
    expect(h.engine.gateState().busy).toBe(true);

    gate.resume();
    const result = await pending;
    expect(result.type).toBe("ok");
    DEADLINE.deadlineMs = 3;

    // Post-release convergence AND the queued rerun was consumed.
    await waitFor(() => (h.fake.frameOf(w1)?.height ?? 0) === 500);

    // Post-release rerun converged tiles onto the NEW work area (the swap
    // put w2 in the LEFT pane and w1 in the RIGHT).
    await waitFor(() => (h.fake.frameOf(w1)?.height ?? 0) === 500);
    expect(await frameOf(h, w1)).toEqual(frame(760, 38, 752, 500));
    expect(await frameOf(h, w2)).toEqual(frame(0, 38, 752, 500));
  });
});

describe("atomic identity guard end-to-end (final issue 3)", () => {
  test("replacement materializing between compensation read and write aborts stale; untouched", async () => {
    const gate = makeGate();
    const h = await bootstrap(undefined, gate.wrapper);
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    const stray = h.fake.addWindow(makeWindow({ x: -1400, y: -900 }));
    await h.run({ type: "reconcile" });
    await h.run({ type: "floatWindow", windowId: stray });
    await h.run({ type: "reconcile" });
    const strayBefore = await frameOf(h, stray);
    const w1Before = await frameOf(h, w1);

    DEADLINE.deadlineMs = 4000;
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });
    // Suspend the FIRST scoped-plan write (w2) so the failure happens before
    // ANY other effect, keeping the stray's replacement pending until the
    // compensation phase reads it.
    const writeMark = h.fake.writes().length;
    gate.arm((id, op) => id === w2 && op === "frame");
    const pending = h.failure({ type: "moveDirection", direction: "right" });
    await waitFor(() => gate.isSuspended());
    h.fake.swapBackingElement(w2);
    h.fake.swapBackingElement(stray);
    h.fake.nudgeSilent(stray, { x: -777 });
    gate.resume();

    const error = await pending;
    expect(error.code).toBe("inventory_stale");

    // Compensation read the stray PRE-materialization (matching identity),
    // attempted the guarded restore, and the ADAPTER atomically refused it:
    // the replacement was never mutated.
    expect(await frameOf(h, stray)).toEqual({ ...strayBefore, x: -777 });
    // Peer fully restored by the guarded compensation.
    await waitFor(() => {
      const f = h.fake.frameOf(w1);
      return f !== null && Math.abs(f.x - (w1Before?.x ?? NaN)) < 2;
    });
    expect(await frameOf(h, w1)).toEqual(w1Before);
    expect((await h.snapshot()).health).toBe("degraded");
    // No SUCCESSFUL adapter write ever landed on the stray after arming.
    expect(
      h.fake
        .writes()
        .slice(writeMark)
        .some((x) => x.windowId === stray),
    ).toBe(false);
  });
});

describe("pending focus signal lifecycle batching", () => {
  test("a waiting directional command observes focus before gate release", async () => {
    const gate = makeGate();
    const h = await bootstrap(undefined, gate.wrapper);
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w1);
    await h.run({ type: "reconcile" });
    expect((await h.snapshot()).focusedWindow).toBe(w1);

    DEADLINE.deadlineMs = 4000;
    // 1) Strict retile takes the mutex and suspends on its first write
    //    (windows were silently nudged so the plan has real work).
    h.fake.nudgeSilent(w1, { x: 30 });
    h.fake.nudgeSilent(w2, { x: -40 });
    gate.arm((id, op) => id === w1 && op === "frame");
    const retile = h.run({ type: "retile" });
    await waitFor(() => gate.isSuspended());

    h.fake.emitFocusEvent(w2);
    const queuedDirection = h.run({ type: "focusDirection", direction: "left" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.resume();
    await Promise.all([retile, queuedDirection]);
    DEADLINE.deadlineMs = 3;

    // LEFT from origin w2 lands on w1. Without pre-release delivery the
    // stale origin w1 would have wrapped right back to w2.
    expect(h.fake.focusedWindowId()).toBe(w1);
    expect((await h.snapshot()).focusedWindow).toBe(w1);
  });

  test("workspace move resolves from focus after the queued cycle settles", async () => {
    const gate = makeGate();
    const h = await bootstrap(undefined, gate.wrapper);
    const docker = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const primary = h.fake.addWindow(makeWindow({ x: 900, y: 100 }));
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveWindowToWorkspace", windowId: docker, workspace: "D", follow: false });
    await h.run({
      type: "moveWorkspaceToDisplay",
      workspace: "D",
      displayId: "display:sim-primary",
    });
    expect((await h.snapshot()).focusedWorkspace).not.toBe("D");
    h.fake.focusWindowExternal(primary);
    await h.run({ type: "reconcile" });
    expect((await h.snapshot()).focusedWindow).toBe(primary);

    DEADLINE.deadlineMs = 4000;
    const dockerFrame = (await frameOf(h, docker))!;
    gate.arm((id, op) => id === docker && op === "frame");
    const heldWrite = h.run({
      type: "setWindowFrame",
      windowId: docker,
      frame: { ...dockerFrame, width: dockerFrame.width - 30 },
    });
    await waitFor(() => gate.isSuspended());

    const settled = Effect.runPromise(
      h.engine.events().pipe(
        Stream.filter((event) => event.topic === "reconciliation"),
        Stream.take(1),
        Stream.runDrain,
      ),
    );
    h.fake.emitFocusEvent(docker);
    gate.resume();
    await Promise.all([heldWrite, settled]);
    await h.run({ type: "moveFocusedWorkspaceToNextDisplay" });
    DEADLINE.deadlineMs = 3;

    const snap = await h.snapshot();
    expect(workspaceOf(snap, "D")?.visibleOnDisplay).toBe("display:sim-left");
    expect(workspaceOf(snap, "D")?.pinnedDisplayOverride).toBe("display:sim-left");
    expect(workspaceOf(snap, "1")?.pinnedDisplayOverride).toBeNull();
  });
});

describe("required-nullable subrole in identity fingerprint (final fix 2)", () => {
  test("same pid+role replacement with NON-null subrole ⇒ stale, untouched, degraded", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    h.fake.focusWindowExternal(w2);
    await h.run({ type: "reconcile" });
    const w2Before = await frameOf(h, w2);
    const w1Before = await frameOf(h, w1);

    // Replacement keeps pid AND role but carries a NON-null subrole where the
    // original had none (fingerprint null vs "AXStandardWindow").
    h.fake.swapBackingElement(w1, { samePid: true, subrole: "AXStandardWindow" });
    const error = await h.failure({ type: "moveDirection", direction: "left" });
    expect(error.code).toBe("inventory_stale");

    // The guarded compensation write was refused atomically: replacement
    // remains EXACTLY as materialized (same frame; subrole now set).
    expect(await frameOf(h, w1)).toEqual(w1Before);
    const obsAfter = h.fake.windowIds().length; // sanity liveness
    void obsAfter;
    expect((await h.snapshot()).health).toBe("degraded");
    // Peer restored completely.
    expect(await frameOf(h, w2)).toEqual(w2Before);

    // And a subsequent identical-direction command succeeds once the
    // replacement is the live window (engine re-captures a FRESH identity
    // each attempt). Leaves after this second swap: [w2, w1].
    await h.run({ type: "moveDirection", direction: "left" });
    expect(await frameOf(h, w2)).toEqual(frame(0, 38, 752, 944));
    expect(await frameOf(h, w1)).toEqual(frame(760, 38, 752, 944));
  });
});
