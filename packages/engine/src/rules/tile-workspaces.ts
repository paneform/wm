import type { Action } from "../actions.ts";
import { DEFAULT_TOLERANCE } from "../constants.ts";
import { withinTolerance } from "../geometry.ts";
import type { Frame } from "../schema.ts";
import type { World } from "../world.ts";
import { plannedTiledFrames } from "./rule.ts";
import type { Rule, RuleContext } from "./rule.ts";

// Rules catalog #7 — for each visible BSP workspace with members: compute
// constraint-aware BSP frames (see layout math) and emit SetFrame per member
// whose observed frame disagrees. Members floated by rule 8 leave the tree
// before the next pass, so they are excluded naturally.

export const tileWorkspaces: Rule = {
  name: "tile-workspaces",
  applies: (world: World): boolean => {
    for (const workspace of world.workspaces.values()) {
      if (workspace.visibleOnDisplay !== null && workspace.mode === "bsp") return true;
    }
    return false;
  },
  run: (world: World, ctx: RuleContext): Action[] => {
    const actions: Action[] = [];
    for (const workspace of world.workspaces.values()) {
      if (workspace.visibleOnDisplay === null || workspace.mode !== "bsp") continue;
      const frames = plannedTiledFrames(world, ctx, workspace);
      if (frames === null) continue;
      for (const [windowId, frame] of frames) {
        const observation = world.windows.get(windowId);
        if (observation === undefined) continue;
        // Hidden/minimized members keep their slot but receive no geometry.
        if (observation.minimized || observation.hidden) continue;
        if (!withinTolerance(observation.frame, frame as Frame, DEFAULT_TOLERANCE)) {
          actions.push({ kind: "setFrame", windowId, frame });
        }
      }
    }
    return actions;
  },
};
