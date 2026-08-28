import { Effect, Stream } from "effect";
import { describe, expect, test } from "vitest";
import type { Command, CommandResult, StateSnapshot } from "../src/commands.ts";
import { createEngine } from "../src/engine.ts";
import type { Clock, ConfigSource } from "../src/platform.ts";
import { createFakePlatform, makeDisplay, makeWindow } from "./helpers/fake-platform.ts";

const CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (millis) => Effect.sleep(`${Math.min(millis, 2)} millis`),
};

const CONFIG_SOURCE: ConfigSource = {
  load: () => Effect.succeed({ defaults: {}, workspaces: [] }),
  changes: () => Stream.empty,
};

const workspaceOf = (snapshot: StateSnapshot, windowId: string): string | undefined =>
  snapshot.workspaces.find((workspace) => workspace.members.includes(windowId))?.name;

describe("unmatched normal-window fallback assignment", () => {
  test("places a genuinely new unmatched window in the focused workspace", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [makeDisplay()] });
    const engine = await Effect.runPromise(
      createEngine({ adapter: fake.adapter, configSource: CONFIG_SOURCE, clock: CLOCK }),
    );
    await Effect.runPromise(engine.start());
    await execute(engine, { type: "focusWorkspace", name: "2" });

    const windowId = fake.addWindow(makeWindow());
    await Effect.runPromise(engine.reconcile());

    expect(workspaceOf(await Effect.runPromise(engine.state()), windowId)).toBe("2");
  });

  test("restores a returning unmatched window instead of following changed focus", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [makeDisplay()] });
    const engine = await Effect.runPromise(
      createEngine({ adapter: fake.adapter, configSource: CONFIG_SOURCE, clock: CLOCK }),
    );
    await Effect.runPromise(engine.start());
    await execute(engine, { type: "focusWorkspace", name: "2" });

    const windowId = fake.addWindow(makeWindow({ id: "window:returning", pid: 4242 }));
    await Effect.runPromise(engine.reconcile());
    expect(workspaceOf(await Effect.runPromise(engine.state()), windowId)).toBe("2");

    await execute(engine, { type: "focusWorkspace", name: "1" });
    fake.removeWindow(windowId);
    await Effect.runPromise(engine.reconcile());
    fake.addWindow(makeWindow({ id: windowId, pid: 4242 }));
    await Effect.runPromise(engine.reconcile());

    expect(workspaceOf(await Effect.runPromise(engine.state()), windowId)).toBe("2");
  });

  test("preserves all memberships through a paused full inventory loss", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [makeDisplay()] });
    const engine = await Effect.runPromise(
      createEngine({ adapter: fake.adapter, configSource: CONFIG_SOURCE, clock: CLOCK }),
    );
    await Effect.runPromise(engine.start());
    const one = fake.addWindow(makeWindow({ id: "window:one", pid: 7101 }));
    const two = fake.addWindow(makeWindow({ id: "window:two", pid: 7102 }));
    await Effect.runPromise(engine.reconcile());
    await execute(engine, { type: "focusWorkspace", name: "B" });
    await execute(engine, { type: "pause" });
    const writesBeforeLoss = fake.writes().length;

    fake.removeWindow(one);
    fake.removeWindow(two);
    await Effect.runPromise(engine.reconcile());
    const duringLoss = await Effect.runPromise(engine.state());
    expect(workspaceOf(duringLoss, one)).toBe("1");
    expect(workspaceOf(duringLoss, two)).toBe("1");
    expect(fake.writes()).toHaveLength(writesBeforeLoss);

    fake.addWindow(makeWindow({ id: one, pid: 7101 }));
    fake.addWindow(makeWindow({ id: two, pid: 7102 }));
    await Effect.runPromise(engine.reconcile());
    const restored = await Effect.runPromise(engine.state());
    expect(workspaceOf(restored, one)).toBe("1");
    expect(workspaceOf(restored, two)).toBe("1");
    expect(restored.workspaces.find((workspace) => workspace.name === "B")?.members).toEqual([]);
    expect(fake.writes()).toHaveLength(writesBeforeLoss);
  });

  test("restores exact tree position after partial inventory loss without paused writes", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [makeDisplay()] });
    const engine = await Effect.runPromise(
      createEngine({ adapter: fake.adapter, configSource: CONFIG_SOURCE, clock: CLOCK }),
    );
    await Effect.runPromise(engine.start());
    const one = fake.addWindow(makeWindow({ id: "window:tree:one", pid: 7201 }));
    const two = fake.addWindow(makeWindow({ id: "window:tree:two", pid: 7202 }));
    const three = fake.addWindow(makeWindow({ id: "window:tree:three", pid: 7203 }));
    await Effect.runPromise(engine.reconcile());
    const originalMembers = (await Effect.runPromise(engine.state())).workspaces.find(
      (workspace) => workspace.name === "1",
    )?.members;
    expect(originalMembers).toEqual(expect.arrayContaining([one, two, three]));

    await execute(engine, { type: "focusWorkspace", name: "B" });
    await execute(engine, { type: "pause" });
    const writesBeforeLoss = fake.writes().length;
    fake.removeWindow(two);
    await execute(engine, { type: "reconcile" });
    fake.addWindow(makeWindow({ id: two, pid: 7202 }));
    await execute(engine, { type: "reconcile" });

    const restored = await Effect.runPromise(engine.state());
    expect(restored.workspaces.find((workspace) => workspace.name === "1")?.members).toEqual(
      originalMembers,
    );
    expect(restored.workspaces.find((workspace) => workspace.name === "B")?.members).toEqual([]);
    expect(fake.writes()).toHaveLength(writesBeforeLoss);
  });
});

const execute = (
  engine: { execute(command: Command): Effect.Effect<CommandResult, unknown> },
  command: Command,
): Promise<CommandResult> =>
  Effect.runPromise(engine.execute(command) as Effect.Effect<CommandResult>);
