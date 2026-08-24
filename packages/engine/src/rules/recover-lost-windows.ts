import type { Action } from "../actions.ts";
import { PARKING_ACCEPTANCE_PT } from "../constants.ts";
import { clampFrameToBounds } from "../geometry.ts";
import type { Frame } from "../schema.ts";
import type { World } from "../world.ts";
import { displayById, findMembership, plannedTiledFrames } from "./rule.ts";
import type { Rule, RuleContext } from "./rule.ts";

// Rules catalog #11 — a managed window whose frame doesn't sufficiently
// intersect any active work area (and isn't intended-parked) is recovered
// through its assigned workspace layout.

export const recoverLostWindows: Rule = {
  name: "recover-lost-windows",
  applies: (world): boolean => {
    for (const observation of world.windows.values()) {
      if (isLost(world, observation.id)) return true;
    }
    return false;
  },
  run: (world, ctx): Action[] => {
    const actions: Action[] = [];
    for (const observation of world.windows.values()) {
      if (!isLost(world, observation.id)) continue;
      const membership = findMembership(world, observation.id);
      if (membership === null) continue;
      const workspace = membership.workspace;

      if (workspace.visibleOnDisplay === null) {
        // Member of a parked workspace observed on-screen: drift toward its
        // recorded parked intent.
        const intent = workspace.parkedFrames.get(observation.id);
        if (intent !== undefined) {
          actions.push({ kind: "setFrame", windowId: observation.id, frame: intent });
        }
        continue;
      }

      const frames = plannedTiledFrames(world, ctx, workspace);
      const planned = frames?.get(observation.id);
      if (planned !== undefined && !framesMatch(observation.frame, planned)) {
        actions.push({ kind: "setFrame", windowId: observation.id, frame: planned });
        continue;
      }

      if (membership.floating) {
        // Floaters recover by clamping minimally into the nearest work area.
        const display = displayById(world, workspace.visibleOnDisplay);
        if (display !== undefined) {
          const clamped = clampFrameToBounds(observation.frame, display.workArea);
          if (!framesMatch(observation.frame, clamped)) {
            actions.push({ kind: "setFrame", windowId: observation.id, frame: clamped });
          }
        }
      }
    }
    return actions;
  },
};

function isLost(world: World, windowId: string): boolean {
  const observation = world.windows.get(windowId);
  if (observation === undefined) return false;
  if (observation.minimized || observation.hidden) return false;
  // Intended-parked windows are exactly where they should be.
  for (const workspace of world.workspaces.values()) {
    if (workspace.parkedFrames.has(windowId)) return false;
  }
  return !centerInsideAnyWorkArea(world, observation.frame);
}

/** Nearest work area containing the center; null when the window is lost. */
function centerInsideAnyWorkArea(world: World, frame: Frame): boolean {
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  return world.topology.displays.some(
    (d) =>
      cx >= d.workArea.x &&
      cx < d.workArea.x + d.workArea.width &&
      cy >= d.workArea.y &&
      cy < d.workArea.y + d.workArea.height,
  );
}

function framesMatch(a: Frame, b: Frame): boolean {
  return (
    Math.abs(a.x - b.x) <= PARKING_ACCEPTANCE_PT &&
    Math.abs(a.y - b.y) <= PARKING_ACCEPTANCE_PT
  );
}
