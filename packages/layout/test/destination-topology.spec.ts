import { Effect, Stream } from "effect";
import { describe, expect, test } from "vitest";
import { createEngine } from "../src/engine.ts";
import type { Clock, ConfigSource } from "../src/platform.ts";
import { createFakePlatform, makeDisplay, makeWindow } from "./helpers/fake-platform.ts";

const CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (millis) => Effect.sleep(`${millis >= 500 ? millis : Math.min(millis, 2)} millis`),
};

const CONFIG_SOURCE: ConfigSource = {
  load: () => Effect.succeed({ defaults: {}, workspaces: [] }),
  changes: () => Stream.empty,
};

describe("compound destination topology refresh", () => {
  test("focusWorkspace aborts before mutating a newly displaced uncaptured occupant", async () => {
    const primary = makeDisplay();
    const left = makeDisplay({
      id: "display:sim-left",
      frame: { x: -1512, y: 0, width: 1512, height: 982 },
      workArea: { x: -1512, y: 38, width: 1512, height: 944 },
      primary: false,
    });
    const right = makeDisplay({
      id: "display:sim-right",
      frame: { x: 1512, y: 0, width: 1512, height: 982 },
      workArea: { x: 1512, y: 38, width: 1512, height: 944 },
      primary: false,
    });
    const fake = createFakePlatform({ clock: CLOCK, displays: [primary, left, right] });
    let churnOnInventoryRefresh = false;
    let leftDisconnected = false;
    const adapter = {
      ...fake.adapter,
      getWindows: () =>
        Effect.tap(fake.adapter.getWindows(), () =>
          Effect.sync(() => {
            if (churnOnInventoryRefresh) leftDisconnected = true;
          }),
        ),
      getTopology: () =>
        Effect.map(fake.adapter.getTopology(), (topology) =>
          leftDisconnected
            ? { displays: topology.displays.filter((display) => display.id !== left.id) }
            : topology,
        ),
    };
    const engine = await Effect.runPromise(
      createEngine({ adapter, configSource: CONFIG_SOURCE, clock: CLOCK }),
    );
    await Effect.runPromise(engine.start());

    const primaryOccupant = fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const targetMember = fake.addWindow(makeWindow({ x: -1400, y: 100 }));
    const focusedMember = fake.addWindow(makeWindow({ x: 1600, y: 100 }));
    await Effect.runPromise(engine.execute({ type: "reconcile" }));
    await Effect.runPromise(
      engine.execute({
        type: "moveWindowToWorkspace",
        windowId: targetMember,
        workspace: "target",
      }),
    );
    await Effect.runPromise(
      engine.execute({
        type: "moveWindowToWorkspace",
        windowId: focusedMember,
        workspace: "focused",
      }),
    );
    await Effect.runPromise(
      engine.execute({ type: "moveWorkspaceToDisplay", workspace: "target", displayId: left.id }),
    );
    await Effect.runPromise(
      engine.execute({ type: "moveWorkspaceToDisplay", workspace: "focused", displayId: right.id }),
    );
    await Effect.runPromise(engine.execute({ type: "focusWorkspace", name: "focused" }));

    const beforeFrame = fake.frameOf(primaryOccupant);
    const beforeWrites = fake.writes().length;
    churnOnInventoryRefresh = true;
    const exit = await Effect.runPromiseExit(
      engine.execute({ type: "focusWorkspace", name: "target" }),
    );

    expect(exit._tag).toBe("Failure");
    expect(fake.writes()).toHaveLength(beforeWrites);
    expect(fake.frameOf(primaryOccupant)).toEqual(beforeFrame);
  });

  test("moveWorkspaceToDisplay rejects a disconnected destination for a BSP workspace", async () => {
    await expectInvalidMoveDestination("bsp");
  });

  test("moveWorkspaceToDisplay rejects a disconnected destination for a floating workspace", async () => {
    await expectInvalidMoveDestination("floating");
  });
});

const expectInvalidMoveDestination = async (mode: "bsp" | "floating"): Promise<void> => {
  const primary = makeDisplay();
  const destination = makeDisplay({
    id: "display:sim-destination",
    frame: { x: 1512, y: 0, width: 1512, height: 982 },
    workArea: { x: 1512, y: 38, width: 1512, height: 944 },
    primary: false,
  });
  const fake = createFakePlatform({ clock: CLOCK, displays: [primary, destination] });
  let disconnectOnRefresh = false;
  let destinationDisconnected = false;
  const adapter = {
    ...fake.adapter,
    getWindows: () =>
      Effect.tap(fake.adapter.getWindows(), () =>
        Effect.sync(() => {
          if (disconnectOnRefresh) destinationDisconnected = true;
        }),
      ),
    getTopology: () =>
      Effect.map(fake.adapter.getTopology(), (topology) =>
        destinationDisconnected
          ? {
              displays: topology.displays.filter((display) => display.id !== destination.id),
            }
          : topology,
      ),
  };
  const engine = await Effect.runPromise(
    createEngine({ adapter, configSource: CONFIG_SOURCE, clock: CLOCK }),
  );
  await Effect.runPromise(engine.start());
  const windowId = fake.addWindow(makeWindow({ x: 100, y: 100 }));
  await Effect.runPromise(engine.execute({ type: "reconcile" }));
  if (mode === "floating") {
    await Effect.runPromise(engine.execute({ type: "setWorkspaceMode", workspace: "1", mode }));
  }

  const before = await Effect.runPromise(engine.state());
  const beforeWorkspace = before.workspaces.find((workspace) => workspace.name === "1");
  const beforeFrame = fake.frameOf(windowId);
  const beforeWrites = fake.writes().length;
  disconnectOnRefresh = true;
  const result = await Effect.runPromise(
    Effect.either(
      engine.execute({
        type: "moveWorkspaceToDisplay",
        workspace: "1",
        displayId: destination.id,
      }),
    ),
  );

  expect(result._tag).toBe("Left");
  if (result._tag === "Left") expect(result.left).toMatchObject({ code: "topology_unstable" });
  expect(fake.writes()).toHaveLength(beforeWrites);
  expect(fake.frameOf(windowId)).toEqual(beforeFrame);
  const after = await Effect.runPromise(engine.state());
  expect(after.epoch).toBe(before.epoch);
  expect(after.workspaces.find((workspace) => workspace.name === "1")).toMatchObject({
    visibleOnDisplay: beforeWorkspace?.visibleOnDisplay,
    pinnedDisplayOverride: beforeWorkspace?.pinnedDisplayOverride,
  });
};
