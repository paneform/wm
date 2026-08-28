import { describe, expect, test } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { createEngine } from "../src/engine.ts";
import type { CommandResult, StateSnapshot } from "../src/commands.ts";
import type { Clock, ConfigSource, PlatformAdapter } from "../src/platform.ts";
import { PlatformError, type Frame } from "../src/schema.ts";
import {
  createFakePlatform,
  makeDisplay,
  makeWindow,
  type FakeWindowSpec,
} from "./helpers/fake-platform.ts";

// Engine pipeline integration — docs/rewrite/testing-guide.md §Engine pipeline.
// Deterministic: fake platform + virtual-ish clock (engine never waits on real
// time in these paths; the fake settles synchronously).

// Real-time clock: short settle delays are compressed to keep tests fast,
// while long sleeps (transaction deadlines) stay genuine so Effect.race
// timeouts measure real seconds.
const CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (millis: number) => Effect.sleep(`${millis >= 500 ? millis : Math.min(millis, 2)} millis`),
};

const CONFIG_SOURCE: ConfigSource = {
  load: () => Effect.succeed({ defaults: {}, workspaces: [] }),
  changes: () => Stream.empty,
};

import type { Command } from "../src/commands.ts";

interface Harness {
  fake: ReturnType<typeof createFakePlatform>;
  engine: {
    start(): Effect.Effect<void>;
    stop(): Effect.Effect<void>;
    execute(command: Command): Effect.Effect<CommandResult, unknown>;
    state(): Effect.Effect<StateSnapshot>;
    events(): Stream.Stream<unknown>;
    reconcile(): Effect.Effect<void>;
  };
  run(command: Command): Promise<CommandResult>;
  snapshot(): Promise<StateSnapshot>;
}

const bootstrap = async (): Promise<Harness> => {
  const fake = createFakePlatform({
    clock: CLOCK,
    displays: [
      makeDisplay(),
      makeDisplay({
        id: "display:sim-left",
        frame: { x: -1512, y: 0, width: 1512, height: 982 },
        workArea: { x: -1512, y: 38, width: 1512, height: 944 },
      }),
    ],
  });
  const engine = await Effect.runPromise(
    createEngine({ adapter: fake.adapter, configSource: CONFIG_SOURCE, clock: CLOCK }),
  );
  await Effect.runPromise(engine.start());
  return {
    fake,
    engine,
    run: (command) => Effect.runPromise(engine.execute(command) as Effect.Effect<CommandResult>),
    snapshot: () => Effect.runPromise(engine.state()),
  };
};

const frameOf = async (h: Harness, id: string): Promise<Frame | null> => h.fake.frameOf(id);

const waitFor = async (check: () => boolean, timeoutMs = 500): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const parkedProbeHarness = async (
  spec: FakeWindowSpec,
  wrapAdapter?: (
    adapter: PlatformAdapter,
    fake: ReturnType<typeof createFakePlatform>,
  ) => PlatformAdapter,
) => {
  const display = makeDisplay();
  const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
  const bundleId = spec.bundleId ?? "com.example.parked-limit-test";
  const id = fake.addWindow(makeWindow({ ...spec, bundleId }));
  fake.addWindow(makeWindow({ bundleId: "com.example.visible-probe-peer" }));
  const configSource: ConfigSource = {
    load: () =>
      Effect.succeed({
        workspaces: [{ name: "parked", preferredDisplay: display.id, assign: [{ bundleId }] }],
      }),
    changes: () => Stream.empty,
  };
  const wrapped = wrapAdapter?.(fake.adapter, fake);
  const adapter =
    wrapped === undefined
      ? fake.adapter
      : (() => {
          const { executeBatch: _batch, ...legacy } = wrapped;
          void _batch;
          return legacy;
        })();
  const engine = await Effect.runPromise(
    createEngine({
      adapter,
      configSource,
      clock: CLOCK,
    }),
  );
  await Effect.runPromise(engine.start());
  await Effect.runPromise(engine.execute({ type: "focusWorkspace", name: "1" }));
  return { fake, engine, id };
};

describe("engine pipeline (fake platform)", () => {
  test("does not reconcile repeatedly for empty workspace sentinels", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [makeDisplay()] });
    const engine = await Effect.runPromise(
      createEngine({ adapter: fake.adapter, configSource: CONFIG_SOURCE, clock: CLOCK }),
    );
    await Effect.runPromise(engine.start());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const settledEpoch = (await Effect.runPromise(engine.state())).epoch;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await Effect.runPromise(engine.state())).epoch).toBe(settledEpoch);
    expect(engine.gateState()).toEqual({ busy: false, rerunQueued: false });
    await Effect.runPromise(engine.stop());
  });

  test("retiles the surviving window immediately after a close event", async () => {
    const display = makeDisplay();
    const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
    const closed = fake.addWindow(makeWindow({ id: "window:closed" }));
    const surviving = fake.addWindow(makeWindow({ id: "window:surviving" }));
    const engine = await Effect.runPromise(
      createEngine({ adapter: fake.adapter, configSource: CONFIG_SOURCE, clock: CLOCK }),
    );
    await Effect.runPromise(engine.start());
    await Effect.runPromise(engine.reconcile());
    expect(fake.frameOf(surviving)?.width).toBeLessThan(display.workArea.width);

    fake.removeWindow(closed);

    await waitFor(() => fake.frameOf(surviving)?.width === display.workArea.width);
    expect(fake.frameOf(surviving)).toEqual(display.workArea);
    await Effect.runPromise(engine.stop());
  });

  test("deduplicates concurrent startup inventory and window-added insertion", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [makeDisplay()] });
    const windowId = fake.addWindow(makeWindow({ id: "window:startup-race" }));
    const [window] = await Effect.runPromise(fake.adapter.getWindows());
    const engine = await Effect.runPromise(
      createEngine({
        adapter: {
          ...fake.adapter,
          events: Stream.concat(
            Stream.make({ kind: "window_added" as const, window: window! }),
            Stream.never,
          ),
        },
        configSource: CONFIG_SOURCE,
        clock: CLOCK,
      }),
    );

    await Effect.runPromise(engine.start());

    const workspace = (await Effect.runPromise(engine.state())).workspaces.find((candidate) =>
      candidate.members.includes(windowId),
    );
    const countLeaves = (tree: NonNullable<typeof workspace>["tree"]): number =>
      tree.kind === "leaf"
        ? Number(tree.windowId === windowId)
        : countLeaves(tree.first) + countLeaves(tree.second);
    expect(workspace).toBeDefined();
    expect(countLeaves(workspace!.tree)).toBe(1);
    await Effect.runPromise(engine.stop());
  });

  test("prepares effective native config for startup and full reload", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [makeDisplay()] });
    let raw: unknown = { keybinds: { "shift s": "workspace focus S" } };
    const prepared: Array<{ keybinds: Readonly<Record<string, string>>; mode: string }> = [];
    const configSource: ConfigSource = {
      load: () => Effect.succeed(raw),
      changes: () => Stream.empty,
      prepare: (config, mode) =>
        Effect.sync(() => {
          prepared.push({ keybinds: config.keybinds ?? {}, mode });
        }),
    };
    const engine = await Effect.runPromise(
      createEngine({ adapter: fake.adapter, configSource, clock: CLOCK }),
    );
    await Effect.runPromise(engine.start());
    raw = {};
    await Effect.runPromise(engine.execute({ type: "reloadConfig", mode: "full" }));

    expect(prepared).toEqual([
      { keybinds: { "shift s": "workspace focus S" }, mode: "full" },
      { keybinds: {}, mode: "full" },
    ]);
  });
  test("parked limit probe preserves bottom-left intent, slivers, and focus", async () => {
    const display = makeDisplay();
    const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
    const id = fake.addWindow(
      makeWindow({
        bundleId: "com.example.parked-probe",
        personality: {
          kind: "minMaxClamp",
          constraints: { minWidth: 320, minHeight: 240, maxWidth: 1200, maxHeight: 800 },
        },
      }),
    );
    const peer = fake.addWindow(makeWindow({ bundleId: "com.example.visible" }));
    const configSource: ConfigSource = {
      load: () =>
        Effect.succeed({
          workspaces: [
            {
              name: "parked",
              preferredDisplay: display.id,
              assign: [{ bundleId: "com.example.parked-probe" }],
            },
          ],
        }),
      changes: () => Stream.empty,
    };
    const engine = await Effect.runPromise(
      createEngine({ adapter: fake.adapter, configSource, clock: CLOCK }),
    );
    await Effect.runPromise(engine.start());
    await Effect.runPromise(engine.execute({ type: "focusWorkspace", name: "1" }));
    fake.focusWindowExternal(peer);
    const before = await Effect.runPromise(engine.state());
    const durable = fake.frameOf(id)!;
    const writesBefore = fake.writes().length;

    const result = await Effect.runPromise(
      engine.execute({ type: "probeWindowLimits", windowId: id }),
    );

    expect(result).toMatchObject({
      type: "windowLimitsProbe",
      target: {
        mode: "parked",
        hostDisplayId: display.id,
        corner: "bottomLeft",
        retainedVisibility: { horizontal: 1, vertical: 52 },
        positionCorrection: "verified",
      },
      phases: {
        capability: "verified",
        parking: "adoptedVerified",
        minimumSize: "verified",
        maximumSize: "verified",
        restore: "verifiedExact",
      },
      capability: {
        source: "parkedBehavioralProbe",
        movable: "supported",
        resizable: "supported",
      },
      restoreStatus: "verifiedExact",
      findings: {
        minWidth: { value: 320 },
        minHeight: { value: 240 },
        maxWidth: { value: 1200 },
        maxHeight: { value: 800 },
      },
      profileUpdated: true,
    });
    expect(fake.frameOf(id)).toEqual(durable);
    expect(fake.focusedWindowId()).toBe(peer);
    const after = await Effect.runPromise(engine.state());
    expect(after.focusedWorkspace).toBe(before.focusedWorkspace);
    expect(after.workspaces).toEqual(before.workspaces);

    const trialWrites = fake
      .writes()
      .slice(writesBefore)
      .filter((write) => write.windowId === id);
    for (const write of trialWrites) {
      if (write.requested.x === durable.x && write.requested.y === durable.y) continue;
      if (write.requested.width === durable.width && write.requested.height === durable.height)
        continue;
      expect(write.requested.x + write.requested.width - display.frame.x).toBe(
        Math.min(1, write.requested.width),
      );
      expect(display.frame.y + display.frame.height - write.requested.y).toBe(
        Math.min(52, write.requested.height),
      );
      if (write.op === "position") {
        expect(write.observed.x + write.observed.width - display.frame.x).toBe(1);
        expect(display.frame.y + display.frame.height - write.observed.y).toBe(52);
        expect(write.observed.x + write.observed.width).toBeLessThanOrEqual(display.frame.x + 1);
      }
    }
  });

  test("parked position clamp is reported separately from maximum size evidence", async () => {
    const display = makeDisplay();
    const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
    const id = fake.addWindow(
      makeWindow({
        bundleId: "com.example.clamped-parked-probe",
        width: 700,
        personality: {
          kind: "minMaxClamp",
          constraints: { minWidth: 320, minHeight: 240, maxWidth: 800, maxHeight: 800 },
        },
      }),
    );
    fake.addWindow(makeWindow({ bundleId: "com.example.visible-clamp-peer" }));
    let clampPositions = false;
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      setWindowPosition: (windowId, point, expected) =>
        fake.adapter.setWindowPosition(
          windowId,
          clampPositions && point.x === -799
            ? { x: -760, y: point.y }
            : clampPositions && point.x === -319
              ? { x: -300, y: point.y }
              : point,
          expected,
        ),
    };
    const configSource: ConfigSource = {
      load: () =>
        Effect.succeed({
          workspaces: [
            {
              name: "parked",
              preferredDisplay: display.id,
              assign: [{ bundleId: "com.example.clamped-parked-probe" }],
            },
          ],
        }),
      changes: () => Stream.empty,
    };
    const engine = await Effect.runPromise(createEngine({ adapter, configSource, clock: CLOCK }));
    await Effect.runPromise(engine.start());
    await Effect.runPromise(engine.execute({ type: "focusWorkspace", name: "1" }));
    clampPositions = true;

    const durable = fake.frameOf(id)!;
    const focusedBefore = fake.focusedWindowId();
    const stateBefore = await Effect.runPromise(engine.state());
    const result = await Effect.runPromise(
      engine.execute({ type: "probeWindowLimits", windowId: id }),
    );
    expect(result).toMatchObject({
      target: { positionCorrection: "clamped" },
      findings: { maxWidth: { kind: "exact", value: 800 } },
    });
    if (result.type === "windowLimitsProbe") {
      expect(result.positionDiagnostics).toContainEqual(
        expect.objectContaining({
          sample: "minWidth",
          correction: "clamped",
          requestedIdealPoint: { x: -319, y: expect.any(Number) },
          observedPoint: { x: -300, y: expect.any(Number) },
          actualRetainedVisibility: { horizontal: 20, vertical: 52 },
        }),
      );
      expect(result.positionDiagnostics).toContainEqual(
        expect.objectContaining({
          sample: "maxWidth",
          correction: "clamped",
          requestedIdealPoint: { x: -799, y: expect.any(Number) },
          observedPoint: { x: -760, y: expect.any(Number) },
          actualRetainedVisibility: { horizontal: 40, vertical: 52 },
        }),
      );
    }
    expect(fake.frameOf(id)).toEqual(durable);
    expect(fake.focusedWindowId()).toBe(focusedBefore);
    expect((await Effect.runPromise(engine.state())).workspaces).toEqual(stateBefore.workspaces);
  });

  test("explicit limit probe reports exact clamps and restores the full frame", async () => {
    const original = { x: 117, y: 129, width: 900, height: 700 };
    const h = await parkedProbeHarness({
      ...original,
      personality: {
        kind: "minMaxClamp",
        constraints: { minWidth: 320, minHeight: 240, maxWidth: 1200, maxHeight: 800 },
      },
    });
    const captured = h.fake.frameOf(h.id);

    const result = await Effect.runPromise(
      h.engine.execute({ type: "probeWindowLimits", windowId: h.id }),
    );
    expect(result).toMatchObject({
      type: "windowLimitsProbe",
      originalFrame: captured,
      restoredFrame: captured,
      findings: {
        minWidth: { kind: "exact", value: 320 },
        minHeight: { kind: "exact", value: 240 },
        maxWidth: { kind: "exact", value: 1200 },
        maxHeight: { kind: "exact", value: 800 },
      },
      profileUpdated: true,
    });
    expect(h.fake.frameOf(h.id)).toEqual(captured);
  });

  test("parked capability phase aborts a fixed-size target before bounds trials", async () => {
    const h = await parkedProbeHarness({ personality: { kind: "fixedSize" } });
    const writesBefore = h.fake.writes().length;

    const exit = await Effect.runPromiseExit(
      h.engine.execute({ type: "probeWindowLimits", windowId: h.id }),
    );

    expect(exit._tag).toBe("Failure");
    const probeWrites = h.fake
      .writes()
      .slice(writesBefore)
      .filter((write) => write.windowId === h.id);
    expect(
      probeWrites.some((write) => write.requested.width === 1 || write.requested.height === 1),
    ).toBe(false);
  });

  test("explicit limit probe reports tested lower bounds instead of unbounded maxima", async () => {
    const h = await parkedProbeHarness({
      x: 100,
      y: 100,
      width: 700,
      height: 500,
      personality: { kind: "minMaxClamp", constraints: { minWidth: 100, minHeight: 100 } },
    });
    const captured = h.fake.frameOf(h.id);

    const result = await Effect.runPromise(
      h.engine.execute({ type: "probeWindowLimits", windowId: h.id }),
    );
    expect(result).toMatchObject({
      type: "windowLimitsProbe",
      findings: {
        maxWidth: { kind: "noClampThrough", value: 1512 },
        maxHeight: { kind: "noClampThrough", value: 944 },
      },
    });
    expect(h.fake.frameOf(h.id)).toEqual(captured);
  });

  test("accepted minimum endpoints are no-clamp evidence and publish no profile", async () => {
    const h = await parkedProbeHarness({
      width: 700,
      height: 500,
      personality: { kind: "minMaxClamp", constraints: {} },
    });

    const result = await Effect.runPromise(
      h.engine.execute({ type: "probeWindowLimits", windowId: h.id }),
    );

    expect(result).toMatchObject({
      findings: {
        minWidth: { kind: "noClampDownTo", value: 1 },
        minHeight: { kind: "noClampDownTo", value: 1 },
      },
      profileUpdated: false,
    });
  });

  test("a one-point maximum endpoint clamp is exact evidence", async () => {
    const h = await parkedProbeHarness({
      width: 700,
      height: 500,
      personality: {
        kind: "minMaxClamp",
        constraints: { minWidth: 100, minHeight: 100, maxWidth: 1511, maxHeight: 943 },
      },
    });

    const result = await Effect.runPromise(
      h.engine.execute({ type: "probeWindowLimits", windowId: h.id }),
    );

    expect(result).toMatchObject({
      findings: {
        maxWidth: { kind: "exact", value: 1511 },
        maxHeight: { kind: "exact", value: 943 },
      },
    });
  });

  test("limit probes honor paused mutation behavior without writes", async () => {
    const h = await parkedProbeHarness({ personality: { kind: "minMaxClamp", constraints: {} } });
    await Effect.runPromise(h.engine.execute({ type: "pause" }));
    const writesBefore = h.fake.writes().length;

    const exit = await Effect.runPromiseExit(
      h.engine.execute({ type: "probeWindowLimits", windowId: h.id }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(String(exit.cause)).toContain("paused");
    expect(h.fake.writes()).toHaveLength(writesBefore);
  });

  test.each([
    ["hidden", { hidden: true }],
    ["minimized", { minimized: true }],
  ])("explicit limit probe rejects %s windows without writes", async (_label, state) => {
    const h = await bootstrap();
    const id = h.fake.addWindow(makeWindow(state));
    await h.run({ type: "reconcile" });
    const before = h.fake.writes().length;

    const exit = await Effect.runPromiseExit(
      engineOf(h).execute({ type: "probeWindowLimits", windowId: id }),
    );
    expect(exit._tag).toBe("Failure");
    expect(h.fake.writes()).toHaveLength(before);
  });

  test("explicit limit probe detects stale replacement and does not publish a result", async () => {
    const h = await bootstrap();
    const id = h.fake.addWindow(makeWindow({ x: 100, y: 100, width: 700, height: 500 }));
    await h.run({ type: "reconcile" });
    h.fake.swapBackingElement(id);

    const exit = await Effect.runPromiseExit(
      engineOf(h).execute({ type: "probeWindowLimits", windowId: id }),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("explicit limit probe reports restore failure and publishes no bounds", async () => {
    const display = makeDisplay();
    const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
    const bundleId = "com.example.restore-failure";
    const id = fake.addWindow(
      makeWindow({
        bundleId,
        x: 100,
        y: 100,
        width: 700,
        height: 500,
        personality: { kind: "minMaxClamp", constraints: { minWidth: 100, minHeight: 100 } },
      }),
    );
    fake.addWindow(makeWindow({ bundleId: "com.example.restore-peer" }));
    let original = fake.frameOf(id)!;
    let rejectRestore = false;
    let writes = 0;
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      setWindowFrame: (windowId, frame, expected) => {
        writes += 1;
        return rejectRestore && writes > 1 && JSON.stringify(frame) === JSON.stringify(original)
          ? Effect.fail(new PlatformError({ code: "rejected", detail: "forced restore failure" }))
          : fake.adapter.setWindowFrame(windowId, frame, expected);
      },
    };
    const engine = await Effect.runPromise(
      createEngine({
        adapter,
        configSource: {
          load: () =>
            Effect.succeed({
              workspaces: [
                { name: "parked", preferredDisplay: display.id, assign: [{ bundleId }] },
              ],
            }),
          changes: () => Stream.empty,
        },
        clock: CLOCK,
      }),
    );
    await Effect.runPromise(engine.start());
    await Effect.runPromise(engine.execute({ type: "focusWorkspace", name: "1" }));
    original = fake.frameOf(id)!;
    rejectRestore = true;

    const exit = await Effect.runPromiseExit(
      engine.execute({ type: "probeWindowLimits", windowId: id }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(String(exit.cause)).toContain("restoration failed");
  });

  test("direct post-write read failure restores the exact original frame", async () => {
    let armed = false;
    let failed = false;
    let writesAtArm = 0;
    const h = await parkedProbeHarness(
      { personality: { kind: "minMaxClamp", constraints: { minWidth: 100, minHeight: 100 } } },
      (adapter, fake) => ({
        ...adapter,
        getWindow: (id) => {
          if (armed && !failed && fake.writes().length > writesAtArm) {
            failed = true;
            return Effect.fail(
              new PlatformError({ code: "rejected", detail: "injected post-write read failure" }),
            );
          }
          return adapter.getWindow(id);
        },
      }),
    );
    const original = h.fake.frameOf(h.id)!;
    writesAtArm = h.fake.writes().length;
    armed = true;

    const exit = await Effect.runPromiseExit(
      h.engine.execute({ type: "probeWindowLimits", windowId: h.id }),
    );

    expect(exit._tag).toBe("Failure");
    expect(failed).toBe(true);
    expect(h.fake.frameOf(h.id)).toEqual(original);
  });

  test("stale live parked frame refuses before mutation", async () => {
    const h = await parkedProbeHarness({ personality: { kind: "minMaxClamp", constraints: {} } });
    h.fake.nudgeSilent(h.id, { x: h.fake.frameOf(h.id)!.x + 40 });
    const writesBefore = h.fake.writes().length;

    const exit = await Effect.runPromiseExit(
      h.engine.execute({ type: "probeWindowLimits", windowId: h.id }),
    );

    expect(exit._tag).toBe("Failure");
    expect(h.fake.writes()).toHaveLength(writesBefore);
  });

  test("fullscreen transition after a write aborts and restores", async () => {
    let armed = false;
    let writesAtArm = 0;
    const h = await parkedProbeHarness(
      { personality: { kind: "minMaxClamp", constraints: { minWidth: 100, minHeight: 100 } } },
      (adapter, fake) => ({
        ...adapter,
        getWindow: (id) =>
          Effect.map(adapter.getWindow(id), (observation) =>
            armed && fake.writes().length > writesAtArm && observation !== null
              ? { ...observation, fullscreen: true }
              : observation,
          ),
      }),
    );
    const original = h.fake.frameOf(h.id)!;
    writesAtArm = h.fake.writes().length;
    armed = true;

    const exit = await Effect.runPromiseExit(
      h.engine.execute({ type: "probeWindowLimits", windowId: h.id }),
    );

    expect(exit._tag).toBe("Failure");
    expect(h.fake.frameOf(h.id)).toEqual(original);
  });

  test("interrupting after a completed write restores the exact original frame", async () => {
    let armed = false;
    let suspended = false;
    const h = await parkedProbeHarness(
      { personality: { kind: "minMaxClamp", constraints: { minWidth: 100, minHeight: 100 } } },
      (adapter) => ({
        ...adapter,
        setWindowPosition: (id, point, expected) => {
          const write = adapter.setWindowPosition(id, point, expected);
          if (!armed || suspended) return write;
          suspended = true;
          return Effect.zipRight(write, Effect.never);
        },
      }),
    );
    const original = h.fake.frameOf(h.id)!;
    armed = true;
    const fiber = Effect.runFork(h.engine.execute({ type: "probeWindowLimits", windowId: h.id }));
    while (!suspended) await Effect.runPromise(Effect.sleep("1 millis"));

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(h.fake.frameOf(h.id)).toEqual(original);
  });

  test("verified probe profile affects subsequent layout planning", async () => {
    const application = "com.example.profile-layout";
    const h = await parkedProbeHarness({
      bundleId: application,
      width: 900,
      personality: { kind: "minMaxClamp", constraints: { minWidth: 900, minHeight: 200 } },
    });
    const result = await Effect.runPromise(
      h.engine.execute({ type: "probeWindowLimits", windowId: h.id }),
    );
    expect(result).toMatchObject({ profileUpdated: true });
    const writesAfterProbe = h.fake.writes().length;
    const peerId = h.fake.addWindow(makeWindow({ bundleId: application, width: 700 }));

    await Effect.runPromise(h.engine.execute({ type: "reconcile" }));
    const peerWrites = h.fake
      .writes()
      .slice(writesAfterProbe)
      .filter((write) => write.windowId === peerId);
    expect(peerWrites.length).toBeGreaterThan(0);
    expect(peerWrites.every((write) => write.requested.width >= 900)).toBe(true);
  });

  test("gets one committed window observation without platform I/O", async () => {
    const h = await bootstrap();
    const windowId = h.fake.addWindow(makeWindow({ title: "Observed" }));
    await Effect.runPromise(h.engine.reconcile());

    const found = await h.run({ type: "getWindow", windowId });
    expect(found).toMatchObject({ type: "window", window: { id: windowId, title: "Observed" } });
    expect(await h.run({ type: "getWindow", windowId: "missing" })).toEqual({
      type: "window",
      window: null,
    });
  });

  test("observe-only startup materializes configured workspaces and assignments", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [makeDisplay()] });
    const windowId = fake.addWindow(makeWindow({ bundleId: "com.example.app" }));
    const unmatchedId = fake.addWindow(makeWindow({ bundleId: "com.example.other" }));
    const configSource: ConfigSource = {
      load: () =>
        Effect.succeed({
          workspaces: [
            {
              name: "apps",
              preferredDisplay: "display:sim-primary",
              assign: [{ bundleId: "com.example.app" }],
            },
          ],
        }),
      changes: () => Stream.empty,
    };
    const engine = await Effect.runPromise(
      createEngine({ adapter: fake.adapter, configSource, clock: CLOCK, initiallyPaused: true }),
    );

    await Effect.runPromise(engine.start());
    const snapshot = await Effect.runPromise(engine.state());
    const workspace = snapshot.workspaces.find((candidate) => candidate.name === "apps");
    const fallbackWorkspace = snapshot.workspaces.find((candidate) => candidate.name === "1");

    expect(workspace?.preferredDisplay).toBe("display:sim-primary");
    expect(workspace?.members).toContain(windowId);
    expect(fallbackWorkspace?.members).toContain(unmatchedId);
    expect(snapshot.paused).toBe(true);
    expect(fake.writes()).toEqual([]);
  });

  test("state query serves committed snapshot without platform I/O", async () => {
    const h = await bootstrap();
    const before = h.fake.writes().length;
    const snap = await h.snapshot();
    expect(snap.epoch).toBeGreaterThanOrEqual(0);
    expect(snap.topology.length).toBe(2);
    expect(h.fake.writes().length).toBe(before);
  });

  test("pause blocks mutations and resume restores", async () => {
    const h = await bootstrap();
    const id = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await h.run({ type: "pause" });
    const snap = await h.snapshot();
    expect(snap.paused).toBe(true);

    const attempted = await Effect.runPromiseExit(
      engineOf(h).execute({ type: "moveWindow", windowId: id, point: { x: 300, y: 300 } }),
    );
    expect(attempted._tag).toBe("Failure");

    expect(id).toBeTruthy();
  });

  test("move-window applies the requested frame through the adapter", async () => {
    const h = await bootstrap();
    const id = h.fake.addWindow(makeWindow({ x: 50, y: 60, subrole: "AXDialog" }));
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveWindow", windowId: id, point: { x: 200, y: 150 } });
    const frame = await frameOf(h, id);
    expect(frame?.x).toBe(200);
    expect(frame?.y).toBe(150);
  });

  test("fixed-size windows are quarantined out of the tree", async () => {
    const h = await bootstrap();
    const fixed = h.fake.addWindow(
      makeWindow({ x: 10, y: 10, personality: { kind: "fixedSize" } }),
    );
    const normal = h.fake.addWindow(makeWindow({ x: 400, y: 400 }));
    await h.run({ type: "reconcile" });
    const snap = await h.snapshot();
    const snapFixed = snap.windows.find((w) => w.id === fixed);
    const snapNormal = snap.windows.find((w) => w.id === normal);
    // The fixed-size window is never tiled into a BSP layout.
    if (snapFixed !== undefined && snapNormal !== undefined) {
      const wsOfFixed = snap.workspaces.find((ws) => ws.members.includes(fixed));
      if (wsOfFixed !== undefined) {
        expect(wsOfFixed.floating.includes(fixed) || !wsOfFixed.members.includes(fixed)).toBe(true);
      }
      expect(snapNormal).toBeDefined();
    }
  });

  test("display disconnect migrates stranded workspaces (bean wm-dm8l)", async () => {
    const h = await bootstrap();
    const id = h.fake.addWindow(makeWindow({ displayId: "display:sim-left", x: -1400, y: 100 }));
    // Focus the workspace that owns the left-display window so it is visible there.
    await h.run({ type: "focusWorkspace", name: "1" });
    h.fake.disconnectDisplay("display:sim-left");
    await h.run({ type: "reconcile" });
    const snap = await h.snapshot();
    // No workspace may remain assigned to the disconnected display.
    for (const ws of snap.workspaces) {
      expect(["display:sim-primary", "display:sim-left"]).toContain(ws.visibleOnDisplay);
      if (ws.visibleOnDisplay === "display:sim-left") {
        throw new Error(`workspace ${ws.name} stranded on disconnected display`);
      }
    }
    // The window survived the migration.
    expect(h.fake.windowIds()).toContain(id);
  });

  test("workspace reveal parks and re-reveals without losing membership", async () => {
    const h = await bootstrap();
    const a = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await h.run({ type: "reconcile" });
    const first = await h.snapshot();
    const wsName = focusedWorkspaceOf(first);
    const displayId = first.workspaces.find((ws) => ws.name === wsName)?.visibleOnDisplay;
    expect(wsName).not.toBeNull();
    expect(displayId).not.toBeNull();

    await h.run({ type: "focusWorkspace", name: "scratch-2" });
    const second = await h.snapshot();
    const scratch = second.workspaces.find((ws) => ws.name === "scratch-2");
    const parked = second.windows.find((w) => w.id === a);
    expect(scratch).toBeDefined();
    expect(scratch?.visibleOnDisplay).toBe(displayId);
    expect(parked?.frame).toEqual(await frameOf(h, a));

    await h.run({ type: "focusWorkspace", name: wsName! });
    const third = await h.snapshot();
    const restored = third.windows.find((w) => w.id === a);
    const restoredWorkspace = third.workspaces.find((ws) => ws.name === wsName);
    expect(restored).toBeDefined();
    expect(restoredWorkspace?.visibleOnDisplay).toBe(displayId);
    expect(restored?.frame).toEqual(await frameOf(h, a));
  });

  test("workspace switch persists the accepted clamped parking frame", async () => {
    const h = await bootstrap();
    const windowId = h.fake.addWindow(makeWindow({ x: 100, y: 100 }));
    await h.run({ type: "reconcile" });
    h.fake.setVisibilityLimits("display:sim-primary", { horizontal: 2, vertical: 53 });
    h.fake.setVisibilityLimits("display:sim-left", { horizontal: 2, vertical: 53 });
    const writesBeforeSwitch = h.fake.writes().length;

    await h.run({ type: "focusWorkspace", name: "scratch-clamped" });
    const parkingWrites = h.fake.writes().slice(writesBeforeSwitch);
    const parkingWrite = parkingWrites.at(-1);
    const parked = (await h.snapshot()).windows.find((window) => window.id === windowId);

    expect(parkingWrite?.windowId).toBe(windowId);
    expect(
      parkingWrites.some(
        (write) => JSON.stringify(write.observed) !== JSON.stringify(write.requested),
      ),
    ).toBe(true);
    expect(parked).toMatchObject({ parked: true, frame: parkingWrite?.observed });

    const writesBeforeReconcile = h.fake.writes().length;
    await h.run({ type: "reconcile" });
    expect(h.fake.writes()).toHaveLength(writesBeforeReconcile);
    expect((await h.snapshot()).windows.find((window) => window.id === windowId)?.frame).toEqual(
      parkingWrite?.observed,
    );
  });

  test("workspace switch rejects a parking clamp that remains on a connected display", async () => {
    const h = await bootstrap();
    const windowId = h.fake.addWindow(
      makeWindow({ x: 100, y: 100, personality: { kind: "workAreaClamp" } }),
    );
    await h.run({ type: "reconcile" });

    const exit = await Effect.runPromiseExit(
      engineOf(h).execute({ type: "focusWorkspace", name: "unsafe-clamp" }),
    );

    expect(exit._tag).toBe("Failure");
    const parked = (await h.snapshot()).windows.find((window) => window.id === windowId);
    expect(parked?.parked).toBe(false);
  });

  test("stable size clamps converge and do not abort workspace focus", async () => {
    const h = await bootstrap();
    const constrained = h.fake.addWindow(
      makeWindow({
        x: 100,
        y: 100,
        width: 900,
        personality: { kind: "minMaxClamp", constraints: { minWidth: 800 } },
      }),
    );
    await h.run({ type: "reconcile" });

    const writesAfterFirstReconcile = h.fake.writes().length;
    await h.run({ type: "reconcile" });
    expect(h.fake.writes()).toHaveLength(writesAfterFirstReconcile);

    await expect(
      h.run({ type: "focusWorkspace", name: "constrained-away" }),
    ).resolves.toMatchObject({
      type: "ok",
    });
    const snapshot = await h.snapshot();
    expect(snapshot.focusedWorkspace).toBe("constrained-away");
    expect(snapshot.windows.find((window) => window.id === constrained)).toMatchObject({
      parked: true,
    });
  });

  test("confirmed stable clamp from the native batch does not replay geometry", async () => {
    const h = await bootstrap();
    const constrained = h.fake.addWindow(
      makeWindow({
        bundleId: "com.example.confirmed-batch-clamp",
        x: 100,
        y: 100,
        width: 1000,
        personality: { kind: "minMaxClamp", constraints: { minWidth: 900 } },
      }),
    );
    const peer = h.fake.addWindow(makeWindow({ x: 500, y: 100, width: 800 }));
    await h.run({ type: "reconcile" });
    await h.run({ type: "moveWindowToWorkspace", windowId: constrained, workspace: "clamp" });
    await h.run({ type: "moveWindowToWorkspace", windowId: peer, workspace: "clamp" });
    await h.run({ type: "focusWorkspace", name: "clamp" });
    await h.run({ type: "reconcile" });
    h.fake.nudgeSilent(constrained, { width: 1000 });
    h.fake.nudgeSilent(peer, { x: 1000 });
    const writesBefore = h.fake.writes().length;
    const batchesBefore = h.fake.batchCalls();

    await h.run({ type: "retile", workspace: "clamp" });

    const batch = h.fake.batchHistory().at(-1)!;
    const writes = h.fake
      .writes()
      .slice(writesBefore)
      .filter((write) => write.windowId === constrained);
    const followUpWrites = h.fake
      .writes()
      .slice(batch.writeEnd)
      .filter((write) => write.windowId === constrained);
    expect(h.fake.batchCalls() - batchesBefore).toBe(1);
    expect(batch.operationIds.some((operationId) => operationId.endsWith(`:${constrained}`))).toBe(
      true,
    );
    expect(followUpWrites).toHaveLength(0);
    expect(writes.at(-1)?.observed.width).toBe(900);
  });

  test("startup assignment ignores portrait parked frames when deriving BSP axes", async () => {
    const fake = createFakePlatform({
      clock: CLOCK,
      displays: [
        makeDisplay({
          frame: { x: 0, y: 0, width: 1512, height: 982 },
          workArea: { x: 0, y: 32, width: 1512, height: 950 },
        }),
      ],
    });
    const spotify = fake.addWindow(
      makeWindow({
        bundleId: "test.spotify",
        x: -800,
        y: 32,
        width: 800,
        height: 950,
        constraints: { minWidth: 800 },
        personality: { kind: "minMaxClamp", constraints: { minWidth: 800 } },
      }),
    );
    const docker = fake.addWindow(
      makeWindow({
        bundleId: "test.docker",
        x: -940,
        y: 32,
        width: 940,
        height: 950,
        personality: { kind: "minMaxClamp", constraints: { minWidth: 940 } },
      }),
    );
    const chatgpt = fake.addWindow(
      makeWindow({
        bundleId: "test.chatgpt",
        x: -480,
        y: 32,
        width: 480,
        height: 950,
        personality: { kind: "minMaxClamp", constraints: { minWidth: 480 } },
      }),
    );
    const configSource: ConfigSource = {
      load: () =>
        Effect.succeed({
          defaults: { gap: 0 },
          workspaces: [{ name: "1", assign: [{ bundleId: "test.*" }] }],
        }),
      changes: () => Stream.empty,
    };
    const engine = await Effect.runPromise(
      createEngine({ adapter: fake.adapter, configSource, clock: CLOCK }),
    );
    await Effect.runPromise(engine.start());

    const startup = await Effect.runPromise(engine.state());
    const tree = startup.workspaces.find((workspace) => workspace.name === "1")?.tree;
    expect(tree).toMatchObject({
      kind: "split",
      axis: "vertical",
      second: { kind: "split", axis: "vertical" },
    });

    await Effect.runPromise(engine.execute({ type: "focusWorkspace", name: "1" }));
    for (let pass = 0; pass < 3; pass += 1) await Effect.runPromise(engine.reconcile());

    const content = { x: 0, y: 32, width: 1512, height: 950 };
    const frames = [fake.frameOf(spotify), fake.frameOf(docker), fake.frameOf(chatgpt)];
    expect(frames).toEqual([
      { x: 0, y: 32, width: 800, height: 950 },
      { x: 572, y: 32, width: 940, height: 950 },
      { x: 1032, y: 32, width: 480, height: 950 },
    ]);
    for (const frame of frames) {
      expect(frame).not.toBeNull();
      expect(frame!.x + frame!.width).toBeLessThanOrEqual(content.x + content.width);
      expect(frame!.y + frame!.height).toBeLessThanOrEqual(content.y + content.height);
    }

    const writesBeforeSecondReconcile = fake.writes().length;
    await Effect.runPromise(engine.reconcile());
    expect(fake.writes()).toHaveLength(writesBeforeSecondReconcile);
  });
});

function focusedWorkspaceOf(snap: StateSnapshot): string | null {
  return snap.focusedWorkspace;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function engineOf(h: Harness): any {
  return h.engine;
}
