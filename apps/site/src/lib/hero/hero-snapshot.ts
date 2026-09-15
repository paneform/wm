import type { HeroCommittedSnapshot, HeroSimulation } from "./create-hero-simulation.js";
import { HERO_APPS, HERO_WORKSPACES, type HeroAppTitle } from "./hero-model.js";

export interface HeroFallbackSnapshot {
  readonly displays: readonly HeroFallbackDisplay[];
  readonly workspaces: readonly HeroFallbackWorkspace[];
  readonly windows: readonly HeroFallbackWindow[];
  readonly focusedWorkspace: string | null;
  readonly focusedApp: HeroAppTitle | null;
}

export interface HeroFallbackDisplay {
  readonly id: string;
  readonly frame: HeroFallbackFrame;
  readonly workArea: HeroFallbackFrame;
  readonly scale: number;
  readonly primary: boolean;
}

export interface HeroFallbackWorkspace {
  readonly name: string;
  readonly mode: "bsp" | "floating";
  readonly apps: readonly HeroAppTitle[];
  readonly visibleOnDisplay: string | null;
}

export interface HeroFallbackWindow {
  readonly app: HeroAppTitle;
  readonly workspace: string | null;
  readonly frame: HeroFallbackFrame;
  readonly managed: boolean;
  readonly floating: boolean;
  readonly parked: boolean;
}

export interface HeroFallbackFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const requireSuccess = async (
  operation: ReturnType<HeroSimulation["activateApp"]>,
): Promise<void> => {
  const result = await operation;
  if (!result.ok) throw result.error;
};

export async function fastForwardHeroSimulation(
  simulation: HeroSimulation,
): Promise<HeroCommittedSnapshot> {
  await requireSuccess(simulation.activateApp("Terminal"));
  await requireSuccess(simulation.activateApp("Browser"));
  await requireSuccess(simulation.activateApp("Text Editor"));
  await requireSuccess(simulation.activateApp("Paneform"));
  await requireSuccess(simulation.moveDirection("right"));
  await requireSuccess(simulation.moveDirection("left"));
  await requireSuccess(simulation.focusDirection("up"));
  await requireSuccess(simulation.moveFocusedWindowToWorkspace("T"));
  await requireSuccess(simulation.activateApp("Waitlist"));
  await requireSuccess(simulation.moveFocusedWindowToWorkspace("W"));
  await requireSuccess(simulation.activateApp("Settings"));
  return simulation.snapshot();
}

export function normalizeHeroSnapshot(snapshot: HeroCommittedSnapshot): HeroFallbackSnapshot {
  const appById = new Map(
    HERO_APPS.flatMap(({ title }) =>
      snapshot.apps[title] === null ? [] : [[snapshot.apps[title], title]],
    ),
  );
  const appOrder = new Map(HERO_APPS.map(({ title }, index) => [title, index]));
  const workspaceOrder = new Map<string, number>(
    HERO_WORKSPACES.map((workspace, index) => [workspace, index]),
  );
  const toApp = (id: string): HeroAppTitle => {
    const app = appById.get(id);
    if (app === undefined) throw new Error(`Snapshot contains unknown hero window ${id}`);
    return app;
  };
  const sortApps = (apps: HeroAppTitle[]): HeroAppTitle[] =>
    apps.sort((left, right) => (appOrder.get(left) ?? 0) - (appOrder.get(right) ?? 0));

  return {
    displays: snapshot.state.topology
      .map(({ id, frame, workArea, scale, primary }) => ({
        id,
        frame,
        workArea,
        scale,
        primary,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    workspaces: snapshot.state.workspaces
      .map(({ name, mode, members, visibleOnDisplay }) => ({
        name,
        mode,
        apps: sortApps(members.map(toApp)),
        visibleOnDisplay,
      }))
      .sort(
        (left, right) =>
          (workspaceOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER) -
          (workspaceOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER),
      ),
    windows: snapshot.state.windows
      .map(({ id, workspace, frame, managed, floating, parked }) => ({
        app: toApp(id),
        workspace,
        frame,
        managed,
        floating,
        parked,
      }))
      .sort((left, right) => (appOrder.get(left.app) ?? 0) - (appOrder.get(right.app) ?? 0)),
    focusedWorkspace: snapshot.state.focusedWorkspace,
    focusedApp: snapshot.state.focusedWindow == null ? null : toApp(snapshot.state.focusedWindow),
  };
}
