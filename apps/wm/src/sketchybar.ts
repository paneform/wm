import type { StateSnapshot } from "@paneform/layout";
import path from "node:path";

type Display = StateSnapshot["topology"][number];
type Workspace = StateSnapshot["workspaces"][number];

interface LegacyWindow {
  readonly app_name: string;
  readonly exe?: string;
  readonly health: { readonly status: string };
}

export interface LegacySketchybarSnapshot {
  readonly focused_workspace_name: string | null;
  readonly displays: readonly {
    readonly identifiers: { readonly cg_direct_display_id: string };
    readonly workspaces: readonly {
      readonly name: string;
      readonly health: { readonly status: string };
      readonly windows: readonly LegacyWindow[];
    }[];
  }[];
}

const intersectionArea = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const observedArea = (
  workspace: Workspace,
  display: Display,
  windows: ReadonlyMap<string, StateSnapshot["windows"][number]>,
): number => [...workspace.members, ...workspace.floating].reduce((area, id) => {
  const window = windows.get(id);
  return area + (window === undefined ? 0 : intersectionArea(window.frame, display.frame));
}, 0);

function actualDisplay(
  workspace: Workspace,
  displays: readonly Display[],
  windows: ReadonlyMap<string, StateSnapshot["windows"][number]>,
  primary: Display | undefined,
): Display | undefined {
  const visible = displays.find((display) => display.id === workspace.visibleOnDisplay);
  if (visible !== undefined) return visible;

  const observed = displays.reduce<{ display?: Display; area: number }>((best, display) => {
    const area = observedArea(workspace, display, windows);
    return area > best.area ? { display, area } : best;
  }, { area: 0 });
  return observed.display ?? primary;
}

export function legacySketchybarSnapshot(snapshot: StateSnapshot): LegacySketchybarSnapshot {
  const primary = snapshot.topology.find((display) => display.primary) ?? snapshot.topology[0];
  const windows = new Map(snapshot.windows.map((window) => [window.id, window]));
  return {
    focused_workspace_name: snapshot.focusedWorkspace,
    displays: snapshot.topology.map((display) => ({
      identifiers: { cg_direct_display_id: display.nativeId ?? display.id },
      workspaces: snapshot.workspaces
        .filter((workspace) =>
          actualDisplay(workspace, snapshot.topology, windows, primary)?.id === display.id)
        .map((workspace) => ({
          name: workspace.name,
          health: { status: snapshot.health },
          windows: [...workspace.members, ...workspace.floating].flatMap((id) => {
            const window = windows.get(id);
            if (window === undefined) return [];
            const executable = window.executablePath;
            return [{
              app_name: executable === undefined ? window.bundleId ?? "Unknown" : path.basename(executable),
              ...(executable === undefined ? {} : { exe: executable }),
              health: { status: snapshot.health },
            }];
          }),
        })),
    })),
  };
}
