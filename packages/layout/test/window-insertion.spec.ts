import { Deferred, Effect, Fiber, Stream } from "effect";
import { describe, expect, onTestFinished, test } from "vitest";
import type { Command, CommandResult, StateSnapshot } from "../src/commands.ts";
import { createEngine } from "../src/engine.ts";
import type { Clock, ConfigSource, PlatformAdapter } from "../src/platform.ts";
import type { Frame, PlatformEvent } from "../src/schema.ts";
import type { BspNode } from "../src/world.ts";
import { createFakePlatform, makeDisplay, makeWindow } from "./helpers/fake-platform.ts";

const CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (millis) => Effect.sleep(`${Math.min(millis, 2)} millis`),
};

const CONFIG_SOURCE: ConfigSource = {
  load: () => Effect.succeed({ defaults: {}, workspaces: [] }),
  changes: () => Stream.empty,
};

const leaf = (windowId: string): BspNode => ({ kind: "leaf", windowId });
const split = (axis: "vertical" | "horizontal", first: BspNode, second: BspNode): BspNode => ({
  kind: "split",
  axis,
  ratio: 0.5,
  first,
  second,
});

async function harness(initialWindows: readonly Parameters<typeof makeWindow>[0][] = []) {
  const display = makeDisplay({
    frame: { x: 0, y: 0, width: 2000, height: 800 },
    workArea: { x: 0, y: 0, width: 2000, height: 800 },
  });
  const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
  for (const window of initialWindows) fake.addWindow(makeWindow(window));
  const adapter: PlatformAdapter = { ...fake.adapter, events: Stream.empty };
  const engine = await Effect.runPromise(
    createEngine({ adapter, configSource: CONFIG_SOURCE, clock: CLOCK }),
  );
  onTestFinished(() => Effect.runPromise(Effect.asVoid(engine.stop())));
  await Effect.runPromise(engine.start());
  return {
    display,
    fake,
    engine,
    reconcile: () => Effect.runPromise(engine.reconcile()),
    run: (command: Command): Promise<CommandResult> => Effect.runPromise(engine.execute(command)),
    state: (): Promise<StateSnapshot> => Effect.runPromise(engine.state()),
  };
}

function workspace(snapshot: StateSnapshot) {
  const found = snapshot.workspaces.find((candidate) => candidate.name === "1");
  if (found === undefined) throw new Error("workspace 1 was not created");
  return found;
}

const overlaps = (a: Frame, b: Frame): boolean =>
  Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
  Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);

async function nestedHarness() {
  const h = await harness([{ id: "A" }]);
  h.fake.addWindow(makeWindow({ id: "B" }));
  await h.reconcile();
  await h.run({ type: "focusWindow", windowId: "B" });
  h.fake.addWindow(makeWindow({ id: "C" }));
  await h.reconcile();
  await h.run({ type: "focusWindow", windowId: "C" });
  h.fake.addWindow(makeWindow({ id: "D" }));
  await h.reconcile();
  expect(workspace(await h.state()).tree).toEqual(
    split(
      "vertical",
      leaf("A"),
      split("vertical", leaf("B"), split("horizontal", leaf("C"), leaf("D"))),
    ),
  );
  return h;
}

describe("focused window insertion (fake engine)", () => {
  test("external focus splits only the focused nested tile and preserves unrelated frames", async () => {
    const h = await nestedHarness();
    h.fake.focusWindowExternal("A");
    await h.reconcile();
    const unchanged = new Map(["B", "C", "D"].map((id) => [id, h.fake.frameOf(id)]));

    h.fake.addWindow(makeWindow({ id: "E" }));
    await h.reconcile();

    expect(workspace(await h.state()).tree).toEqual(
      split(
        "vertical",
        split("vertical", leaf("A"), leaf("E")),
        split("vertical", leaf("B"), split("horizontal", leaf("C"), leaf("D"))),
      ),
    );
    expect(Object.fromEntries(["B", "C", "D"].map((id) => [id, h.fake.frameOf(id)]))).toEqual(
      Object.fromEntries(unchanged),
    );
    const a = h.fake.frameOf("A")!;
    const e = h.fake.frameOf("E")!;
    expect(a.x + a.width).toBeLessThanOrEqual(e.x);
  });

  test("direct focus controls insertion and failed direct focus leaves the prior target", async () => {
    const h = await nestedHarness();
    await h.run({ type: "focusWindow", windowId: "B" });
    h.fake.swapBackingElement("C");
    await expect(h.run({ type: "focusWindow", windowId: "C" })).rejects.toBeDefined();

    h.fake.addWindow(makeWindow({ id: "E" }));
    await h.reconcile();

    expect(workspace(await h.state()).tree).toEqual(
      split(
        "vertical",
        leaf("A"),
        split(
          "vertical",
          split("horizontal", leaf("B"), leaf("E")),
          split("horizontal", leaf("C"), leaf("D")),
        ),
      ),
    );
  });

  test("a newly observed focused window preserves the old target, then becomes the next target", async () => {
    const h = await nestedHarness();
    await h.run({ type: "focusWindow", windowId: "A" });
    h.fake.addWindow(makeWindow({ id: "E" }));
    h.fake.focusWindowExternal("E");
    await h.reconcile();
    h.fake.addWindow(makeWindow({ id: "F" }));
    await h.reconcile();

    expect(workspace(await h.state()).tree).toEqual(
      split(
        "vertical",
        split("vertical", leaf("A"), split("horizontal", leaf("E"), leaf("F"))),
        split("vertical", leaf("B"), split("horizontal", leaf("C"), leaf("D"))),
      ),
    );
  });

  test("focus events queued during inventory override stale tiled focus before insertion", async () => {
    const inventoryEntered = await Effect.runPromise(Deferred.make<void>());
    const releaseInventory = await Effect.runPromise(Deferred.make<void>());
    const eFocusConsumed = await Effect.runPromise(Deferred.make<void>());
    const display = makeDisplay({
      frame: { x: 0, y: 0, width: 2000, height: 800 },
      workArea: { x: 0, y: 0, width: 2000, height: 800 },
    });
    const fake = createFakePlatform({ clock: CLOCK, displays: [display] });
    fake.addWindow(makeWindow({ id: "A" }));
    fake.addWindow(makeWindow({ id: "B" }));
    let blockInventory = false;
    const events = fake.adapter.events.pipe(
      Stream.tap((event: PlatformEvent) =>
        event.kind === "focus_changed" && event.windowId === "E"
          ? Deferred.succeed(eFocusConsumed, undefined)
          : Effect.void,
      ),
    );
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      events,
      getWindows: () =>
        blockInventory
          ? Effect.zipRight(
              Deferred.succeed(inventoryEntered, undefined),
              Effect.zipRight(Deferred.await(releaseInventory), fake.adapter.getWindows()),
            )
          : fake.adapter.getWindows(),
    };
    const engine = await Effect.runPromise(
      createEngine({ adapter, configSource: CONFIG_SOURCE, clock: CLOCK }),
    );
    onTestFinished(() => Effect.runPromise(Effect.asVoid(engine.stop())));
    await Effect.runPromise(engine.start());
    await Effect.runPromise(engine.execute({ type: "focusWindow", windowId: "B" }));
    blockInventory = true;
    const reconciliation = Effect.runFork(engine.reconcile());
    await Effect.runPromise(Deferred.await(inventoryEntered));

    fake.focusWindowExternal("A");
    fake.addWindow(makeWindow({ id: "E" }));
    fake.focusWindowExternal("E");
    await Effect.runPromise(Deferred.await(eFocusConsumed));
    await Effect.runPromise(Deferred.succeed(releaseInventory, undefined));
    await Effect.runPromise(Fiber.join(reconciliation));

    expect(workspace(await Effect.runPromise(engine.state())).tree).toEqual(
      split("vertical", split("vertical", leaf("A"), leaf("E")), leaf("B")),
    );
  });

  test("later discovery resizes an earlier preflight window to its final non-overlapping tile", async () => {
    const h = await harness([{ id: "A" }, { id: "B" }]);
    await h.run({ type: "focusWindow", windowId: "B" });
    const writesBefore = h.fake.writes().length;
    h.fake.addWindow(makeWindow({ id: "E", x: 1512, y: 0, width: 488, height: 400 }));
    h.fake.focusWindowExternal("E");
    h.fake.addWindow(makeWindow({ id: "F" }));
    await h.reconcile();

    const eWrites = h.fake
      .writes()
      .slice(writesBefore)
      .filter((write) => write.windowId === "E");
    expect(eWrites.some((write) => write.requested.height === 800)).toBe(true);
    expect(eWrites.at(-1)?.requested.height).toBe(400);
    expect(h.fake.frameOf("E")).toEqual({ x: 1512, y: 0, width: 488, height: 400 });
    const finalFrames = ["A", "B", "E", "F"].map((id) => h.fake.frameOf(id));
    expect(finalFrames).not.toContain(null);
    for (let index = 0; index < finalFrames.length; index += 1) {
      for (let peer = index + 1; peer < finalFrames.length; peer += 1) {
        expect(overlaps(finalFrames[index]!, finalFrames[peer]!)).toBe(false);
      }
    }
  });

  test.each([
    ["floating", makeWindow({ id: "X" }), true],
    ["dialog", makeWindow({ id: "X", subrole: "AXDialog" }), false],
    ["unmanaged", makeWindow({ id: "X", role: "AXUnknown" }), false],
  ] as const)("%s focus preserves the previous tiled insertion target", async (_, spec, float) => {
    const h = await harness([{ id: "A" }, spec]);
    if (float) await h.run({ type: "floatWindow", windowId: "X" });
    await h.run({ type: "focusWindow", windowId: "A" });
    h.fake.focusWindowExternal("X");
    await h.reconcile();
    h.fake.addWindow(makeWindow({ id: "E" }));
    await h.reconcile();

    const tree = workspace(await h.state()).tree;
    expect(tree).toEqual(split("vertical", leaf("A"), leaf("E")));
  });

  test("commits the feasible long-divider axis chosen by the preflight frame", async () => {
    const h = await harness([{ id: "A", constraints: { minWidth: 1100, minHeight: 200 } }]);
    const writesBefore = h.fake.writes().length;
    h.fake.addWindow(makeWindow({ id: "E", constraints: { minWidth: 1100, minHeight: 200 } }));
    await h.reconcile();

    const tree = workspace(await h.state()).tree;
    const firstEWrite = h.fake
      .writes()
      .slice(writesBefore)
      .find((write) => write.windowId === "E");
    expect(tree).toEqual(split("horizontal", leaf("A"), leaf("E")));
    expect(firstEWrite?.requested).toEqual(h.fake.frameOf("E"));
    expect(firstEWrite?.requested.width).toBe(h.display.workArea.width);
  });

  test("multiple startup discoveries use matching preflight frames and converge", async () => {
    const h = await harness([{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }]);
    const snapshot = await h.state();
    const members = workspace(snapshot).members;

    expect(members).toEqual(expect.arrayContaining(["A", "B", "C", "D"]));
    for (const id of members) {
      const writes = h.fake.writes().filter((write) => write.windowId === id);
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.at(-1)?.requested).toEqual(h.fake.frameOf(id));
    }
    const frames = members.map((id) => h.fake.frameOf(id));
    expect(frames).not.toContain(null);
    for (let index = 0; index < frames.length; index += 1) {
      for (let peer = index + 1; peer < frames.length; peer += 1) {
        expect(overlaps(frames[index]!, frames[peer]!)).toBe(false);
      }
    }
    const writesBeforeSecondReconcile = h.fake.writes().length;
    await h.reconcile();
    expect(h.fake.writes()).toHaveLength(writesBeforeSecondReconcile);
  });
});
