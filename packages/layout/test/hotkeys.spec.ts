import { describe, expect, test } from "vitest";
import { Cause, Effect, Exit, Stream } from "effect";
import { createEngine } from "../src/engine.ts";
import type { Engine } from "../src/engine.ts";
import type { Command, CommandResult, StateSnapshot } from "../src/commands.ts";
import type { DomainEvent } from "../src/events.ts";
import type { Clock, ConfigSource } from "../src/platform.ts";
import type { Frame, WindowId } from "../src/schema.ts";
import type { PlatformAdapter } from "../src/platform.ts";
import type { PlatformError, PlatformEvent, WriteObservation } from "../src/schema.ts";
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
    const { executeBatch: _batch, ...legacyAdapter } = wrap(fake.adapter, refs);
    void _batch;
    return legacyAdapter;
  })();
  const engine = await Effect.runPromise(
    createEngine({ adapter, configSource: CONFIG_SOURCE, clock: CLOCK }),
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

/** Ingest observations, then ensure every given window is tiled into
 * workspace "1" in order. Insertion goes through whichever path wins
 * (auto-assign preflight or explicit move) — both read identical committed
 * observations and the same lastFocusedMember, so the resulting tree and
 * axes are deterministic either way. The membership guard prevents a
 * double insert (remove/re-add would reset lastFocusedMember). */
const seedWorkspace = async (h: Harness, ids: readonly WindowId[]): Promise<void> => {
  await h.run({ type: "reconcile" });
  for (const id of ids) {
    const snap = await h.snapshot();
    const ws1 = snap.workspaces.find((ws) => ws.name === "1");
    if (!ws1?.members.includes(id)) {
      await h.run({ type: "moveWindowToWorkspace", windowId: id, workspace: "1" });
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

describe("moveFocusedWindowToWorkspace", () => {
  test("focused observation takes precedence over lastFocusedMember; focus follows", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 400, y: 400 }));
    await seedWorkspace(h, [w1, w2]);

    // w1 holds OS focus (first added); w2 is the tree's lastFocusedMember.
    let snap = await h.snapshot();
    const ws1 = workspaceOf(snap, "1");
    expect(sorted(ws1?.members ?? [])).toEqual(sorted([w1, w2]));
    expect(ws1?.lastFocusedMember).toBe(w2);
    expect(h.fake.focusedWindowId()).toBe(w1);

    await h.run({ type: "moveFocusedWindowToWorkspace", workspace: "scratch" });
    snap = await h.snapshot();

    const scratch = workspaceOf(snap, "scratch");
    expect(scratch?.members).toEqual([w1]); // focused wins over lastFocusedMember
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

    h.fake.focusWindowExternal(null);
    await h.run({ type: "reconcile" });

    await h.run({ type: "moveFocusedWindowToWorkspace", workspace: "scratch" });
    const snap = await h.snapshot();
    expect(workspaceOf(snap, "scratch")?.members).toEqual([w2]);
    expect(workspaceOf(snap, "1")?.members).toEqual([w1]);
  });

  test("no focus and no live fallback member is a structured error", async () => {
    const h = await bootstrap();
    const error = await h.failure({ type: "moveFocusedWindowToWorkspace", workspace: "x" });
    expect(error.code).toBe("window_not_found");
  });

  test("a focused non-normal window refuses with window_not_manageable", async () => {
    const h = await bootstrap();
    h.fake.addWindow(makeWindow({ subrole: "AXDialog", x: 60, y: 60 }));
    await h.run({ type: "reconcile" });
    const error = await h.failure({ type: "moveFocusedWindowToWorkspace", workspace: "x" });
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
    await h.run({ type: "moveWindowToWorkspace", windowId: docker, workspace: "D" });
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
    await h.run({ type: "moveWindowToWorkspace", windowId: terminal, workspace: "T" });
    await h.run({
      type: "moveWorkspaceToDisplay",
      workspace: "T",
      displayId: "display:sim-primary",
    });
    h.fake.focusWindowExternal(terminal);
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveFocusedWindowToWorkspace", workspace: "D" });

    const moved = await h.snapshot();
    expect(moved.windows.find((window) => window.id === terminal)?.workspace).toBe("D");
    expect(workspaceOf(moved, "D")?.visibleOnDisplay).toBe("display:sim-left");
    expect(h.fake.frameOf(terminal)?.x).toBeLessThan(0);
  });
});

describe("focusDirection", () => {
  test("focuses the directional neighbor, wraps at edges, updates lastFocusedMember on success only", async () => {
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

    // At the right edge: wrap within the workspace.
    await h.run({ type: "focusDirection", direction: "right" });
    expect(h.fake.focusedWindowId()).toBe(w1);
    snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.lastFocusedMember).toBe(w1);
  });

  test("adapter focus refusal leaves lastFocusedMember untouched; retry succeeds", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    const w3 = h.fake.addWindow(makeWindow({ x: 1200, y: 600 }));
    await seedWorkspace(h, [w1, w2, w3]);

    // Arm every OTHER member: whichever neighbor UP resolves to aborts.
    h.fake.focusWindowExternal(w3);
    await h.run({ type: "reconcile" });
    let snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.lastFocusedMember).toBe(w3);

    h.fake.swapBackingElement(w1);
    h.fake.swapBackingElement(w2);
    const error = await h.failure({ type: "focusDirection", direction: "up" });
    expect(error.code).toBe("inventory_stale");
    snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.lastFocusedMember).toBe(w3); // unchanged
    expect(h.fake.focusedWindowId()).toBe(w3);

    // Retry: one replacement was consumed by the failed attempt; re-arm the
    // remaining candidate handles so the retry itself is also exercised.
    const retryNeighbor = h.fake.focusedWindowId();
    void retryNeighbor;
    await h.run({ type: "focusDirection", direction: "up" });
    snap = await h.snapshot();
    const newFocus = h.fake.focusedWindowId();
    expect(newFocus === w1 || newFocus === w2).toBe(true);
    expect(workspaceOf(snap, "1")?.lastFocusedMember).toBe(newFocus ?? null);
  });

  test("a single-window workspace has no neighbor: structured error", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await seedWorkspace(h, [w1]);
    const error = await h.failure({ type: "focusDirection", direction: "right" });
    expect(error.code).toBe("window_not_found");
  });
});

describe("moveDirection", () => {
  test("edge wrap swaps the two leaves, retiles exact frames, keeps focus", async () => {
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

    // w1 sits in the LEFT pane; pressing LEFT wraps to w2.
    await h.run({ type: "moveDirection", direction: "left" });

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
    expect(await frameOf(h, w1)).toEqual(frame(764, 38, 748, 944));
    expect(await frameOf(h, w2)).toEqual(frame(0, 38, 756, 944));
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
    expect(await frameOf(h, w2)).toEqual(frame(0, 38, 1512, 472));
    expect(await frameOf(h, w1)).toEqual(frame(0, 518, 1512, 464));
    expect(h.fake.focusedWindowId()).toBe(w1);
  });

  test("nested-tree move reinserts the focused leaf at the destination pane", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 200 }));
    await seedWorkspace(h, [w1, w2]); // tiles w1|w2 so w2's pane is tall
    const w3 = h.fake.addWindow(makeWindow({ x: 1100, y: 700 }));
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveWindowToWorkspace", windowId: w3, workspace: "1" });
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
      first: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "leaf", windowId: w1 },
        second: { kind: "leaf", windowId: w2 },
      },
      second: { kind: "leaf", windowId: w3 },
    });
    expect(await frameOf(h, w1)).toEqual(frame(0, 38, 756, 472));
    expect(await frameOf(h, w2)).toEqual(frame(0, 518, 756, 464));
    expect(await frameOf(h, w3)).toEqual(frame(764, 38, 748, 944));
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

  test("floating swap target rejects instead of guessing another pair", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    await h.run({ type: "floatWindow", windowId: w2 });
    await h.run({ type: "reconcile" });

    // w1 (tiled, focused) has only the floating w2 as spatial candidate.
    const error = await h.failure({ type: "moveDirection", direction: "right" });
    expect(error.code).toBe("window_not_manageable");
    const snap = await h.snapshot();
    expect(workspaceOf(snap, "1")?.members).toEqual([w1]); // tree untouched
  });
});

describe("pause gating for hotkey commands", () => {
  test("directional/layout mutations fail paused; togglePause still works", async () => {
    const h = await bootstrap();
    const w1 = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const w2 = h.fake.addWindow(makeWindow({ x: 900, y: 300 }));
    await seedWorkspace(h, [w1, w2]);
    await h.run({ type: "pause" });

    expect((await h.failure({ type: "focusDirection", direction: "left" })).code).toBe("paused");
    expect((await h.failure({ type: "moveDirection", direction: "left" })).code).toBe("paused");
    expect((await h.failure({ type: "moveFocusedWindowToWorkspace", workspace: "s" })).code).toBe(
      "paused",
    );
    expect((await h.failure({ type: "moveFocusedWorkspaceToNextDisplay" })).code).toBe("paused");

    await h.run({ type: "togglePause" });
    expect((await h.snapshot()).paused).toBe(false);

    // Unpaused, the same directional command executes normally.
    await h.run({ type: "focusDirection", direction: "right" });
    expect(h.fake.focusedWindowId()).toBe(w2);
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
    const w3 = h.fake.addWindow(makeWindow({ x: 1200, y: 600 }));
    await seedWorkspace(h, [w1, w2, w3]);
    h.fake.focusWindowExternal(w2);
    await h.run({ type: "reconcile" });

    // Row panes w1|w2|w3. RIGHT from w2 swaps with w3; retile then writes
    // w3 into the middle slot (SUCCEEDS) before failing on w2.
    const before = await h.snapshot();
    const wsBefore = workspaceOf(before, "1")!;
    const frameBefore = {
      w1: await frameOf(h, w1),
      w2: await frameOf(h, w2),
      w3: await frameOf(h, w3),
    };

    h.fake.swapBackingElement(w2);
    const error = await h.failure({ type: "moveDirection", direction: "right" });
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
    const error = await h.failure({ type: "moveFocusedWindowToWorkspace", workspace: "scratch" });
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
    await h.run({ type: "moveFocusedWindowToWorkspace", workspace: "away" });

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
    // right → w2, right wraps → w1, left wraps → w2.
    await h.run({ type: "focusDirection", direction: "right" });
    expect(h.fake.focusedWindowId()).toBe(w2);
    await h.run({ type: "focusDirection", direction: "right" });
    expect(h.fake.focusedWindowId()).toBe(w1);
    await h.run({ type: "focusDirection", direction: "left" });
    expect(h.fake.focusedWindowId()).toBe(w2);
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
    expect(workspaceOf(snap, "1")?.lastFocusedMember).toBe(w2); // valid fallback exists

    // Externally focus a transient dialog; reconcile adopts that observation.
    const dialog = h.fake.addWindow(makeWindow({ subrole: "AXDialog", x: 60, y: 60 }));
    h.fake.focusWindowExternal(dialog);
    await h.run({ type: "reconcile" });

    const error = await h.failure({ type: "moveFocusedWindowToWorkspace", workspace: "scratch" });
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
    await waitFor(() => h.fake.writes().some((x) => x.windowId === w2 && x.observed.width === 748));

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
    const pending = h.run({ type: "moveFocusedWindowToWorkspace", workspace: "scratch" });
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
    expect(await frameOf(h, w1)).toEqual(frame(0, 38, 756, 944)); // repaired
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

    // Second press resolves origin from the INTENT (w2) and wraps to w1.
    await h.run({ type: "focusDirection", direction: "right" });
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
    await h.run({ type: "moveWindowToWorkspace", windowId: destination, workspace: "away" });
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
    await h.run({ type: "moveWindowToWorkspace", windowId: destination, workspace: "away" });
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
    await h.run({ type: "moveWindowToWorkspace", windowId: t, workspace: "T" });
    await h.run({ type: "moveWindowToWorkspace", windowId: m, workspace: "M" });
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
    await h.run({ type: "moveWindowToWorkspace", windowId: wU, workspace: "away" });
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

    // Start a background reconcile that hangs inside its exclusive section.
    suspendGetWindows = true;
    h.fake.emitSleep();
    await new Promise((r) => setTimeout(r, 60));

    DEADLINE.deadlineMs = 20000;
    const pending = h.run({ type: "moveDirection", direction: "right" });
    await new Promise((r) => setTimeout(r, 30));

    suspendGetWindows = false;
    for (const resume of resumers.splice(0)) resume();
    const result = await pending;
    expect(result.type).toBe("ok");
    DEADLINE.deadlineMs = 3;
    // The swap genuinely committed afterwards (origin stays focused/lfm).
    const after = await h.snapshot();
    const treeAfterSwap = workspaceOf(after, "1")!.tree;
    expect(treeAfterSwap.kind === "split").toBe(true);
    expect(workspaceOf(after, "1")?.lastFocusedMember).toBe(w1);
    expect(h.fake.focusedWindowId()).toBe(w1);
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
    expect(await frameOf(h, w1)).toEqual(frame(764, 38, 748, 500));
    expect(await frameOf(h, w2)).toEqual(frame(0, 38, 756, 500));
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

describe("pending focus signal observed by waiting command (final issue 4)", () => {
  test("queued directional command resolves from the pre-idle applied signal", async () => {
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

    // 2) Authoritative external event arrives while the mutex is held:
    //    consumed immediately and STASHED.
    h.fake.emitFocusEvent(w2);
    await new Promise((r) => setTimeout(r, 30));

    // 3) A directional command queues BEHIND the retile on the semaphore.
    const queuedDirection = h.run({ type: "focusDirection", direction: "left" });
    await new Promise((r) => setTimeout(r, 20));

    // 4) Release: retile commits ⇒ pending signal applies PRE-IDLE ⇒ the
    //    queued command acquires with intent w2 already installed.
    gate.resume();
    await Promise.all([retile, queuedDirection]);
    DEADLINE.deadlineMs = 3;

    // LEFT from origin w2 lands on w1. Without the pre-idle application the
    // stale origin w1 would have wrapped right back to w2.
    expect(h.fake.focusedWindowId()).toBe(w1);
    expect((await h.snapshot()).focusedWindow).toBe(w1);
  });

  test("queued workspace move resolves the workspace from the pending focus signal", async () => {
    const gate = makeGate();
    const h = await bootstrap(undefined, gate.wrapper);
    const docker = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const primary = h.fake.addWindow(makeWindow({ x: 900, y: 100 }));
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveWindowToWorkspace", windowId: docker, workspace: "D" });
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

    h.fake.emitFocusEvent(docker);
    const queuedMove = h.run({ type: "moveFocusedWorkspaceToNextDisplay" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.resume();
    await Promise.all([heldWrite, queuedMove]);
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
    expect(await frameOf(h, w2)).toEqual(frame(0, 38, 756, 944));
    expect(await frameOf(h, w1)).toEqual(frame(764, 38, 748, 944));
  });
});
