import type { StateSnapshot } from "@wm/engine";
import path from "node:path";

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

export function legacySketchybarSnapshot(snapshot: StateSnapshot): LegacySketchybarSnapshot {
  const primary = snapshot.topology.find((display) => display.primary) ?? snapshot.topology[0];
  const windows = new Map(snapshot.windows.map((window) => [window.id, window]));
  return {
    focused_workspace_name: snapshot.focusedWorkspace,
    displays: snapshot.topology.map((display) => ({
      identifiers: { cg_direct_display_id: display.nativeId ?? display.id },
      workspaces: snapshot.workspaces
        .filter((workspace) =>
          (workspace.visibleOnDisplay
            ?? workspace.pinnedDisplayOverride
            ?? workspace.preferredDisplay
            ?? primary?.id) === display.id)
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
