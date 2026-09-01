import { contentRect } from "./layout/bsp.js";
import type { DisplayObservation, Frame } from "./schema.js";
import type { World, WorkspaceState } from "./world.js";

type Margins = {
  top?: number | undefined;
  right?: number | undefined;
  bottom?: number | undefined;
  left?: number | undefined;
};

const overlaps = (a: Frame, b: Frame): boolean =>
  Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
  Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);

/** Use logical workspace geometry when a physical target frame is parked. */
export function insertionTargetFrame(
  world: World,
  workspace: WorkspaceState,
  targetFrame: Frame | undefined,
  margins: Margins,
): Frame | undefined {
  const display = insertionDisplay(world, workspace, targetFrame);
  const targetIsVisible =
    workspace.visibleOnDisplay !== null &&
    targetFrame !== undefined &&
    world.topology.displays.some((display) => overlaps(targetFrame, display.workArea));
  if (targetIsVisible) return targetFrame;

  return display === undefined ? targetFrame : contentRect(display, margins);
}

/** Display whose logical content rect governs insertion into this workspace. */
export function insertionDisplay(
  world: World,
  workspace: WorkspaceState,
  targetFrame: Frame | undefined,
): DisplayObservation | undefined {
  if (workspace.visibleOnDisplay !== null && targetFrame !== undefined) {
    const physical = world.topology.displays.find((display) =>
      overlaps(targetFrame, display.workArea),
    );
    if (physical !== undefined) return physical;
  }
  const displayIds = [
    workspace.visibleOnDisplay,
    workspace.pinnedDisplayOverride,
    workspace.preferredDisplay,
  ];
  return (
    displayIds
      .filter((id): id is string => id !== null)
      .map((id) => world.topology.displays.find((candidate) => candidate.id === id))
      .find((candidate) => candidate !== undefined) ??
    world.topology.displays.find((candidate) => candidate.primary) ??
    world.topology.displays[0]
  );
}
