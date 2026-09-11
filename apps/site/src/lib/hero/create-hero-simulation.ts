import { createEngine, type Command, type Engine, type StateSnapshot } from "@paneform/layout";
import { createWebPlatformSim, type WebPlatformSim } from "@paneform/layout-browser";
import { Effect, Stream } from "effect";
import { desktopDisplayPreset, laptopDisplayPreset } from "../desktop/display-presets.js";
import {
  getHeroApp,
  HERO_APPS,
  HERO_SEED,
  HERO_WORKSPACES,
  MACBOOK_DISPLAY_ID,
  STUDIO_DISPLAY_ID,
  type HeroApp,
  type HeroAppTitle,
  type HeroWorkspace,
} from "./hero-model.js";

type AddWindowSpec = Parameters<WebPlatformSim["addWindow"]>[0];
type DisplaySpec = Parameters<WebPlatformSim["connectDisplay"]>[0];

export {
  HERO_APPS,
  HERO_SEED,
  HERO_WORKSPACES,
  MACBOOK_DISPLAY_ID,
  STUDIO_DISPLAY_ID,
  type HeroApp,
  type HeroAppTitle,
  type HeroWorkspace,
} from "./hero-model.js";

export const macBookDisplay: DisplaySpec = {
  ...laptopDisplayPreset,
  id: MACBOOK_DISPLAY_ID,
  primary: true,
};

export const studioDisplay: DisplaySpec = {
  ...desktopDisplayPreset,
  id: STUDIO_DISPLAY_ID,
  frame: { ...desktopDisplayPreset.frame, x: -2560 },
  workArea: { ...desktopDisplayPreset.workArea, x: -2560 },
  primary: false,
};

export interface HeroCommittedSnapshot {
  readonly state: StateSnapshot;
  readonly apps: Readonly<Record<HeroAppTitle, string | null>>;
  readonly wmRunning: boolean;
  readonly valid: boolean;
}

export type HeroWindowFrame = StateSnapshot["windows"][number]["frame"];

export type HeroActionResult =
  | { readonly ok: true; readonly snapshot: HeroCommittedSnapshot }
  | {
      readonly ok: false;
      readonly snapshot: HeroCommittedSnapshot;
      readonly error: Error;
    };

export interface HeroSimulation {
  snapshot(): Promise<HeroCommittedSnapshot>;
  activateApp(app: HeroAppTitle): Promise<HeroActionResult>;
  closeWindow(app: HeroAppTitle): Promise<HeroActionResult>;
  focusWindow(app: HeroAppTitle): Promise<HeroActionResult>;
  moveWindow(app: HeroAppTitle, point: { x: number; y: number }): Promise<HeroActionResult>;
  resizeWindow(app: HeroAppTitle, frame: HeroWindowFrame): Promise<HeroActionResult>;
  focusWorkspace(workspace: HeroWorkspace): Promise<HeroActionResult>;
  moveFocusedWindowToWorkspace(workspace: HeroWorkspace): Promise<HeroActionResult>;
  moveFocusedWorkspaceToNextDisplay(): Promise<HeroActionResult>;
  connectStudioDisplay(): Promise<HeroActionResult>;
  moveDirection(direction: "left" | "down" | "up" | "right"): Promise<HeroActionResult>;
  focusDirection(direction: "left" | "down" | "up" | "right"): Promise<HeroActionResult>;
  dispose(): Promise<void>;
}

const config = {
  defaults: { mode: "bsp", gap: 16 },
  workspaces: HERO_WORKSPACES.map((name) => ({
    name,
    mode: "bsp" as const,
    gap: 16,
  })),
};

const browserClock = {
  now: () => performance.now(),
  sleep: (millis: number) =>
    Effect.promise(() => new Promise((resolve) => setTimeout(resolve, millis))),
};

const appSlug = (app: HeroApp): string => app.title.toLowerCase().replaceAll(" ", "-");

interface AppConstraints {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

const appConstraints = (app: HeroApp) => {
  const constraints: AppConstraints = {};
  if (app.minWidth != null) constraints.minWidth = app.minWidth;
  if (app.maxWidth != null) constraints.maxWidth = app.maxWidth;
  if (app.minHeight != null) constraints.minHeight = app.minHeight;
  if (app.maxHeight != null) constraints.maxHeight = app.maxHeight;
  return Object.keys(constraints).length === 0 ? undefined : constraints;
};

const createRandomFrame = () => {
  let state = HERO_SEED;
  let index = 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  return () => {
    const width = Math.round(680 + next() * 180);
    const height = Math.round(440 + next() * 160);
    const column = [0.08, 0.28, 0.9][index % 3] ?? 0.5;
    const row = [0.2, 0.58, 0.08][index % 3] ?? 0.32;
    index += 1;
    const availableWidth = macBookDisplay.workArea.width - width - 72;
    const availableHeight = macBookDisplay.workArea.height - height - 72;
    return {
      x: Math.round(macBookDisplay.workArea.x + 36 + availableWidth * column + (next() - 0.5) * 24),
      y: Math.round(macBookDisplay.workArea.y + 36 + availableHeight * row + (next() - 0.5) * 18),
      width,
      height,
    };
  };
};

const appWindow = (
  app: HeroApp,
  frame: ReturnType<ReturnType<typeof createRandomFrame>>,
): AddWindowSpec => {
  const spec: AddWindowSpec = {
    ref: appSlug(app),
    title: app.title,
    bundleId: app.bundleId,
    displayId: MACBOOK_DISPLAY_ID,
    ...frame,
  };
  const constraints = appConstraints(app);
  if (constraints !== undefined) spec.personality = { kind: "minMaxClamp", constraints };
  return spec;
};

export async function createHeroSimulation(): Promise<HeroSimulation> {
  const sim = createWebPlatformSim({
    seed: HERO_SEED,
    displays: [macBookDisplay],
  });
  let engine: Engine | null = null;
  const makeEngine = () =>
    Effect.runPromise(
      createEngine({
        adapter: sim.adapter,
        clock: browserClock,
        configSource: {
          load: () => Effect.succeed(config),
          changes: () => Stream.empty,
        },
      }),
    );
  const appIds = new Map<HeroAppTitle, string>();
  let valid = true;
  let disposed = false;
  let wmRunning = false;
  const randomFrame = createRandomFrame();

  const readApps = (): Record<HeroAppTitle, string | null> => {
    const entries = HERO_APPS.map(({ title }) => [title, appIds.get(title) ?? null] as const);
    // SAFETY: HERO_APPS is the source of the complete HeroAppTitle union.
    return Object.fromEntries(entries) as Record<HeroAppTitle, string | null>;
  };

  const read = async (): Promise<HeroCommittedSnapshot> => {
    if (wmRunning && engine)
      return { state: await Effect.runPromise(engine.state()), apps: readApps(), wmRunning, valid };
    const [topology, windows] = await Promise.all([
      Effect.runPromise(sim.adapter.getTopology()),
      Effect.runPromise(sim.adapter.getWindows()),
    ]);
    const ids = windows.map(({ id }) => id);
    return {
      state: {
        epoch: 0,
        paused: false,
        health: "healthy",
        focusedWorkspace: "1",
        focusedWindow: windows.find(({ focused }) => focused)?.id ?? null,
        topology: topology.displays,
        windows: windows.map((window) => ({
          ...window,
          classification: "unmanaged",
          managed: false,
          workspace: "1",
          floating: true,
          parked: false,
        })),
        workspaces: HERO_WORKSPACES.map((name) => ({
          name,
          mode: "bsp" as const,
          members: name === "1" ? ids : [],
          floating: [],
          tree:
            name === "1" && ids[0]
              ? { kind: "leaf" as const, windowId: ids[0] }
              : { kind: "leaf" as const, windowId: "" },
          visibleOnDisplay: name === "1" ? MACBOOK_DISPLAY_ID : null,
          preferredDisplay: name === "1" ? MACBOOK_DISPLAY_ID : null,
          pinnedDisplayOverride: null,
        })),
        pendingTransactions: [],
      },
      apps: readApps(),
      wmRunning,
      valid,
    };
  };

  const execute = async (command: Command): Promise<StateSnapshot> => {
    if (!engine) throw new Error("Paneform is not running");
    await Effect.runPromise(engine.execute(command));
    return Effect.runPromise(engine.state());
  };

  const result = async (operation: () => Promise<void>): Promise<HeroActionResult> => {
    if (!valid || disposed)
      return {
        ok: false,
        snapshot: await read(),
        error: new Error("Hero simulation is unavailable"),
      };
    try {
      await operation();
      return { ok: true, snapshot: await read() };
    } catch (cause) {
      return {
        ok: false,
        snapshot: await read(),
        error: cause instanceof Error ? cause : new Error(String(cause)),
      };
    }
  };

  const reconcile = async (): Promise<StateSnapshot> => {
    if (!engine) throw new Error("Paneform is not running");
    await Effect.runPromise(engine.reconcile());
    return Effect.runPromise(engine.state());
  };

  const removalOutcome = (id: string): Promise<void> => {
    if (!engine) throw new Error("Paneform is not running");
    return Effect.runPromise(
      engine.events().pipe(
        Stream.filter((event) => {
          if (event.topic === "diagnostic" && event.payload.code === "engine_stopped") return true;
          const removed = event.payload.removedWindowIds;
          return (
            (event.topic === "reconciliation" ||
              (event.topic === "diagnostic" &&
                (event.payload.code === "reconciliation_failed" ||
                  event.payload.code === "reconciliation_nonconvergent"))) &&
            Array.isArray(removed) &&
            removed.includes(id)
          );
        }),
        Stream.take(1),
        Stream.runHead,
        Effect.flatMap((outcome) => {
          if (outcome._tag === "None" || outcome.value.topic !== "reconciliation") {
            return Effect.fail(new Error("Window removal did not settle"));
          }
          return Effect.void;
        }),
      ),
    );
  };

  const compensateWindow = async (id: string): Promise<void> => {
    const committed = removalOutcome(id);
    sim.removeWindow(id);
    await committed;
    const state = await Effect.runPromise(engine!.state());
    if (state.windows.some((window) => window.id === id))
      throw new Error("Window compensation did not commit");
  };

  const addApp = async (title: HeroAppTitle): Promise<string> => {
    const app = getHeroApp(title);
    const id = sim.addWindow(appWindow(app, randomFrame()));
    sim.focusWindowExternal(id);
    if (!wmRunning) {
      appIds.set(title, id);
      return id;
    }
    try {
      let state = await reconcile();
      if (appConstraints(app) !== undefined) {
        state = await reconcile();
      }
      if (!state.windows.some((window) => window.id === id && window.managed)) {
        throw new Error(`${title} was not committed as a managed window`);
      }
      appIds.set(title, id);
      return id;
    } catch (cause) {
      try {
        await compensateWindow(id);
      } catch {
        valid = false;
        await Effect.runPromise(engine?.stop() ?? Effect.void).catch(() => undefined);
      }
      throw cause;
    }
  };

  const focusApp = async (
    title: HeroAppTitle,
    id: string,
    expectedWorkspace?: HeroWorkspace,
  ): Promise<void> => {
    sim.focusWindowExternal(id);
    const state = await reconcile();
    const window = state.windows.find((item) => item.id === id);
    if (
      window?.workspace == null ||
      (expectedWorkspace !== undefined && window.workspace !== expectedWorkspace) ||
      state.focusedWindow !== id
    ) {
      throw new Error(`${title} activation postcondition failed`);
    }
  };

  const visibleMacBookWorkspace = async (): Promise<HeroWorkspace> => {
    const state = await read();
    const workspaceName = state.state.workspaces.find(
      (item) => item.visibleOnDisplay === MACBOOK_DISPLAY_ID,
    )?.name;
    const workspace = HERO_WORKSPACES.find((candidate) => candidate === workspaceName);
    if (workspace === undefined) throw new Error("MacBook has no visible hero workspace");
    return workspace;
  };

  return {
    snapshot: read,
    activateApp: (app) =>
      result(async () => {
        if (app === "Paneform") {
          if (wmRunning) return;
          engine = await makeEngine();
          wmRunning = true;
          await Effect.runPromise(engine.start());
          return;
        }
        const existing = appIds.get(app);
        if (existing !== undefined) {
          if (!wmRunning) {
            sim.focusWindowExternal(existing);
            return;
          }
          await focusApp(app, existing);
          return;
        }

        if (!wmRunning) {
          await addApp(app);
          return;
        }

        const workspace = await visibleMacBookWorkspace();
        await execute({ type: "focusWorkspace", name: workspace });
        const id = await addApp(app);
        try {
          await focusApp(app, id, workspace);
        } catch (cause) {
          appIds.delete(app);
          try {
            await compensateWindow(id);
          } catch {
            valid = false;
            await Effect.runPromise(engine?.stop() ?? Effect.void).catch(() => undefined);
          }
          throw cause;
        }
      }),
    closeWindow: (app) =>
      result(async () => {
        const id = appIds.get(app);
        if (id === undefined) throw new Error(`${app} is not open`);
        if (wmRunning) await compensateWindow(id);
        else sim.removeWindow(id);
        appIds.delete(app);
      }),
    focusWindow: (app) =>
      result(async () => {
        const id = appIds.get(app);
        if (id === undefined) throw new Error(`${app} is not open`);
        if (!wmRunning) {
          sim.focusWindowExternal(id);
          return;
        }
        const state = await execute({ type: "focusWindow", windowId: id });
        if (state.focusedWindow !== id) throw new Error(`${app} focus did not commit`);
      }),
    moveWindow: (app, point) =>
      result(async () => {
        const id = appIds.get(app);
        if (id === undefined) throw new Error(`${app} is not open`);
        sim.nudgeWindow(id, point);
        if (!wmRunning) {
          return;
        }
        const state = await reconcile();
        const window = state.windows.find((item) => item.id === id);
        if (!window?.managed || window.floating) {
          throw new Error(`${app} drag did not commit`);
        }
      }),
    resizeWindow: (app, frame) =>
      result(async () => {
        const id = appIds.get(app);
        if (id === undefined) throw new Error(`${app} is not open`);
        sim.nudgeWindow(id, frame);
        if (!wmRunning) {
          return;
        }
        const state = await reconcile();
        const window = state.windows.find((item) => item.id === id);
        if (!window?.managed || window.floating) {
          throw new Error(`${app} resize did not commit`);
        }
      }),
    focusWorkspace: (workspace) =>
      result(async () => {
        const state = await execute({
          type: "focusWorkspace",
          name: workspace,
        });
        if (state.focusedWorkspace !== workspace)
          throw new Error(`Workspace ${workspace} focus did not commit`);
      }),
    moveFocusedWindowToWorkspace: (workspace) =>
      result(async () => {
        const focused = (await read()).state.focusedWindow;
        if (focused == null) throw new Error("No focused window");
        const state = await execute({
          type: "moveFocusedWindowToWorkspace",
          workspace,
        });
        if (
          state.focusedWorkspace !== workspace ||
          state.windows.find(({ id }) => id === focused)?.workspace !== workspace
        ) {
          throw new Error(`Focused window move to ${workspace} did not commit`);
        }
      }),
    moveFocusedWorkspaceToNextDisplay: () =>
      result(async () => {
        const before = await read();
        const workspace = before.state.focusedWorkspace;
        if (workspace == null) throw new Error("No focused workspace");
        const previousDisplay = before.state.workspaces.find(
          ({ name }) => name === workspace,
        )?.visibleOnDisplay;
        const state = await execute({
          type: "moveFocusedWorkspaceToNextDisplay",
        });
        const nextDisplay = state.workspaces.find(
          ({ name }) => name === workspace,
        )?.visibleOnDisplay;
        if (nextDisplay == null || nextDisplay === previousDisplay)
          throw new Error("Workspace display move did not commit");
      }),
    connectStudioDisplay: () =>
      result(async () => {
        sim.connectDisplay(studioDisplay);
        try {
          const state = await reconcile();
          if (!state.topology.some(({ id }) => id === STUDIO_DISPLAY_ID))
            throw new Error("Studio Display did not reconcile");
        } catch (cause) {
          sim.disconnectDisplay(STUDIO_DISPLAY_ID);
          try {
            const compensated = await reconcile();
            if (compensated.topology.some(({ id }) => id === STUDIO_DISPLAY_ID))
              throw new Error("Display compensation did not commit");
          } catch {
            valid = false;
            await Effect.runPromise(engine?.stop() ?? Effect.void).catch(() => undefined);
          }
          throw cause;
        }
      }),
    moveDirection: (direction) =>
      result(async () => {
        await execute({ type: "moveDirection", direction });
      }),
    focusDirection: (direction) =>
      result(async () => {
        await execute({ type: "focusDirection", direction });
      }),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (!engine) return;
      await Effect.runPromise(engine.stop()).then(
        () => undefined,
        () => undefined,
      );
    },
  };
}

export type HeroEngineBoundary = Pick<Engine, "execute" | "state" | "reconcile">;
export type HeroSimulatorBoundary = Pick<
  WebPlatformSim,
  "addWindow" | "removeWindow" | "nudgeWindow" | "connectDisplay" | "disconnectDisplay"
>;
