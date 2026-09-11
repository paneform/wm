import { Deferred, Effect, Fiber, Stream } from "effect";
import { describe, expect, test } from "vitest";
import type { Config } from "../src/config.ts";
import { createEngine } from "../src/engine.ts";
import type { Clock, ConfigSource, PlatformAdapter } from "../src/platform.ts";
import { PlatformError } from "../src/schema.ts";
import { createFakePlatform, makeDisplay, makeWindow } from "./helpers/fake-platform.ts";

const CLOCK: Clock = { now: () => Date.now(), sleep: () => Effect.void };
const DISPLAY = makeDisplay({
  frame: { x: 0, y: 0, width: 1000, height: 800 },
  workArea: { x: 0, y: 0, width: 1000, height: 800 },
});

const source = (config: Config = {}): ConfigSource => ({
  load: () => Effect.succeed(config),
  changes: () => Stream.empty,
});

const start = async (config: Config = {}) => {
  const fake = createFakePlatform({ clock: CLOCK, displays: [DISPLAY] });
  const startupConfig: Config = { ...config, defaults: { gap: 0, ...config.defaults } };
  const engine = await Effect.runPromise(
    createEngine({ adapter: fake.adapter, configSource: source(startupConfig), clock: CLOCK }),
  );
  return { fake, engine, run: () => Effect.runPromise(engine.start()) };
};

const addNestedScene = (fake: ReturnType<typeof createFakePlatform>) => {
  const a = fake.addWindow(makeWindow({ id: "window:a", x: 0, y: 0, width: 400, height: 800 }));
  const b = fake.addWindow(makeWindow({ id: "window:b", x: 400, y: 0, width: 600, height: 560 }));
  const c = fake.addWindow(makeWindow({ id: "window:c", x: 400, y: 560, width: 600, height: 240 }));
  return { a, b, c };
};

describe("ordinary startup layout preservation", () => {
  test("unresolved startup compensation stays degraded across later observation cycles", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [DISPLAY] });
    const first = fake.addWindow(
      makeWindow({ id: "window:first", x: 0, y: 0, width: 500, height: 800 }),
    );
    const second = fake.addWindow(
      makeWindow({ id: "window:second", x: 500, y: 0, width: 500, height: 800 }),
    );
    let rejectSecond = true;
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      setWindowFrame: (id, frame, expected) => {
        if (id === first && frame.width === 500)
          return Effect.fail(
            new PlatformError({ code: "rejected", detail: "restoration refused" }),
          );
        return Effect.flatMap(fake.adapter.setWindowFrame(id, frame, expected), (result) => {
          if (id !== second || !rejectSecond) return Effect.succeed(result);
          rejectSecond = false;
          return Effect.fail(new PlatformError({ code: "rejected", detail: "partial mutation" }));
        });
      },
    };
    const engine = await Effect.runPromise(
      createEngine({ adapter, configSource: source({ defaults: { gap: 16 } }), clock: CLOCK }),
    );
    const healthStates: unknown[] = [];
    const collector = Effect.runFork(
      engine.events().pipe(
        Stream.filter((event) => event.topic === "health"),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            healthStates.push(event.payload.state);
          }),
        ),
      ),
    );
    await Effect.runPromise(Effect.yieldNow());
    await Effect.runPromise(engine.start());
    expect(fake.frameOf(first)?.width).toBe(492);
    await Effect.runPromise(engine.execute({ type: "pause" }));
    await Effect.runPromise(engine.reconcile());
    expect((await Effect.runPromise(engine.state())).health).toBe("degraded");
    expect(healthStates).not.toContain("healthy");
    await Effect.runPromise(Fiber.interrupt(collector));
    await Effect.runPromise(engine.stop());
  });

  test("preserves an exact 40/60 by 70/30 scene without writes", async () => {
    const h = await start();
    const ids = addNestedScene(h.fake);
    await h.run();

    expect(h.fake.writes()).toEqual([]);
    const workspace = (await Effect.runPromise(h.engine.state())).workspaces.find(
      ({ name }) => name === "1",
    );
    expect(workspace?.members).toEqual([ids.a, ids.b, ids.c]);
    expect(workspace?.tree).toMatchObject({
      kind: "split",
      axis: "vertical",
      ratio: 0.4,
      second: { kind: "split", axis: "horizontal", ratio: 0.7 },
    });
  });

  test("moves only borders affected by gap and padding", async () => {
    const h = await start({
      defaults: { gap: 16, margins: { top: 20, right: 20, bottom: 20, left: 20 } },
    });
    const ids = addNestedScene(h.fake);
    await h.run();

    expect(
      h.fake
        .writes()
        .map(({ windowId }) => windowId)
        .sort(),
    ).toEqual([ids.a, ids.b, ids.c].sort());
    expect(h.fake.frameOf(ids.a)).toEqual({ x: 20, y: 20, width: 372, height: 760 });
    expect(h.fake.frameOf(ids.b)).toEqual({ x: 408, y: 20, width: 572, height: 532 });
    expect(h.fake.frameOf(ids.c)).toEqual({ x: 408, y: 568, width: 572, height: 212 });
  });

  test("fills unused outer space while retaining divider centers", async () => {
    const h = await start();
    const left = h.fake.addWindow(
      makeWindow({ id: "window:left", x: 100, y: 100, width: 300, height: 600 }),
    );
    const right = h.fake.addWindow(
      makeWindow({ id: "window:right", x: 400, y: 100, width: 500, height: 600 }),
    );
    await h.run();

    expect(h.fake.frameOf(left)).toEqual({ x: 0, y: 0, width: 400, height: 800 });
    expect(h.fake.frameOf(right)).toEqual({ x: 400, y: 0, width: 600, height: 800 });
  });

  test("applies affinity before inferring independent groups", async () => {
    const h = await start({
      workspaces: [
        { name: "code", assign: [{ bundleId: "test.code" }] },
        { name: "chat", assign: [{ bundleId: "test.chat" }] },
      ],
    });
    const codeA = h.fake.addWindow(
      makeWindow({ id: "code:a", bundleId: "test.code", x: 0, width: 400, height: 800 }),
    );
    const codeB = h.fake.addWindow(
      makeWindow({ id: "code:b", bundleId: "test.code", x: 400, width: 600, height: 800 }),
    );
    const chatA = h.fake.addWindow(
      makeWindow({ id: "chat:a", bundleId: "test.chat", x: 0, width: 700, height: 800 }),
    );
    const chatB = h.fake.addWindow(
      makeWindow({ id: "chat:b", bundleId: "test.chat", x: 700, width: 300, height: 800 }),
    );
    await h.run();

    const workspaces = (await Effect.runPromise(h.engine.state())).workspaces;
    expect(workspaces.find(({ name }) => name === "code")?.members).toEqual([codeA, codeB]);
    expect(workspaces.find(({ name }) => name === "chat")?.members).toEqual([chatA, chatB]);
  });

  test("does not re-infer an established tree for later additions", async () => {
    const h = await start();
    addNestedScene(h.fake);
    await h.run();
    const before = (await Effect.runPromise(h.engine.state())).workspaces[0]?.tree;
    h.fake.addWindow(makeWindow({ id: "window:later", x: 10, y: 10, width: 200, height: 200 }));
    await Effect.runPromise(h.engine.reconcile());
    const after = (await Effect.runPromise(h.engine.state())).workspaces[0]?.tree;

    expect(after).toMatchObject({
      kind: "split",
      axis: "vertical",
      ratio: 0.4,
      second: before?.kind === "split" ? before.second : undefined,
    });
  });

  test("rolls back a failed group and leaves it uncommitted", async () => {
    const h = await start({ defaults: { gap: 16 } });
    const firstFrame = { x: 0, y: 0, width: 500, height: 800 };
    const first = h.fake.addWindow(makeWindow({ id: "window:first", ...firstFrame }));
    const fixed = h.fake.addWindow(
      makeWindow({
        id: "window:fixed",
        x: 500,
        y: 0,
        width: 500,
        height: 800,
        personality: { kind: "fixedSize" },
      }),
    );
    await h.run();

    expect(h.fake.frameOf(first)).toEqual(firstFrame);
    expect(h.fake.frameOf(fixed)).toEqual({ x: 500, y: 0, width: 500, height: 800 });
    const workspace = (await Effect.runPromise(h.engine.state())).workspaces.find(
      ({ name }) => name === "1",
    );
    expect(workspace?.members).not.toContain(first);
    expect(workspace?.members).not.toContain(fixed);
  });

  test("restores the failing member when a rejected write partially mutates it", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [DISPLAY] });
    const firstFrame = { x: 0, y: 0, width: 500, height: 800 };
    const secondFrame = { x: 500, y: 0, width: 500, height: 800 };
    const first = fake.addWindow(makeWindow({ id: "window:first", ...firstFrame }));
    const second = fake.addWindow(makeWindow({ id: "window:second", ...secondFrame }));
    let rejectSecond = true;
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      setWindowFrame: (id, frame, expected) =>
        Effect.flatMap(fake.adapter.setWindowFrame(id, frame, expected), (result) => {
          if (id !== second || !rejectSecond) return Effect.succeed(result);
          rejectSecond = false;
          return Effect.fail(
            new PlatformError({ code: "rejected", detail: "mutated then rejected" }),
          );
        }),
    };
    const engine = await Effect.runPromise(
      createEngine({
        adapter,
        configSource: source({ defaults: { gap: 16 } }),
        clock: CLOCK,
      }),
    );
    await Effect.runPromise(engine.start());

    expect(fake.frameOf(first)).toEqual(firstFrame);
    expect(fake.frameOf(second)).toEqual(secondFrame);
    expect((await Effect.runPromise(engine.state())).workspaces[0]?.members).toEqual([]);
  });

  test("rejects a replaced zero-write member during whole-group verification", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [DISPLAY] });
    const first = fake.addWindow(
      makeWindow({ id: "window:first", bundleId: "test.main", x: 0, width: 500, height: 800 }),
    );
    const second = fake.addWindow(
      makeWindow({ id: "window:second", bundleId: "test.main", x: 500, width: 400, height: 800 }),
    );
    let replaced = false;
    let firstReads = 0;
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      setWindowFrame: (id, frame, expected) => {
        if (id === second) replaced = true;
        return fake.adapter.setWindowFrame(id, frame, expected);
      },
      getWindow: (id) =>
        Effect.map(fake.adapter.getWindow(id), (observation) => {
          if (id !== first || observation === null) return observation;
          firstReads += 1;
          return replaced
            ? { ...observation, pid: observation.pid + 999, bundleId: "test.other" }
            : observation;
        }),
    };
    const engine = await Effect.runPromise(
      createEngine({ adapter, configSource: source({ defaults: { gap: 0 } }), clock: CLOCK }),
    );
    await Effect.runPromise(engine.start());

    expect(firstReads).toBeGreaterThan(0);
    expect((await Effect.runPromise(engine.state())).workspaces[0]?.members).toEqual([]);
  });

  test("does not admit a group while a startup write is still progressing", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [DISPLAY] });
    fake.addWindow(makeWindow({ id: "window:first", x: 0, width: 500, height: 800 }));
    fake.addWindow(
      makeWindow({
        id: "window:animated",
        x: 500,
        width: 500,
        height: 800,
        personality: { kind: "slowAnimated" },
      }),
    );
    const engine = await Effect.runPromise(
      createEngine({
        adapter: fake.adapter,
        configSource: source({ defaults: { gap: 16 } }),
        clock: CLOCK,
      }),
    );
    await Effect.runPromise(engine.start());

    expect((await Effect.runPromise(engine.state())).workspaces[0]?.members).toEqual([]);
  });

  test("stop interrupts blocked startup admission and waits for compensation", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [DISPLAY] });
    const first = fake.addWindow(
      makeWindow({ id: "window:first", x: 0, y: 0, width: 500, height: 800 }),
    );
    const second = fake.addWindow(
      makeWindow({ id: "window:second", x: 500, y: 0, width: 500, height: 800 }),
    );
    const entered = await Effect.runPromise(Deferred.make<void>());
    const blocked = await Effect.runPromise(Deferred.make<void>());
    let calls = 0;
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      setWindowFrame: (id, frame, expected) => {
        calls += 1;
        if (calls !== 1) return fake.adapter.setWindowFrame(id, frame, expected);
        return Effect.zipRight(
          Deferred.succeed(entered, undefined),
          Effect.zipRight(
            Deferred.await(blocked),
            fake.adapter.setWindowFrame(id, frame, expected),
          ),
        );
      },
    };
    const engine = await Effect.runPromise(
      createEngine({
        adapter,
        configSource: source({ defaults: { gap: 16 } }),
        clock: CLOCK,
      }),
    );
    Effect.runFork(engine.start());
    await Effect.runPromise(Deferred.await(entered));
    await Effect.runPromise(engine.stop());

    const writesAfterStop = fake.writes().length;
    await Effect.runPromise(Deferred.succeed(blocked, undefined));
    await Effect.runPromise(Effect.yieldNow());
    expect(fake.writes()).toHaveLength(writesAfterStop);
    expect(fake.frameOf(first)).toEqual({ x: 0, y: 0, width: 500, height: 800 });
    expect(fake.frameOf(second)).toEqual({ x: 500, y: 0, width: 500, height: 800 });
    expect((await Effect.runPromise(engine.state())).workspaces[0]?.members).toEqual([]);
  });
});
