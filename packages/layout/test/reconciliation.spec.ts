import { Effect, Fiber, Stream } from "effect";
import { describe, expect, test } from "vitest";
import { createEngine } from "../src/engine.ts";
import type { Clock, ConfigSource, PlatformAdapter } from "../src/platform.ts";
import { PlatformError } from "../src/schema.ts";
import { createFakePlatform, makeDisplay, makeWindow } from "./helpers/fake-platform.ts";

const clock: Clock = { now: () => Date.now(), sleep: () => Effect.void };
const configSource: ConfigSource = {
  load: () => Effect.succeed({ defaults: {}, workspaces: [] }),
  changes: () => Stream.empty,
};

const createTestEngine = (adapter: PlatformAdapter) =>
  Effect.runPromise(createEngine({ adapter, configSource, clock }));

const nextReconciliation = (engine: Awaited<ReturnType<typeof createTestEngine>>) =>
  Effect.runPromise(
    engine.events().pipe(
      Stream.filter((event) => event.topic === "reconciliation"),
      Stream.take(1),
      Stream.runDrain,
    ),
  );

describe("reconciliation convergence", () => {
  test("publishes live parking frames even when inventory remains cached", async () => {
    const parkingClock: Clock = {
      ...clock,
      sleep: (millis) => (millis >= 5000 ? Effect.never : Effect.void),
    };
    const display = makeDisplay();
    const fake = createFakePlatform({ clock: parkingClock, displays: [display] });
    const visible = fake.addWindow(makeWindow({ id: "window:visible", ...display.workArea }));
    const hidden = fake.addWindow(
      makeWindow({ id: "window:hidden", x: 100, y: 100, width: 400, height: 300 }),
    );
    const cached = await Effect.runPromise(fake.adapter.getWindows());
    const engine = await Effect.runPromise(
      createEngine({
        adapter: { ...fake.adapter, getWindows: () => Effect.succeed(cached) },
        configSource,
        clock: parkingClock,
        initialLayout: {
          windows: [
            { windowId: visible, workspace: "1" },
            { windowId: hidden, workspace: "away" },
          ],
          displays: [{ displayId: display.id, workspace: "1" }],
          focusedWorkspace: "1",
        },
      }),
    );
    await Effect.runPromise(engine.start());
    await Effect.runPromise(engine.execute({ type: "reconcile" }));

    const state = await Effect.runPromise(engine.state());
    expect(state.windows.find(({ id }) => id === hidden)?.frame).toEqual(fake.frameOf(hidden));
    expect(fake.frameOf(hidden)).not.toEqual(cached.find(({ id }) => id === hidden)?.frame);
    expect(fake.writes().filter(({ windowId }) => windowId === hidden)).toHaveLength(1);
    expect(state.health).toBe("healthy");
    await Effect.runPromise(engine.stop());
  });

  test("a window-removed event commits the observed survivor layout", async () => {
    const display = makeDisplay();
    const fake = createFakePlatform({ clock, displays: [display] });
    const removed = fake.addWindow(makeWindow({ id: "window:removed" }));
    const survivor = fake.addWindow(makeWindow({ id: "window:survivor" }));
    const engine = await createTestEngine(fake.adapter);
    await Effect.runPromise(engine.start());

    const committed = nextReconciliation(engine);
    fake.removeWindow(removed);
    await committed;

    expect(fake.frameOf(survivor)).toEqual(display.workArea);
    expect((await Effect.runPromise(engine.state())).windows).toEqual([
      expect.objectContaining({ id: survivor, frame: display.workArea }),
    ]);
    await Effect.runPromise(engine.stop());
  });

  test("carries live verified frames across a stale inventory cache", async () => {
    const fake = createFakePlatform({ clock, displays: [makeDisplay()] });
    const id = fake.addWindow(makeWindow({ id: "window:refuses-layout" }));
    let staleFrame = false;
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      getWindows: () =>
        Effect.map(fake.adapter.getWindows(), (windows) =>
          windows.map((window) =>
            staleFrame && window.id === id
              ? { ...window, frame: { x: 20, y: 20, width: 500, height: 400 } }
              : window,
          ),
        ),
    };
    const engine = await createTestEngine(adapter);
    await Effect.runPromise(engine.start());
    staleFrame = true;
    const writesBefore = fake.writes().length;

    await Effect.runPromise(engine.reconcile());

    expect(fake.writes().length - writesBefore).toBe(1);
    expect((await Effect.runPromise(engine.state())).health).toBe("healthy");
    await Effect.runPromise(engine.stop());
  });

  test("fails an explicit reconcile command after bounded physical refusal", async () => {
    const fake = createFakePlatform({ clock, displays: [makeDisplay()] });
    const id = fake.addWindow(makeWindow({ id: "window:refuses-layout" }));
    let refusing = false;
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      setWindowFrame: (windowId, requested) => {
        if (!refusing) return fake.adapter.setWindowFrame(windowId, requested);
        const observed = fake.frameOf(windowId)!;
        return Effect.succeed({
          requested,
          observed,
          stable: true,
          stableReads: 3,
          errorKind: "rejected" as const,
        });
      },
    };
    const engine = await createTestEngine(adapter);
    await Effect.runPromise(engine.start());
    fake.nudgeSilent(id, { x: 20, width: 500 });
    refusing = true;

    const result = await Effect.runPromise(Effect.either(engine.execute({ type: "reconcile" })));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.code).toBe("timeout");

    expect((await Effect.runPromise(engine.state())).health).toBe("degraded");
    await Effect.runPromise(engine.stop());
  });

  test("invalid observation fails the command and does not restore healthy state", async () => {
    const fake = createFakePlatform({ clock, displays: [makeDisplay()] });
    fake.addWindow(makeWindow());
    let invalid = false;
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      getTopology: () =>
        invalid
          ? Effect.fail(new PlatformError({ code: "unavailable", detail: "offline" }))
          : fake.adapter.getTopology(),
    };
    const engine = await createTestEngine(adapter);
    await Effect.runPromise(engine.start());
    await Effect.runPromise(engine.reconcile());
    invalid = true;
    const reconciliations: unknown[] = [];
    const collector = Effect.runFork(
      engine.events().pipe(
        Stream.filter((event) => event.topic === "reconciliation"),
        Stream.runForEach((event) => Effect.sync(() => reconciliations.push(event))),
      ),
    );
    await Effect.runPromise(Effect.yieldNow());

    const result = await Effect.runPromise(Effect.either(engine.execute({ type: "reconcile" })));
    expect(result._tag).toBe("Left");
    expect(reconciliations).toEqual([]);
    expect((await Effect.runPromise(engine.state())).health).toBe("degraded");
    await Effect.runPromise(Fiber.interrupt(collector));
    await Effect.runPromise(engine.stop());
  });
});
