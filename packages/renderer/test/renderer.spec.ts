import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import {
  createEngine,
  type Clock,
  type Command,
  type ConfigSource,
  type DomainEvent,
  type StateSnapshot,
} from "@wm/engine";
import {
  clampFrameIntoWorkArea,
  clampSizeToConstraints,
  createWebPlatformSim,
  offscreenSliverTarget,
  stepTowardFrame,
  type WebPlatformSim,
} from "../src/sim/web-platform.ts";
import {
  buildScene,
  fitViewport,
  panBy,
  screenToWorld,
  splitLinesForTree,
  worldRectToScreen,
  worldToScreen,
  zoomAt,
  type SceneExtras,
} from "../src/ui/canvas.ts";
import {
  SCENARIOS,
  ScenarioRunner,
  replayEntries,
  scenarioById,
  type ScenarioContext,
  type ScenarioExecuteOutcome,
} from "../src/ui/scenarios.ts";

// Headless sanity suite — docs/rewrite/web-renderer.md §Implementation notes:
// sim platform determinism, scenario replay stability, DOM-free canvas math.

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  defaults: { gap: 8 },
  workspaces: [
    { name: "1", mode: "bsp" as const },
    { name: "2", mode: "bsp" as const },
  ],
};

const inlineConfigSource: ConfigSource = {
  load: () => Effect.succeed(TEST_CONFIG),
  changes: () => Stream.never,
};

/** Deterministic clock: monotonic counter, sleeps advance the counter only. */
const virtualClock = (): Clock => {
  let now = 1_000_000;
  return {
    now: () => now,
    sleep: (millis: number) =>
      Effect.sync(() => {
        now += millis;
      }),
  };
};

interface EventTraceEntry {
  seq: number;
  topic: string;
}

interface Harness {
  sim: WebPlatformSim;
  engine: Awaited<ReturnType<typeof makeEngine>>;
  events: EventTraceEntry[];
  execute(command: Command): Promise<void>;
  snapshot(): Promise<StateSnapshot>;
  stop(): Promise<void>;
}

async function makeEngine(sim: WebPlatformSim) {
  return Effect.runPromise(
    createEngine({ adapter: sim.adapter, configSource: inlineConfigSource, clock: virtualClock() }),
  );
}

async function makeHarness(seed: number): Promise<Harness> {
  const sim = createWebPlatformSim({ seed });
  const engine = await makeEngine(sim);

  const events: EventTraceEntry[] = [];
  Stream.runForEach(engine.events(), (event: DomainEvent) =>
    Effect.sync(() => {
      events.push({ seq: event.seq, topic: event.topic });
    }),
  ).pipe(Effect.runFork);

  await Effect.runPromise(engine.start());

  return {
    sim,
    engine,
    events,
    execute: async (command: Command) => {
      await Effect.runPromise(Effect.either(engine.execute(command)));
    },
    snapshot: () => Effect.runPromise(engine.state()),
    stop: async () => {
      await Effect.runPromise(engine.stop()).catch(() => {});
    },
  };
}

/** Scenario context mirroring main.ts wiring (never throws). */
function scenarioContext(harness: Harness): ScenarioContext {
  return {
    sim: harness.sim,
    execute: async (command: Command): Promise<ScenarioExecuteOutcome> => {
      const result = await Effect.runPromise(Effect.either(harness.engine.execute(command)));
      return result._tag === "Right"
        ? { ok: true, detail: "ok" }
        : { ok: false, detail: result.left.code };
    },
  };
}

const snapshotJson = async (harness: Harness): Promise<string> =>
  JSON.stringify(await harness.snapshot());

const eventTopicsJson = (harness: Harness): string =>
  JSON.stringify(harness.events.map((e) => [e.seq, e.topic]));

// ---------------------------------------------------------------------------
// 1. Sim platform determinism (same seed ⇒ same outcomes)
// ---------------------------------------------------------------------------

describe("web platform sim determinism", () => {
  const scriptedOps = async (sim: WebPlatformSim) => {
    const adapter = sim.adapter;
    const clamper = sim.addWindow({
      title: "Clamper",
      width: 900,
      height: 500,
      personality: { kind: "minMaxClamp", constraints: { minWidth: 800 } },
    });
    const normal = sim.addWindow({ title: "Normal", width: 600, height: 400 });
    const fixed = sim.addWindow({
      title: "Fixed",
      width: 640,
      height: 480,
      personality: { kind: "fixedSize" },
    });

    const results = [];
    results.push(await Effect.runPromise(adapter.setWindowSize(clamper, { width: 500, height: 400 })));
    results.push(await Effect.runPromise(adapter.setWindowFrame(normal, { x: -2600, y: -2200, width: 500, height: 400 })));
    // Fixed-size window refuses size writes at the API level.
    results.push(
      await Effect.runPromise(Effect.either(adapter.setWindowSize(fixed, { width: 200, height: 200 }))),
    );
    results.push(await Effect.runPromise(adapter.setWindowPosition(normal, { x: -5000, y: -4000 })));

    const windows = await Effect.runPromise(adapter.getWindows());
    return { results, windows };
  };

  it("produces identical write observations and inventories for equal seeds", async () => {
    const runA = await scriptedOps(createWebPlatformSim({ seed: 99 }));
    const runB = await scriptedOps(createWebPlatformSim({ seed: 99 }));
    expect(JSON.stringify(runA)).toBe(JSON.stringify(runB));
  });

  it("engine-level: identical seeds yield identical committed snapshots and event traces", async () => {
    const boot = async (): Promise<Harness> => {
      const harness = await makeHarness(7);
      for (const ref of ["A", "B"]) {
        harness.sim.addWindow({ title: ref, width: 640, height: 420 });
      }
      await harness.execute({ type: "retile" });
      await harness.execute({ type: "moveWindowToWorkspace", windowId: harness.sim.windowIds()[0]!, workspace: "2" });
      await harness.execute({ type: "focusWorkspace", name: "2" });
      await harness.execute({ type: "reconcile" });
      return harness;
    };

    const h1 = await boot();
    const h2 = await boot();

    expect(await snapshotJson(h1)).toBe(await snapshotJson(h2));
    expect(eventTopicsJson(h1)).toBe(eventTopicsJson(h2));

    await h1.stop();
    await h2.stop();
  });
});

// ---------------------------------------------------------------------------
// 2. Scripted personalities (testing-guide §Fake platform behaviors)
// ---------------------------------------------------------------------------

describe("sim personalities", () => {
  it("min/max rejection: refuses sizes below minWidth by clamping the observation", async () => {
    const sim = createWebPlatformSim({ seed: 1 });
    const id = sim.addWindow({
      width: 900,
      height: 500,
      personality: { kind: "minMaxClamp", constraints: { minWidth: 800, minHeight: 300 } },
    });
    const outcome = await Effect.runPromise(
      sim.adapter.setWindowSize(id, { width: 500, height: 200 }),
    );
    expect(outcome.observed.width).toBe(800);
    expect(outcome.observed.height).toBe(300);
    expect(outcome.errorKind).toBeUndefined();
  });

  it("work-area clamping pulls workAreaClamp personalities back inside the usable area", () => {
    const workAreas = [{ x: 0, y: 38, width: 1512, height: 944 }];
    const clamped = clampFrameIntoWorkArea(
      { x: 1400, y: 500, width: 400, height: 300 },
      workAreas,
    );
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(workAreas[0]!.x + workAreas[0]!.width);
    expect(clamped.y).toBeGreaterThanOrEqual(workAreas[0]!.y);
  });

  it("offscreen refusal leaves ~1 pt horizontal / ~52 pt vertical visible at the nearest corner", async () => {
    const sim = createWebPlatformSim({ seed: 2 });
    const id = sim.addWindow({ width: 500, height: 400 });
    const outcome = await Effect.runPromise(
      sim.adapter.setWindowPosition(id, { x: -6000, y: -6000 }),
    );
    const observed = outcome.observed;
    const overlaps = sim
      .displays()
      .map((d) => ({
        width:
          Math.min(observed.x + observed.width, d.frame.x + d.frame.width) -
          Math.max(observed.x, d.frame.x),
        height:
          Math.min(observed.y + observed.height, d.frame.y + d.frame.height) -
          Math.max(observed.y, d.frame.y),
      }))
      .filter((o) => o.width > 0 && o.height > 0);
    expect(overlaps.length).toBe(1);
    // Corner sliver: exactly the documented visibility limits remain visible.
    expect(overlaps[0]).toEqual({ width: 1, height: 52 });
  });

  it("offscreenSliverTarget honours per-display configured limits", () => {
    const display = {
      id: "display:x",
      frame: { x: 0, y: 0, width: 1000, height: 800 },
      workArea: { x: 0, y: 38, width: 1000, height: 762 },
      scale: 1,
      primary: true,
    };
    const target = offscreenSliverTarget(
      { x: -5000, y: -5000, width: 300, height: 200 },
      [display],
      () => ({ horizontal: 3, vertical: 40 }),
    );
    expect(target.displayId).toBe("display:x");
    expect(target.frame.x + 300 - display.frame.x).toBe(3);
    expect(target.frame.y + 200 - display.frame.y).toBe(40);
  });

  it("fixed-size windows reject size writes at the API level but honor position", async () => {
    const sim = createWebPlatformSim({ seed: 3 });
    const id = sim.addWindow({
      width: 640,
      height: 480,
      personality: { kind: "fixedSize" },
    });
    // Hard AX-level refusal — the probe counts this toward resizable=fixed.
    const refused = await Effect.runPromise(
      Effect.either(sim.adapter.setWindowSize(id, { width: 100, height: 100 })),
    );
    expect(refused._tag).toBe("Left");
    if (refused._tag === "Left") {
      expect(refused.left.code).toBe("rejected");
    }
    const unchanged = await Effect.runPromise(sim.adapter.getWindow(id));
    expect(unchanged?.frame.width).toBe(640);
    expect(unchanged?.frame.height).toBe(480);
    const moved = await Effect.runPromise(sim.adapter.setWindowPosition(id, { x: 42, y: 60 }));
    expect(moved.observed.x).toBe(42);
    expect(moved.observed.y).toBe(60);
  });

  it("unmovable windows ignore position writes entirely", async () => {
    const sim = createWebPlatformSim({ seed: 4 });
    const id = sim.addWindow({ width: 400, height: 300, personality: { kind: "unmovable" } });
    const moved = await Effect.runPromise(sim.adapter.setWindowPosition(id, { x: 999, y: 999 }));
    expect(moved.observed.x).not.toBe(999);
    expect(moved.stable).toBe(true);
  });

  it("reanchoring apps shift origin on size-only writes (center stays)", async () => {
    const sim = createWebPlatformSim({ seed: 5 });
    const id = sim.addWindow({
      x: 100,
      y: 100,
      width: 400,
      height: 200,
      personality: { kind: "reanchoring", anchor: "center" },
    });
    const resized = await Effect.runPromise(sim.adapter.setWindowSize(id, { width: 200, height: 100 }));
    expect(resized.observed.width).toBe(200);
    expect(resized.observed.height).toBe(100);
    expect(resized.observed.x).toBe(200); // 100 + (400−200)/2
    expect(resized.observed.y).toBe(150); // 100 + (200−100)/2
  });

  it("animated settling advances per settle-read and snaps within a point", async () => {
    const sim = createWebPlatformSim({ seed: 6 });
    const id = sim.addWindow({
      width: 300,
      height: 200,
      personality: { kind: "slowAnimated" },
    });
    await Effect.runPromise(sim.adapter.setWindowPosition(id, { x: 1200, y: 800 }));
    const r1 = await Effect.runPromise(sim.adapter.getWindow(id));
    const r2 = await Effect.runPromise(sim.adapter.getWindow(id));
    expect(r1?.frame.x).toBeDefined();
    expect(Math.abs((r2?.frame.x ?? 0) - 1200)).toBeLessThan(Math.abs((r1?.frame.x ?? 0) - 1200));
    // Pure helper: monotone approach, snap at ≤1 pt.
    const mid = stepTowardFrame({ x: 0, y: 0, width: 10, height: 10 }, { x: 90, y: 90, width: 10, height: 10 }, 0.5);
    expect(mid.x).toBe(45);
    const near = stepTowardFrame({ x: 89.5, y: 0, width: 10, height: 10 }, { x: 90, y: 0, width: 10, height: 10 }, 0.5);
    expect(near.x).toBe(90);
  });

  it("clampSizeToConstraints and identity replacement behave per contract", async () => {
    expect(clampSizeToConstraints({ width: 50, height: 50 }, { minWidth: 100 })).toEqual({
      width: 100,
      height: 50,
    });

    const sim = createWebPlatformSim({ seed: 8 });
    const id = sim.addWindow({ width: 400, height: 300 });
    sim.scheduleIdentityReplacement(id);
    const stale = await Effect.runPromise(
      Effect.either(sim.adapter.setWindowPosition(id, { x: 10, y: 10 })),
    );
    expect(stale._tag).toBe("Left");
    if (stale._tag === "Left") {
      expect(stale.left.code).toBe("stale");
    }
    // Replacement consumed exactly once: pid changed and stays stable after.
    const before = (await Effect.runPromise(sim.adapter.getWindow(id)))!;
    const after = (await Effect.runPromise(sim.adapter.getWindow(id)))!;
    expect(before.pid).toBe(after.pid);
    expect(before.id).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// 3. Canvas pure-math helpers (DOM-free)
// ---------------------------------------------------------------------------

describe("viewport transforms", () => {
  const vp = { x: -100, y: -50, scale: 2 };

  it("worldToScreen / screenToWorld round-trip", () => {
    const screen = worldToScreen(vp, 30, 70);
    expect(screen).toEqual({ x: 260, y: 240 });
    const back = screenToWorld(vp, screen.x, screen.y);
    expect(back).toEqual({ x: 30, y: 70 });
  });

  it("worldRectToScreen scales rect geometry", () => {
    const rect = worldRectToScreen(vp, { x: 0, y: 25, width: 1512, height: 944 });
    expect(rect.x).toBe(200);
    expect(rect.y).toBe(150);
    expect(rect.width).toBe(3024);
    expect(rect.height).toBe(1888);
  });

  it("zoomAt keeps the anchored world point fixed", () => {
    const anchor = { ax: 400, ay: 300 };
    const before = screenToWorld(vp, anchor.ax, anchor.ay);
    const zoomed = zoomAt(vp, 1.6, anchor.ax, anchor.ay);
    const after = screenToWorld(zoomed, anchor.ax, anchor.ay);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomed.scale).toBeCloseTo(vp.scale * 1.6, 6);
  });

  it("panBy shifts the viewport opposite to the drag delta", () => {
    const panned = panBy(vp, 40, -20);
    expect(panned.x).toBe(vp.x - 40 / vp.scale);
    expect(panned.y).toBe(vp.y + 20 / vp.scale);
  });

  it("fitViewport fits bounds into the screen area with padding", () => {
    const fitted = fitViewport({ x: 0, y: 0, width: 1000, height: 500 }, 1100, 700, 50);
    expect(fitted.scale).toBeCloseTo(Math.min(1000 / 1000, 600 / 500), 6);
    // Bounds center maps to screen center.
    const center = screenToWorld(fitted, 550, 350);
    expect(center.x).toBeCloseTo(500, 6);
    expect(center.y).toBeCloseTo(250, 6);
  });
});

describe("scene building", () => {
  const baseSnapshot = (): StateSnapshot => ({
    epoch: 3,
    paused: false,
    health: "healthy",
    focusedWorkspace: "1",
    topology: [
      {
        id: "display:sim-primary",
        frame: { x: 0, y: 0, width: 1512, height: 982 },
        workArea: { x: 0, y: 38, width: 1512, height: 944 },
        scale: 2,
        primary: true,
      },
    ],
    windows: [
      managedWindow("w1", "managed", false, false, "1"),
      managedWindow("w2", "floating", true, false, "1"),
      managedWindow("w3", "parked", false, true, "1"),
      managedWindow("w4", "normal", false, false, null),
    ],
    workspaces: [
      {
        name: "1",
        mode: "bsp",
        members: ["w1"],
        floating: ["w2"],
        tree: {
          kind: "split",
          axis: "vertical",
          ratio: 0.5,
          first: { kind: "leaf", windowId: "w1" },
          second: { kind: "leaf", windowId: "w2" },
        },
        visibleOnDisplay: "display:sim-primary",
        preferredDisplay: null,
        pinnedDisplayOverride: null,
      },
    ],
    pendingTransactions: [],
  });

  function managedWindow(
    id: string,
    classification: string,
    floating: boolean,
    parked: boolean,
    workspace: string | null,
  ): StateSnapshot["windows"][number] {
    return {
      id,
      pid: 100,
      classification,
      managed: workspace !== null,
      workspace,
      floating,
      parked,
      frame: { x: 10, y: 10, width: 100, height: 80 },
      capabilities: {
        movable: "unknown",
        resizable: "unknown",
        movableEvidence: "platform_report",
        resizableEvidence: "platform_report",
      },
    };
  }

  it("maps projection fields onto visual states", () => {
    const scene = buildScene(baseSnapshot());
    const states = Object.fromEntries(scene.windows.map((w) => [w.id, w.state]));
    expect(states).toEqual({
      w1: "managed",
      w2: "floating",
      w3: "parked",
      w4: "quarantined",
    });
  });

  it("emits badges and split lines for visible bsp workspaces", () => {
    const scene = buildScene(baseSnapshot(), { focusedWindowId: "w1" } satisfies SceneExtras);
    expect(scene.badges).toHaveLength(1);
    expect(scene.badges[0]).toMatchObject({ workspace: "1", mode: "bsp", focused: true });
    expect(scene.splitLines).toHaveLength(1);
    const line = scene.splitLines[0]!;
    // floor(1512 · 0.5)=756; divider sits at 756 + gap/2.
    expect(line.x1).toBe(756 + 4);
    expect(line.y1).toBe(38);
    expect(line.y2).toBe(982);
    expect(scene.focusedWindowId).toBe("w1");
  });

  it("splitLinesForTree nests dividers recursively", () => {
    const lines = splitLinesForTree(
      {
        kind: "split",
        axis: "vertical",
        ratio: 0.5,
        first: { kind: "leaf", windowId: "a" },
        second: {
          kind: "split",
          axis: "horizontal",
          ratio: 0.5,
          first: { kind: "leaf", windowId: "b" },
          second: { kind: "leaf", windowId: "c" },
        },
      },
      { x: 0, y: 0, width: 800, height: 600 },
      8,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.x1).toBe(404);
    expect(lines[1]!.y1).toBe(304);
  });
});

// ---------------------------------------------------------------------------
// 4. Scenario system: pure data + deterministic replay
// ---------------------------------------------------------------------------

describe("scenarios", () => {
  it("catalog contains the documented edge cases", () => {
    const ids = SCENARIOS.map((s) => s.id);
    for (const required of [
      "fixed-size-appears",
      "rejects-below-minwidth",
      "disconnect-second-display",
      "drift-offscreen",
      "identity-replacement",
      "topology-churn",
      "animated-settling",
    ]) {
      expect(ids).toContain(required);
      expect(scenarioById(required)?.ops.length).toBeGreaterThan(0);
    }
  });

  it("running a scenario mutates the world identically across identical boots", async () => {
    const run = async (): Promise<{ json: string; topics: string }> => {
      const harness = await makeHarness(21);
      const runner = new ScenarioRunner(scenarioContext(harness));
      const result = await runner.run(scenarioById("rejects-below-minwidth")!);
      expect(result.errors).toEqual([]);
      const json = await snapshotJson(harness);
      const topics = eventTopicsJson(harness);
      await harness.stop();
      return { json, topics };
    };
    expect(await run()).toEqual(await run());
  });

  it("recorded entries replay deterministically on fresh instances", async () => {
    const recorded = [
      { t: 0, kind: "scenario" as const, scenarioId: "topology-churn" },
      { t: 5, kind: "command" as const, command: { type: "retile" } as Command },
      { t: 9, kind: "scenario" as const, scenarioId: "disconnect-second-display" },
      { t: 12, kind: "scenario" as const, scenarioId: "animated-settling" },
    ];

    const replayOnce = async (): Promise<{ json: string; topics: string }> => {
      const harness = await makeHarness(33);
      const results = await replayEntries(recorded, () =>
        new ScenarioRunner(scenarioContext(harness)),
      );
      expect(results.length).toBe(3);
      const json = await snapshotJson(harness);
      const topics = eventTopicsJson(harness);
      await harness.stop();
      return { json, topics };
    };

    expect(await replayOnce()).toEqual(await replayOnce());
  });
});

// ---------------------------------------------------------------------------
// 5. Engine integration: boot world converges (smoke)
// ---------------------------------------------------------------------------

describe("engine boot integration", () => {
  /**
   * Mirrors main.ts bootstrap: seed membership through moveWindowToWorkspace
   * (the assign rule quarantines while a workspace tree is empty), then force
   * reconcile via direct engine.start() passes — see the `revive` note in
   * main.ts for why command receipts alone don't converge the projection.
   */
  it("tiles all normal windows onto the primary work area, disjoint panes", async () => {
    const sim = createWebPlatformSim({ seed: 1337 });
    const seeded = [
      sim.addWindow({ title: "Editor", bundleId: "com.sim.editor", width: 900, height: 600 }),
      sim.addWindow({ title: "Terminal", bundleId: "com.sim.term", width: 700, height: 460 }),
      sim.addWindow({ title: "Palette", bundleId: "com.sim.editor", width: 300, height: 220 }),
    ];
    const engine = await makeEngine(sim);
    await Effect.runPromise(engine.start());
    for (const id of seeded) {
      await Effect.runPromise(
        Effect.either(engine.execute({ type: "moveWindowToWorkspace", windowId: id, workspace: "1" })),
      );
    }
    for (let pass = 0; pass < 2; pass++) {
      await Effect.runPromise(Effect.either(engine.start()));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const snapshot = await Effect.runPromise(engine.state());
    expect(snapshot.health).toBe("healthy");
    expect(snapshot.epoch).toBeGreaterThan(1);
    expect(snapshot.windows).toHaveLength(3);
    for (const w of snapshot.windows) {
      expect(w.managed).toBe(true);
      expect(w.frame.y).toBe(38);
      expect(w.frame.x).toBeGreaterThanOrEqual(0);
      expect(w.frame.x + w.frame.width).toBeLessThanOrEqual(1512);
    }
    const frames = snapshot.windows.map((w) => w.frame).sort((p, q) => p.x - q.x);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!.x).toBeGreaterThanOrEqual(frames[i - 1]!.x + frames[i - 1]!.width);
    }
    await Effect.runPromise(engine.stop()).catch(() => {});
  }, 20000);
});
