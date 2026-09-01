import { Effect, Stream } from "effect";
import { createEngine } from "@paneform/layout";
import type { Clock, Command, ConfigSource, Engine, WindowId } from "@paneform/layout";
import { mountLayoutRenderer, type LayoutRenderer } from "./host.js";
import { createWebPlatformSim, type WebPlatformSim } from "./sim/web-platform.js";

const activeSimulators = new WeakMap<HTMLElement, LayoutSimulator>();
const simulatorReservations = new WeakMap<HTMLElement, symbol>();

const PLAYGROUND_CONFIG = {
  defaults: { gap: 8 },
  workspaces: [
    { name: "1", mode: "bsp" as const },
    { name: "2", mode: "bsp" as const },
  ],
};

const inlineConfigSource: ConfigSource = {
  load: () => Effect.succeed(PLAYGROUND_CONFIG),
  changes: () => Stream.never,
};

const makeRendererClock = (): Clock => {
  let virtualNow = Date.now();
  return {
    now: () => Date.now(),
    sleep: (millis: number) =>
      Effect.sync(() => {
        virtualNow += millis;
      }),
  };
};

function seedWorld(sim: WebPlatformSim): readonly WindowId[] {
  const normal: WindowId[] = [];
  normal.push(
    sim.addWindow({ title: "Editor", bundleId: "com.sim.editor", width: 900, height: 600 }),
  );
  normal.push(
    sim.addWindow({ title: "Terminal", bundleId: "com.sim.term", width: 700, height: 460 }),
  );
  sim.addWindow({ title: "Palette", bundleId: "com.sim.editor", width: 300, height: 220 });
  return normal;
}

const runQuietly = async (engine: Engine, command: Command): Promise<void> => {
  await Effect.runPromise(Effect.either(engine.execute(command))).catch(() => {});
};

export interface LayoutSimulator extends Omit<LayoutRenderer, "stop"> {
  sim: WebPlatformSim;
  engine: Engine;
  stop(): Promise<void>;
}

export interface LayoutSimulatorOptions {
  seed?: number;
}

export async function createLayoutSimulator(
  container: HTMLElement,
  options: LayoutSimulatorOptions = {},
): Promise<LayoutSimulator> {
  const reservation = Symbol("layout-simulator");
  simulatorReservations.set(container, reservation);
  await activeSimulators.get(container)?.stop();
  if (simulatorReservations.get(container) !== reservation) {
    throw new Error("layout simulator startup superseded");
  }
  const sim = createWebPlatformSim({ seed: options.seed ?? 1337 });
  const seedable = seedWorld(sim);
  let engine: Engine | null = null;
  let renderer: LayoutRenderer | null = null;
  const ensureCurrent = (): void => {
    if (simulatorReservations.get(container) !== reservation) {
      throw new Error("layout simulator startup superseded");
    }
  };
  try {
    const runningEngine = await Effect.runPromise(
      createEngine({
        adapter: sim.adapter,
        configSource: inlineConfigSource,
        clock: makeRendererClock(),
      }),
    );
    engine = runningEngine;
    await Effect.runPromise(runningEngine.start());
    ensureCurrent();

    for (const id of seedable) {
      await runQuietly(runningEngine, {
        type: "moveWindowToWorkspace",
        windowId: id,
        workspace: "1",
      });
    }
    await runQuietly(runningEngine, { type: "focusWorkspace", name: "1" });
    await Effect.runPromise(Effect.either(runningEngine.reconcile())).catch(() => {});
    ensureCurrent();

    const mountedRenderer = mountLayoutRenderer(container, runningEngine, {
      sim,
      enableCommands: true,
    });
    renderer = mountedRenderer;
    await mountedRenderer.refresh();
    ensureCurrent();
    let stopped = false;
    const simulator: LayoutSimulator = {
      sim,
      engine: runningEngine,
      refresh: mountedRenderer.refresh,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        mountedRenderer.stop();
        await Effect.runPromise(runningEngine.stop())
          .then(() => undefined)
          .catch(() => {});
        if (activeSimulators.get(container) === simulator) activeSimulators.delete(container);
        if (simulatorReservations.get(container) === reservation) {
          simulatorReservations.delete(container);
        }
      },
    };
    activeSimulators.set(container, simulator);
    return simulator;
  } catch (error) {
    renderer?.stop();
    if (engine !== null) await Effect.runPromise(engine.stop()).catch(() => {});
    if (simulatorReservations.get(container) === reservation) {
      simulatorReservations.delete(container);
    }
    throw error;
  }
}
