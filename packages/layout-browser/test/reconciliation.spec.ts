import { createEngine, type Clock, type ConfigSource } from "@paneform/layout";
import { Effect, Stream } from "effect";
import { expect, test } from "vitest";
import { createWebPlatformSim } from "../src/sim/web-platform.ts";

const clock: Clock = { now: () => Date.now(), sleep: () => Effect.void };
const configSource: ConfigSource = {
  load: () => Effect.succeed({ defaults: { gap: 0 }, workspaces: [] }),
  changes: () => Stream.empty,
};

test("the simulator window-removed event publishes observed surviving frames", async () => {
  const sim = createWebPlatformSim({ seed: 4830 });
  const removed = sim.addWindow({ width: 600, height: 400 });
  const survivor = sim.addWindow({ width: 600, height: 400 });
  const engine = await Effect.runPromise(
    createEngine({ adapter: sim.adapter, configSource, clock }),
  );
  await Effect.runPromise(engine.start());
  const committed = Effect.runPromise(
    engine.events().pipe(
      Stream.filter((event) => event.topic === "reconciliation"),
      Stream.take(1),
      Stream.runDrain,
    ),
  );

  sim.removeWindow(removed);
  await committed;

  const [display] = (await Effect.runPromise(sim.adapter.getTopology())).displays;
  expect((await Effect.runPromise(engine.state())).windows).toEqual([
    expect.objectContaining({ id: survivor, frame: display!.workArea }),
  ]);
  await Effect.runPromise(engine.stop());
});
